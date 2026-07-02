(() => {
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');

  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const startScreen = document.getElementById('start-screen');
  const gameoverScreen = document.getElementById('gameover-screen');
  const finalScoreEl = document.getElementById('final-score');
  const bestScoreEl = document.getElementById('best-score');
  const startBtn = document.getElementById('start-btn');
  const restartBtn = document.getElementById('restart-btn');

  const BEST_KEY = 'dodgeDominoBest';

  const CONFIG = {
    baseSpeed: 0.55,
    accelPerSec: 0.012,
    maxSpeed: 1.8,
    spawnIntervalStart: [1.1, 1.6],
    spawnIntervalFloor: [0.45, 0.7],
    laneSwitchLerp: 14,
    horizonRatio: 0.30,
    roadHalfWidthRatio: 0.26,   // total 4-lane road half-width, fraction of canvas width
    laneCount: 4,
    ballRadiusRatio: 0.018,     // ball radius, fraction of canvas width
  };

  // key groups: each group owns 2 adjacent lanes (absolute lane index 0-3).
  // "home" = resting lane, "held" = lane moved to while the key is held down.
  const GROUPS = [
    { key: 'Digit1', lanes: [0, 1], color: 'blue' },  // lanes 1&2 (key 1)
    { key: 'Digit2', lanes: [3, 2], color: 'gold' },  // lanes 4&3 (key 2), home=lane4
  ];

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
    };
  }

  let tracks = [];
  let state = 'idle'; // idle | playing | gameover
  let score = 0;
  let elapsed = 0;
  let lastTime = 0;

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
    elapsed = 0;
    scoreEl.textContent = 'SCORE: 0';
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

  // ---- input: hold key to move to the adjacent lane, release to return home ----
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;

    if ((state === 'idle' || state === 'gameover') && e.code === 'Enter') {
      startGame();
      return;
    }
    if (state !== 'playing') return;

    const g = GROUPS.findIndex(g => g.key === e.code);
    if (g !== -1) tracks[g].posState = 1;
  });

  window.addEventListener('keyup', (e) => {
    if (state !== 'playing') return;
    const g = GROUPS.findIndex(g => g.key === e.code);
    if (g !== -1) tracks[g].posState = 0;
  });

  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  // ---- perspective helpers ----
  function currentSpeed() {
    return Math.min(CONFIG.baseSpeed + elapsed * CONFIG.accelPerSec, CONFIG.maxSpeed);
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

  // ---- update ----
  function update(dt) {
    elapsed += dt;
    const speed = currentSpeed();
    const [minInt, maxInt] = spawnIntervalRange();

    for (const track of tracks) {
      const target = track.posState;
      track.ballPos += (target - track.ballPos) * Math.min(1, dt * CONFIG.laneSwitchLerp);

      track.spawnTimer -= dt;
      if (track.spawnTimer <= 0) {
        const localLane = Math.random() < 0.5 ? 0 : 1;
        track.obstacles.push({ lane: track.lanes[localLane], z: 0, scored: false });
        track.spawnTimer = minInt + Math.random() * (maxInt - minInt);
      }

      for (const ob of track.obstacles) {
        const prevZ = ob.z;
        ob.z += speed * dt;
        if (prevZ < 1 && ob.z >= 1) {
          if (ob.lane === currentAbsLane(track)) {
            gameOver();
            return;
          } else if (!ob.scored) {
            ob.scored = true;
            score += 1;
            scoreEl.textContent = `SCORE: ${score}`;
          }
        }
      }
      track.obstacles = track.obstacles.filter(ob => ob.z < 1.35);
    }
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

  function drawObstacle(ob) {
    const z = Math.min(ob.z, 1);
    const scale = depthScale(z);
    const cx = roadCenterX() + laneOffset(ob.lane) * scale;
    const baseY = depthY(z);
    const laneW = (roadHalfWidth() * 2) / CONFIG.laneCount;
    const w = laneW * scale * 0.85;
    const h = w * 0.7;

    ctx.fillStyle = '#8f1010';
    ctx.fillRect(cx - w / 2, baseY - h, w, h);
    ctx.fillStyle = '#d13a3a';
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

  function draw() {
    drawBackground();
    drawRoad();

    const allObstacles = [];
    for (const track of tracks) {
      for (const ob of track.obstacles) allObstacles.push(ob);
    }
    allObstacles.sort((a, b) => a.z - b.z);
    for (const ob of allObstacles) drawObstacle(ob);

    for (const track of tracks) drawBall(track);
  }

  // ---- loop ----
  function loop(now) {
    if (state !== 'playing') return;
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    dt = Math.min(dt, 1 / 20);

    update(dt);
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
