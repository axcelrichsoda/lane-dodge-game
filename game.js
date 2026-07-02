(() => {
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');

  const scoreEl = document.getElementById('score');
  const comboEl = document.getElementById('combo');
  const hitsEl = document.getElementById('hits');
  const bestEl = document.getElementById('best');
  const startScreen = document.getElementById('start-screen');
  const gameoverScreen = document.getElementById('gameover-screen');
  const finalScoreEl = document.getElementById('final-score');
  const bestScoreEl = document.getElementById('best-score');
  const startBtn = document.getElementById('start-btn');
  const restartBtn = document.getElementById('restart-btn');
  const hitFlashEl = document.getElementById('hit-flash');
  const rebindButtons = Array.from(document.querySelectorAll('.rebind-btn'));

  const BEST_KEY = 'dodgeDominoBest';
  const KEYS_STORAGE = 'dodgeDominoKeys';
  const MAX_HITS = 3;

  const CONFIG = {
    baseSpeed: 0.55,
    accelPerSec: 0.012,
    accelPerScore: 0.006,       // extra speed per point scored (skilled players ramp faster)
    maxSpeed: 2.2,
    spawnIntervalStart: [1.1, 1.6],
    spawnIntervalFloor: [0.45, 0.7],
    laneSwitchLerp: 14,
    horizonRatio: 0.30,
    roadHalfWidthRatio: 0.26,   // total 4-lane road half-width, fraction of canvas width
    laneCount: 4,
    ballRadiusRatio: 0.018,     // ball radius, fraction of canvas width

    nearMissWindow: 0.35,       // switched lane within this many seconds -> near-miss bonus
    comboTierSize: 10,          // every N combo, multiplier +1
    comboMultCap: 10,           // multiplier caps at x10
    regenEvery: 15,             // recover 1 HIT every this many score points

    patternIntervalMin: 5,      // seconds between forced dual/streak obstacle patterns
    patternIntervalStart: 11,
    streakGap: 0.42,            // seconds between obstacles within a "streak" pattern

    hitShakeDuration: 0.25,
    hitSlowMoDuration: 0.2,
    hitSlowMoScale: 0.25,
    dodgeFxDuration: 0.35,
  };

  // key groups: each group owns 2 adjacent lanes (absolute lane index 0-3).
  // "home" = resting lane, "held" = lane moved to while the key is held down.
  // actual key bindings live in `keyBindings` (rebindable, persisted separately).
  const GROUPS = [
    { lanes: [0, 1], color: 'blue' },  // lanes 1&2
    { lanes: [3, 2], color: 'gold' },  // lanes 4&3, home=lane4
  ];
  const DEFAULT_KEYS = ['KeyC', 'KeyB'];

  function loadKeyBindings() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEYS_STORAGE));
      if (Array.isArray(saved) && saved.length === GROUPS.length) return saved;
    } catch (e) { /* ignore malformed storage */ }
    return DEFAULT_KEYS.slice();
  }
  function saveKeyBindings() {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(keyBindings));
  }

  let keyBindings = loadKeyBindings();
  let rebindingIndex = null;

  function codeToLabel(code) {
    if (!code) return '?';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const special = {
      Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
      ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
      AltLeft: 'Alt', AltRight: 'Alt', Comma: ',', Period: '.', Semicolon: ';',
    };
    return special[code] || code;
  }

  function refreshRebindLabels() {
    rebindButtons.forEach((btn) => {
      const i = Number(btn.dataset.group);
      if (i !== rebindingIndex) btn.textContent = codeToLabel(keyBindings[i]);
    });
  }
  refreshRebindLabels();

  rebindButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.group);
      rebindingIndex = i;
      refreshRebindLabels();
      btn.textContent = '...';
      btn.classList.add('listening');
    });
  });

  window.addEventListener('keydown', (e) => {
    if (rebindingIndex === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const i = rebindingIndex;
    rebindingIndex = null;
    rebindButtons[i].classList.remove('listening');
    if (e.code !== 'Enter' && e.code !== 'Escape' && e.code !== keyBindings[1 - i]) {
      keyBindings[i] = e.code;
      saveKeyBindings();
    }
    refreshRebindLabels();
  }, true);

  let width = 0, height = 0;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function makeTrack(group) {
    return {
      lanes: group.lanes,   // [homeLaneAbs, heldLaneAbs]
      posState: 0,          // 0 = at home lane, 1 = at held lane
      ballPos: 0,            // interpolated 0..1 between home/held for rendering
      obstacles: [],
      spawnTimer: 0.6 + Math.random() * 0.5,
      color: group.color,
      lastSwitchTime: -Infinity,
    };
  }

  let tracks = [];
  let state = 'idle'; // idle | playing | gameover
  let score = 0;
  let hits = 0;
  let combo = 0;
  let nextRegenAt = CONFIG.regenEvery;
  let elapsed = 0;
  let lastTime = 0;
  let patternTimer = 4;
  let pendingSpawns = []; // { trackIndex, localLane, delay }
  let dodgeFx = [];
  let shakeTimer = 0;
  let slowMoTimer = 0;

  function getBest() {
    return Number(localStorage.getItem(BEST_KEY) || 0);
  }
  function setBest(v) {
    localStorage.setItem(BEST_KEY, String(v));
  }

  bestEl.textContent = `BEST: ${getBest()}`;

  function resetGame() {
    tracks = GROUPS.map(g => makeTrack(g));
    score = 0;
    hits = 0;
    combo = 0;
    nextRegenAt = CONFIG.regenEvery;
    elapsed = 0;
    patternTimer = 4 + Math.random() * 3;
    pendingSpawns = [];
    dodgeFx = [];
    shakeTimer = 0;
    slowMoTimer = 0;
    scoreEl.textContent = 'SCORE: 0';
    comboEl.textContent = '';
    hitsEl.textContent = `HIT: 0/${MAX_HITS}`;
  }

  function startGame() {
    resetGame();
    state = 'playing';
    startScreen.classList.add('hidden');
    gameoverScreen.classList.add('hidden');
    lastTime = performance.now();
    requestAnimationFrame(loop);
  }

  function gameOver() {
    state = 'gameover';
    const best = getBest();
    if (score > best) {
      setBest(score);
    }
    finalScoreEl.textContent = `SCORE: ${score}`;
    bestScoreEl.textContent = `BEST: ${getBest()}`;
    bestEl.textContent = `BEST: ${getBest()}`;
    gameoverScreen.classList.remove('hidden');
  }

  function flashHit() {
    hitFlashEl.classList.remove('flash');
    void hitFlashEl.offsetWidth; // restart the CSS transition
    hitFlashEl.classList.add('flash');
    setTimeout(() => hitFlashEl.classList.remove('flash'), 120);
  }

  function registerHit() {
    hits += 1;
    combo = 0;
    comboEl.textContent = '';
    hitsEl.textContent = `HIT: ${hits}/${MAX_HITS}`;
    flashHit();
    shakeTimer = CONFIG.hitShakeDuration;
    slowMoTimer = CONFIG.hitSlowMoDuration;
    if (hits >= MAX_HITS) {
      gameOver();
    }
  }

  function maybeRegenHit() {
    while (score >= nextRegenAt) {
      nextRegenAt += CONFIG.regenEvery;
      if (hits > 0) {
        hits -= 1;
        hitsEl.textContent = `HIT: ${hits}/${MAX_HITS}`;
      }
    }
  }

  // ---- input: hold key to move to the adjacent lane, release to return home ----
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;

    if ((state === 'idle' || state === 'gameover') && e.code === 'Enter') {
      startGame();
      return;
    }
    if (state !== 'playing') return;

    const g = keyBindings.indexOf(e.code);
    if (g !== -1 && tracks[g].posState !== 1) {
      tracks[g].posState = 1;
      tracks[g].lastSwitchTime = elapsed;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (state !== 'playing') return;
    const g = keyBindings.indexOf(e.code);
    if (g !== -1 && tracks[g].posState !== 0) {
      tracks[g].posState = 0;
      tracks[g].lastSwitchTime = elapsed;
    }
  });

  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  // ---- perspective helpers ----
  function currentSpeed() {
    const raw = CONFIG.baseSpeed + elapsed * CONFIG.accelPerSec + score * CONFIG.accelPerScore;
    return Math.min(raw, CONFIG.maxSpeed);
  }

  function spawnIntervalRange() {
    const p = Math.min(elapsed / 40, 1);
    const min = CONFIG.spawnIntervalStart[0] + (CONFIG.spawnIntervalFloor[0] - CONFIG.spawnIntervalStart[0]) * p;
    const max = CONFIG.spawnIntervalStart[1] + (CONFIG.spawnIntervalFloor[1] - CONFIG.spawnIntervalStart[1]) * p;
    return [min, max];
  }

  function ease(z) {
    return z * z;
  }

  function depthY(z) {
    const horizonY = height * CONFIG.horizonRatio;
    return horizonY + (height - horizonY) * ease(z);
  }

  function depthScale(z) {
    return 0.04 + 0.96 * ease(z);
  }

  function roadCenterX() {
    return width / 2;
  }

  function roadHalfWidth() {
    return width * CONFIG.roadHalfWidthRatio;
  }

  // absolute lane index (0..laneCount-1) -> horizontal offset from road center at near plane
  function laneOffset(laneIndex) {
    const halfW = roadHalfWidth();
    const laneW = (halfW * 2) / CONFIG.laneCount;
    return -halfW + laneW * (laneIndex + 0.5);
  }

  function currentAbsLane(track) {
    return track.lanes[track.posState];
  }

  function otherLane(track, absLane) {
    return track.lanes[0] === absLane ? track.lanes[1] : track.lanes[0];
  }

  function pickObstacleKind() {
    const r = Math.random();
    if (elapsed > 12 && r < 0.15) return 'moving';
    if (r < 0.30) return 'tall';
    if (r < 0.45) return 'wide';
    return 'normal';
  }

  function spawnObstacle(track, localLane) {
    track.obstacles.push({
      lane: track.lanes[localLane],
      z: 0,
      scored: false,
      kind: pickObstacleKind(),
      switched: false,
    });
  }

  // occasionally force a "dual" (both tracks at once) or "streak" (rapid alternating)
  // obstacle pattern instead of relying purely on independent per-track randomness.
  function schedulePattern() {
    if (Math.random() < 0.5) {
      for (let t = 0; t < tracks.length; t++) {
        pendingSpawns.push({ trackIndex: t, localLane: Math.random() < 0.5 ? 0 : 1, delay: 0 });
      }
    } else {
      const t = Math.floor(Math.random() * tracks.length);
      let lane = Math.random() < 0.5 ? 0 : 1;
      const count = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        pendingSpawns.push({ trackIndex: t, localLane: lane, delay: i * CONFIG.streakGap });
        lane = 1 - lane;
      }
    }
  }

  function spawnDodgeFx(track, isNearMiss) {
    const scale = depthScale(1);
    const offsetHome = laneOffset(track.lanes[0]);
    const offsetHeld = laneOffset(track.lanes[1]);
    const offset = offsetHome + (offsetHeld - offsetHome) * track.ballPos;
    const cx = roadCenterX() + offset * scale;
    const baseY = depthY(1) - width * CONFIG.ballRadiusRatio;
    const [, mid] = BALL_COLORS[track.color];
    dodgeFx.push({
      cx, baseY,
      life: CONFIG.dodgeFxDuration,
      maxLife: CONFIG.dodgeFxDuration,
      color: isNearMiss ? '#fff6d5' : mid,
      big: isNearMiss,
    });
  }

  // ---- update ----
  function update(dt) {
    elapsed += dt;
    const speed = currentSpeed();
    const [minInt, maxInt] = spawnIntervalRange();

    patternTimer -= dt;
    if (patternTimer <= 0) {
      schedulePattern();
      patternTimer = Math.max(CONFIG.patternIntervalMin, CONFIG.patternIntervalStart - elapsed * 0.05);
    }
    for (const p of pendingSpawns) p.delay -= dt;
    while (pendingSpawns.length && pendingSpawns[0].delay <= 0) {
      const p = pendingSpawns.shift();
      spawnObstacle(tracks[p.trackIndex], p.localLane);
    }

    for (const track of tracks) {
      const target = track.posState;
      track.ballPos += (target - track.ballPos) * Math.min(1, dt * CONFIG.laneSwitchLerp);

      track.spawnTimer -= dt;
      if (track.spawnTimer <= 0) {
        spawnObstacle(track, Math.random() < 0.5 ? 0 : 1);
        track.spawnTimer = minInt + Math.random() * (maxInt - minInt);
      }

      for (const ob of track.obstacles) {
        const prevZ = ob.z;
        ob.z += speed * dt;

        if (ob.kind === 'moving' && !ob.switched && ob.z >= 0.5) {
          ob.switched = true;
          ob.lane = otherLane(track, ob.lane);
        }

        if (prevZ < 1 && ob.z >= 1) {
          if (ob.lane === currentAbsLane(track)) {
            ob.scored = true;
            ob.hit = true;
            registerHit();
            if (state !== 'playing') return;
          } else if (!ob.scored) {
            ob.scored = true;
            const isNearMiss = (elapsed - track.lastSwitchTime) < CONFIG.nearMissWindow;
            combo += 1;
            const mult = Math.min(CONFIG.comboMultCap, 1 + Math.floor(combo / CONFIG.comboTierSize));
            score += (isNearMiss ? 2 : 1) * mult;
            scoreEl.textContent = `SCORE: ${score}`;
            comboEl.textContent = mult > 1 ? `COMBO ${combo} (x${mult})` : (combo > 1 ? `COMBO ${combo}` : '');
            spawnDodgeFx(track, isNearMiss);
            maybeRegenHit();
          }
        }
      }
      track.obstacles = track.obstacles.filter(ob => ob.z < 1.35 && !ob.hit);
    }

    for (const f of dodgeFx) f.life -= dt;
    dodgeFx = dodgeFx.filter(f => f.life > 0);
  }

  // ---- draw ----
  function drawBackground() {
    const horizonY = height * CONFIG.horizonRatio;
    const grad = ctx.createLinearGradient(0, 0, 0, horizonY);
    grad.addColorStop(0, '#0b1030');
    grad.addColorStop(1, '#1c2340');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, horizonY);

    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, horizonY, width, height - horizonY);
  }

  function drawRoad() {
    const horizonY = height * CONFIG.horizonRatio;
    const cx = roadCenterX();
    const halfW = roadHalfWidth();

    ctx.fillStyle = '#16181f';
    ctx.beginPath();
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(cx - halfW, height);
    ctx.lineTo(cx + halfW, height);
    ctx.closePath();
    ctx.fill();

    // outer edges
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(cx - halfW, height);
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(cx + halfW, height);
    ctx.stroke();

    // lane dividers (3 internal lines for 4 lanes), dashed + scrolling
    const speed = currentSpeed();
    const scroll = (elapsed * speed * 1.5) % 0.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    for (let laneIdx = 1; laneIdx < CONFIG.laneCount; laneIdx++) {
      const boundaryOffsetNear = -halfW + (halfW * 2 / CONFIG.laneCount) * laneIdx;
      for (let z = -scroll; z < 1; z += 0.2) {
        const z0 = Math.max(z, 0);
        const z1 = Math.min(z + 0.1, 1);
        if (z1 <= 0) continue;
        const s0 = depthScale(z0), s1 = depthScale(z1);
        const y0 = depthY(z0), y1 = depthY(z1);
        ctx.beginPath();
        ctx.moveTo(cx + boundaryOffsetNear * s0, y0);
        ctx.lineTo(cx + boundaryOffsetNear * s1, y1);
        ctx.stroke();
      }
    }
  }

  const OBSTACLE_STYLES = {
    normal: { wMul: 1,    hMul: 0.7,  body: '#8f1010', top: '#d13a3a' },
    tall:   { wMul: 1,    hMul: 1.15, body: '#7a1414', top: '#c94040' },
    wide:   { wMul: 1.18, hMul: 0.6,  body: '#a03d10', top: '#e0722f' },
    moving: { wMul: 1,    hMul: 0.75, body: '#5c1080', top: '#b04ae0' },
  };

  function drawObstacle(ob) {
    const z = Math.min(ob.z, 1);
    const scale = depthScale(z);
    const cx = roadCenterX() + laneOffset(ob.lane) * scale;
    const baseY = depthY(z);
    const laneW = (roadHalfWidth() * 2) / CONFIG.laneCount;
    const style = OBSTACLE_STYLES[ob.kind] || OBSTACLE_STYLES.normal;
    const w = laneW * scale * 0.85 * style.wMul;
    const h = (laneW * scale * 0.85) * style.hMul;

    ctx.fillStyle = style.body;
    ctx.fillRect(cx - w / 2, baseY - h, w, h);
    ctx.fillStyle = style.top;
    ctx.fillRect(cx - w / 2, baseY - h, w, h * 0.28);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - w / 2, baseY - h, w, h);
  }

  const BALL_COLORS = {
    blue: ['#7fb2ff', '#2a5fdb', '#0f2a80'],
    gold: ['#fff3c4', '#e0ab19', '#7a5600'],
  };

  function drawBall(track) {
    const scale = depthScale(1);
    const offsetHome = laneOffset(track.lanes[0]);
    const offsetHeld = laneOffset(track.lanes[1]);
    const offset = offsetHome + (offsetHeld - offsetHome) * track.ballPos;
    const cx = roadCenterX() + offset * scale;
    const radius = width * CONFIG.ballRadiusRatio;
    const baseY = depthY(1) - radius;

    const [hi, mid, dark] = BALL_COLORS[track.color];
    const grad = ctx.createRadialGradient(cx - radius * 0.35, baseY - radius * 0.35, radius * 0.15, cx, baseY, radius);
    grad.addColorStop(0, hi);
    grad.addColorStop(0.5, mid);
    grad.addColorStop(1, dark);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, baseY, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawDodgeFx() {
    for (const f of dodgeFx) {
      const t = 1 - f.life / f.maxLife;
      const r = width * CONFIG.ballRadiusRatio * (1 + t * (f.big ? 2.4 : 1.5));
      ctx.globalAlpha = (1 - t) * (f.big ? 0.9 : 0.55);
      ctx.strokeStyle = f.color;
      ctx.lineWidth = f.big ? 4 : 2.5;
      ctx.beginPath();
      ctx.arc(f.cx, f.baseY, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    ctx.save();
    if (shakeTimer > 0) {
      const power = (shakeTimer / CONFIG.hitShakeDuration) * 10;
      ctx.translate((Math.random() - 0.5) * power, (Math.random() - 0.5) * power);
    }

    drawBackground();
    drawRoad();

    const allObstacles = [];
    for (const track of tracks) {
      for (const ob of track.obstacles) allObstacles.push(ob);
    }
    allObstacles.sort((a, b) => a.z - b.z);
    for (const ob of allObstacles) drawObstacle(ob);

    drawDodgeFx();
    for (const track of tracks) drawBall(track);

    ctx.restore();
  }

  // ---- loop ----
  function loop(now) {
    if (state !== 'playing') return;
    let rawDt = Math.min((now - lastTime) / 1000, 1 / 20);
    lastTime = now;

    let simDt = rawDt;
    if (slowMoTimer > 0) {
      simDt = rawDt * CONFIG.hitSlowMoScale;
      slowMoTimer = Math.max(0, slowMoTimer - rawDt);
    }
    if (shakeTimer > 0) shakeTimer = Math.max(0, shakeTimer - rawDt);

    update(simDt);
    if (state !== 'playing') {
      draw();
      return;
    }
    draw();
    requestAnimationFrame(loop);
  }

  resetGame();
  draw();
})();
