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
    baseSpeed: 0.55,       // z units per second at start
    accelPerSec: 0.012,    // speed gained per second survived
    maxSpeed: 1.8,
    spawnIntervalStart: [1.1, 1.6], // seconds [min,max] between spawns per track
    spawnIntervalFloor: [0.45, 0.7],
    laneSwitchLerp: 14,    // higher = snappier lane switch
    horizonRatio: 0.30,
    roadHalfWidthNear: 0.11,  // fraction of canvas width
    trackCenterRatios: [0.27, 0.73],
  };

  let width = 0, height = 0;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function makeTrack(centerRatio) {
    return {
      centerRatio,
      ballLane: 0,      // 0 = left lane of track, 1 = right lane of track
      ballPos: 0,       // interpolated 0..1 for rendering
      obstacles: [],    // {lane, z, scored}
      spawnTimer: 1.0,
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
    tracks = CONFIG.trackCenterRatios.map(makeTrack);
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

  // ---- input ----
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const code = e.code;

    if (state === 'idle' && code === 'Enter') {
      startGame();
      return;
    }
    if (state === 'gameover' && code === 'Enter') {
      startGame();
      return;
    }
    if (state !== 'playing') return;

    if (code === 'KeyS') {
      const t = tracks[0];
      t.ballLane = t.ballLane === 0 ? 1 : 0;
    } else if (code === 'KeyJ') {
      const t = tracks[1];
      t.ballLane = t.ballLane === 0 ? 1 : 0;
    }
  });

  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', startGame);

  // ---- perspective helpers ----
  function currentSpeed() {
    return Math.min(CONFIG.baseSpeed + elapsed * CONFIG.accelPerSec, CONFIG.maxSpeed);
  }

  function spawnIntervalRange() {
    const p = Math.min(elapsed / 40, 1); // ramps over 40s toward floor
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

  function laneOffset(track, lane) {
    const roadHalfWidth = width * CONFIG.roadHalfWidthNear;
    const laneCenter = roadHalfWidth * 0.5;
    return lane === 0 ? -laneCenter : laneCenter;
  }

  function trackCenterX(track) {
    return width * track.centerRatio;
  }

  // ---- update ----
  function update(dt) {
    elapsed += dt;
    const speed = currentSpeed();
    const [minInt, maxInt] = spawnIntervalRange();

    for (const track of tracks) {
      // smooth ball lane interpolation
      const target = track.ballLane;
      track.ballPos += (target - track.ballPos) * Math.min(1, dt * CONFIG.laneSwitchLerp);

      // spawn
      track.spawnTimer -= dt;
      if (track.spawnTimer <= 0) {
        const lane = Math.random() < 0.5 ? 0 : 1;
        track.obstacles.push({ lane, z: 0, scored: false });
        track.spawnTimer = minInt + Math.random() * (maxInt - minInt);
      }

      // move obstacles
      for (const ob of track.obstacles) {
        const prevZ = ob.z;
        ob.z += speed * dt;
        if (prevZ < 1 && ob.z >= 1) {
          if (ob.lane === track.ballLane) {
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

  function drawRoad(track) {
    const horizonY = height * CONFIG.horizonRatio;
    const cx = trackCenterX(track);
    const roadHalfWidth = width * CONFIG.roadHalfWidthNear;

    ctx.fillStyle = '#16181f';
    ctx.beginPath();
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(cx - roadHalfWidth, height);
    ctx.lineTo(cx + roadHalfWidth, height);
    ctx.closePath();
    ctx.fill();

    // outer edge lines
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(cx - roadHalfWidth, height);
    ctx.moveTo(cx, horizonY);
    ctx.lineTo(cx + roadHalfWidth, height);
    ctx.stroke();

    // center dashed divider, scrolling
    const speed = currentSpeed();
    const scroll = (elapsed * speed * 1.5) % 0.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    for (let z = -scroll; z < 1; z += 0.2) {
      const z0 = Math.max(z, 0);
      const z1 = Math.min(z + 0.1, 1);
      if (z1 <= 0) continue;
      const y0 = depthY(z0);
      const y1 = depthY(z1);
      ctx.beginPath();
      ctx.moveTo(cx, y0);
      ctx.lineTo(cx, y1);
      ctx.stroke();
    }
  }

  function drawObstacle(track, ob) {
    const z = Math.min(ob.z, 1);
    const scale = depthScale(z);
    const cx = trackCenterX(track) + laneOffset(track, ob.lane) * scale;
    const baseY = depthY(z);
    const roadHalfWidth = width * CONFIG.roadHalfWidthNear;
    const w = roadHalfWidth * scale * 0.95;
    const h = w * 0.7;

    // side/front face
    ctx.fillStyle = '#8f1010';
    ctx.fillRect(cx - w / 2, baseY - h, w, h);
    // top highlight face
    ctx.fillStyle = '#d13a3a';
    ctx.fillRect(cx - w / 2, baseY - h, w, h * 0.28);
    // outline
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - w / 2, baseY - h, w, h);
  }

  function drawBall(track) {
    const scale = depthScale(1);
    const offset = laneOffset(track, 0) + (laneOffset(track, 1) - laneOffset(track, 0)) * track.ballPos;
    const cx = trackCenterX(track) + offset * scale;
    const radius = width * 0.018;
    const baseY = depthY(1) - radius;

    const grad = ctx.createRadialGradient(cx - radius * 0.35, baseY - radius * 0.35, radius * 0.15, cx, baseY, radius);
    grad.addColorStop(0, '#7fb2ff');
    grad.addColorStop(0.5, '#2a5fdb');
    grad.addColorStop(1, '#0f2a80');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, baseY, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw() {
    drawBackground();
    for (const track of tracks) drawRoad(track);

    for (const track of tracks) {
      const sorted = [...track.obstacles].sort((a, b) => a.z - b.z);
      for (const ob of sorted) drawObstacle(track, ob);
    }

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

  // initial idle frame render (empty tracks) so canvas isn't blank behind start screen
  resetGame();
  draw();
})();
