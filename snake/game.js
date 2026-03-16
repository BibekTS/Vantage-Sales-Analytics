// ── Vantage Dash — Snake Game ────────────────────────────────────────────
// Standalone. Zero dependencies on the parent app.

const CELL = 26;
const COLS = 20;
const ROWS = 14;

const C = {
  bg:         '#030710',
  dot:        'rgba(28,40,64,0.7)',
  snakeTail:  '#1E3A8A',
  snakeBody:  '#2563EB',
  snakeHead:  '#93C5FD',
  snakeGlow:  'rgba(147,197,253,0.4)',
  food:       '#34D399',
  foodGlow:   'rgba(52,211,153,0.65)',
  bonus:      '#FCD34D',
  bonusGlow:  'rgba(252,211,77,0.65)',
};

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

let canvas, ctx;
let state = 'start';   // 'start' | 'playing' | 'over'
let snake, dir, queued, food, bonus, bonusTick;
let score, pipeLen, quarter, tick, speed;
let best;
let raf;
let touchX, touchY;

// ── Init ─────────────────────────────────────────────────────────────────

function init() {
  canvas = document.getElementById('canvas');
  canvas.width  = COLS * CELL;   // 520
  canvas.height = ROWS * CELL;   // 364
  ctx = canvas.getContext('2d');

  best = parseFloat(localStorage.getItem('vd_best') || '0');
  document.getElementById('best').textContent = fmt(best);

  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-restart').addEventListener('click', startGame);
  document.getElementById('close-btn').addEventListener('click', closeGame);

  document.addEventListener('keydown', onKey);
  canvas.addEventListener('touchstart', e => {
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, { passive: true });
  canvas.addEventListener('touchend', onTouch, { passive: true });

  drawGrid(); // idle background
}

// ── Game lifecycle ────────────────────────────────────────────────────────

function startGame() {
  document.getElementById('ov-start').classList.add('hidden');
  document.getElementById('ov-over').classList.add('hidden');

  const mx = Math.floor(COLS / 2);
  const my = Math.floor(ROWS / 2);
  snake  = [{ x: mx, y: my }, { x: mx - 1, y: my }, { x: mx - 2, y: my }];
  dir    = { x: 1, y: 0 };
  queued = { x: 1, y: 0 };

  score = 0; pipeLen = 3; quarter = 0; tick = 0; speed = 9;
  bonus = null; bonusTick = 0;

  placeFood();
  state = 'playing';
  updateHUD();

  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

function loop() {
  raf = requestAnimationFrame(loop);
  tick++;

  const interval = Math.max(4, 16 - speed);
  if (tick % interval !== 0) return;

  dir = { ...queued };

  const head = {
    x: (snake[0].x + dir.x + COLS) % COLS,
    y: (snake[0].y + dir.y + ROWS) % ROWS,
  };

  // Self-collision = game over
  if (snake.some(s => s.x === head.x && s.y === head.y)) {
    gameOver();
    return;
  }

  snake.unshift(head);
  let ate = false;

  // Eat regular food
  if (head.x === food.x && head.y === food.y) {
    score   = +(score + 0.1 + quarter * 0.05).toFixed(1);
    pipeLen++;
    ate = true;
    if (score > best) { best = score; localStorage.setItem('vd_best', best); }
    placeFood();

    // Level up every 5 pieces
    if (pipeLen % 5 === 0) {
      speed   = Math.min(speed + 1, 15);
      quarter = Math.min(quarter + 1, 3);
      document.getElementById('quarter').textContent = QUARTERS[quarter];
    }

    // ~22% chance to spawn a bonus gem
    if (!bonus && Math.random() < 0.22) spawnBonus();
  }

  // Eat bonus food
  if (bonus && head.x === bonus.x && head.y === bonus.y) {
    score   = +(score + 0.5 + quarter * 0.1).toFixed(1);
    pipeLen++;
    ate = true;
    if (score > best) { best = score; localStorage.setItem('vd_best', best); }
    bonus = null;
  }

  if (!ate) snake.pop();

  // Bonus timeout
  if (bonus && --bonusTick <= 0) bonus = null;

  updateHUD();
  draw();
}

function gameOver() {
  state = 'over';
  cancelAnimationFrame(raf);

  document.getElementById('final-score').textContent = fmt(score);
  document.getElementById('final-len').textContent   = pipeLen;
  document.getElementById('final-best').textContent  = fmt(best);
  document.getElementById('ov-over').classList.remove('hidden');
}

// ── Drawing ───────────────────────────────────────────────────────────────

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Grid dots
  drawGrid();

  // Food gem
  drawGem(food.x, food.y, C.food, C.foodGlow, 8);

  // Bonus gem (flashes when expiring)
  if (bonus) {
    const show = bonusTick > 30 || Math.floor(bonusTick / 4) % 2 === 0;
    if (show) drawGem(bonus.x, bonus.y, C.bonus, C.bonusGlow, 10);
  }

  // Snake body — gradient from dark tail to bright near-head
  for (let i = snake.length - 1; i >= 1; i--) {
    const t = 1 - i / snake.length;
    // Interpolate: tail (#1E3A8A) → body (#2563EB)
    const r = Math.round(30  + t * (37  - 30));
    const g = Math.round(58  + t * (99  - 58));
    const b = Math.round(138 + t * (235 - 138));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    const s   = snake[i];
    const pad = 4 - Math.round(t * 1.5);  // taper tail segments
    rr(s.x * CELL + pad, s.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, 4);
    ctx.fill();
  }

  // Head — bright with glow
  const h = snake[0];
  ctx.shadowColor = C.snakeGlow;
  ctx.shadowBlur  = 16;
  ctx.fillStyle   = C.snakeHead;
  rr(h.x * CELL + 2, h.y * CELL + 2, CELL - 4, CELL - 4, 6);
  ctx.fill();
  ctx.shadowBlur = 0;

  drawEyes(h.x, h.y);
}

function drawGrid() {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = C.dot;
  for (let x = 1; x < COLS; x++) {
    for (let y = 1; y < ROWS; y++) {
      ctx.fillRect(x * CELL - 1.5, y * CELL - 1.5, 3, 3);
    }
  }
}

function drawGem(gx, gy, color, glow, r) {
  const cx = gx * CELL + CELL / 2;
  const cy = gy * CELL + CELL / 2;

  ctx.shadowColor = glow;
  ctx.shadowBlur  = 18;
  ctx.fillStyle   = color;

  // Hexagonal gem shape
  ctx.beginPath();
  ctx.moveTo(cx,         cy - r);
  ctx.lineTo(cx + r * 0.7, cy - r * 0.25);
  ctx.lineTo(cx + r,     cy + r * 0.45);
  ctx.lineTo(cx,         cy + r);
  ctx.lineTo(cx - r,     cy + r * 0.45);
  ctx.lineTo(cx - r * 0.7, cy - r * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  // Inner highlight facet
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  ctx.beginPath();
  ctx.moveTo(cx,           cy - r * 0.7);
  ctx.lineTo(cx + r * 0.5, cy - r * 0.05);
  ctx.lineTo(cx,           cy + r * 0.15);
  ctx.lineTo(cx - r * 0.5, cy - r * 0.05);
  ctx.closePath();
  ctx.fill();
}

function drawEyes(gx, gy) {
  const cx = gx * CELL + CELL / 2 + dir.x * 5;
  const cy = gy * CELL + CELL / 2 + dir.y * 5;
  const px = -dir.y;
  const py =  dir.x;

  [1, -1].forEach(side => {
    const ex = cx + px * 4 * side;
    const ey = cy + py * 4 * side;
    ctx.fillStyle = '#030710';
    ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(ex + dir.x * 1, ey + dir.y * 1, 1.3, 0, Math.PI * 2); ctx.fill();
  });
}

// Rounded-rectangle path helper
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);      ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);      ctx.arcTo(x,     y + h, x,     y + h - r, r);
  ctx.lineTo(x, y + r);          ctx.arcTo(x,     y,     x + r, y,         r);
  ctx.closePath();
}

// ── Helpers ───────────────────────────────────────────────────────────────

function placeFood() {
  let p;
  do { p = { x: ri(COLS), y: ri(ROWS) }; }
  while (occupied(p));
  food = p;
}

function spawnBonus() {
  let p;
  do { p = { x: ri(COLS), y: ri(ROWS) }; }
  while (occupied(p) || (p.x === food.x && p.y === food.y));
  bonus     = p;
  bonusTick = 70 + ri(40);
}

function occupied(p) {
  return snake.some(s => s.x === p.x && s.y === p.y);
}

function updateHUD() {
  document.getElementById('score').textContent    = fmt(score   || 0);
  document.getElementById('pipeline').textContent = pipeLen     || 3;
  document.getElementById('quarter').textContent  = QUARTERS[quarter || 0];
  document.getElementById('best').textContent     = fmt(best    || 0);
}

function fmt(n) { return '$' + (+(n || 0)).toFixed(1) + 'M'; }
function ri(n)  { return Math.floor(Math.random() * n); }

// ── Input ─────────────────────────────────────────────────────────────────

function onKey(e) {
  if (e.key === 'Escape') { closeGame(); return; }
  if (state !== 'playing') return;

  const map = {
    ArrowUp:    { x: 0, y:-1 }, w: { x: 0, y:-1 }, W: { x: 0, y:-1 },
    ArrowDown:  { x: 0, y: 1 }, s: { x: 0, y: 1 }, S: { x: 0, y: 1 },
    ArrowLeft:  { x:-1, y: 0 }, a: { x:-1, y: 0 }, A: { x:-1, y: 0 },
    ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 }, D: { x: 1, y: 0 },
  };
  const nd = map[e.key];
  if (!nd) return;
  e.preventDefault();
  // Block 180° reversal
  if (nd.x !== -dir.x || nd.y !== -dir.y) queued = nd;
}

function onTouch(e) {
  if (state !== 'playing') return;
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
  let nd;
  if (Math.abs(dx) > Math.abs(dy)) nd = dx > 0 ? { x:1, y:0 } : { x:-1, y:0 };
  else nd = dy > 0 ? { x:0, y:1 } : { x:0, y:-1 };
  if (nd.x !== -dir.x || nd.y !== -dir.y) queued = nd;
}

// ── Close ─────────────────────────────────────────────────────────────────

function closeGame() {
  if (raf) cancelAnimationFrame(raf);
  // Tell parent to close the modal — works when loaded in iframe
  if (window.parent && window.parent !== window && window.parent.closeSnakeGame) {
    window.parent.closeSnakeGame();
  } else {
    window.close();
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
