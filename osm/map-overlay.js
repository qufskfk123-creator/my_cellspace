/**
 * map-overlay.js
 * Leaflet + Canvas2D CellSpace 오버레이
 *
 * - OSM 타일: L.tileLayer (tile.openstreetmap.org)
 * - 시뮬레이션: GridEngine (2D Navier-Stokes)
 * - 렌더링: Canvas2D (perspective quad · 속도 화살표 · 파티클 트레일 · 환기구)
 * - 조작: 클릭 → 밀도 주입, Ctrl+드래그 → 방향 주입
 * - GUI: lil-gui (우측 상단)
 */

import { GridEngine } from './GridEngine.js';

// ── 지도 중심 · 격자 범위 ────────────────────────────────────────────────────
const CENTER_LNG =  127.0276;   // 강남역 경도
const CENTER_LAT =   37.4979;   // 강남역 위도

const SPAN_LNG   =    0.018;    // 격자 전체 폭  (경도)
const SPAN_LAT   =    0.012;    // 격자 전체 높이 (위도)

const N      = 32;
const CELL_W = SPAN_LNG / N;
const CELL_H = SPAN_LAT / N;

const MIN_LNG = CENTER_LNG - SPAN_LNG / 2;
const MIN_LAT = CENTER_LAT - SPAN_LAT / 2;
const MAX_LNG = MIN_LNG + SPAN_LNG;
const MAX_LAT = MIN_LAT + SPAN_LAT;

// ── 환기구 목록 ──────────────────────────────────────────────────────────────
const VENTS = [
  { lng: 127.0258, lat: 37.4972 },
  { lng: 127.0268, lat: 37.4985 },
  { lng: 127.0276, lat: 37.4968 },
  { lng: 127.0290, lat: 37.4982 },
  { lng: 127.0282, lat: 37.4993 },
  { lng: 127.0265, lat: 37.4963 },
];

// ── 색상 팔레트 ──────────────────────────────────────────────────────────────
const STOPS = [
  [ 130,   0, 255 ],   // 보라
  [   0, 120, 255 ],   // 파랑
  [   0, 200,  80 ],   // 초록
  [ 255,  30,   0 ],   // 빨강
];

function lerpColor(t) {
  t = Math.max(0, Math.min(1, t));
  const seg   = (STOPS.length - 1) * t;
  const idx   = Math.floor(seg);
  const f     = seg - idx;
  const A     = STOPS[Math.min(idx,     STOPS.length - 1)];
  const B     = STOPS[Math.min(idx + 1, STOPS.length - 1)];
  return [
    Math.round(A[0] + (B[0] - A[0]) * f),
    Math.round(A[1] + (B[1] - A[1]) * f),
    Math.round(A[2] + (B[2] - A[2]) * f),
  ];
}

// ── Leaflet 초기화 ───────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [CENTER_LAT, CENTER_LNG],
  zoom: 16,
  zoomControl: true,
}).setView([CENTER_LAT, CENTER_LNG], 16);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

// ── Canvas 설정 ──────────────────────────────────────────────────────────────
const canvas = document.getElementById('sim-canvas');
const ctx    = canvas.getContext('2d');
const dpr    = window.devicePixelRatio || 1;

function resizeCanvas() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
}
resizeCanvas();
window.addEventListener('resize', () => { resizeCanvas(); });

// CSS 픽셀 좌표 → 물리 픽셀 변환
function proj(lng, lat) {
  const p = map.latLngToContainerPoint(L.latLng(lat, lng));
  return { x: p.x * dpr, y: p.y * dpr };
}

// ── GridEngine 초기화 ────────────────────────────────────────────────────────
const engine = new GridEngine();

// ── lil-gui 파라미터 ─────────────────────────────────────────────────────────
const params = {
  diffusion:     0.00008,
  viscosity:     0.00006,
  windDir:       45,        // 도 (0=동, 90=북)
  windSpeed:     1.5,
  particleSpeed: 1.2,
  opacity:       0.82,
  showArrows:    true,
  showGrid:      true,
  showParticles: true,
  ventStrength:  3.0,
};

const gui = new lil.GUI({ title: 'Cell Space' });
gui.add(params, 'diffusion',     0, 0.001, 0.000005).name('확산 계수').onChange(v => { engine.diff = v; });
gui.add(params, 'viscosity',     0, 0.001, 0.000005).name('점성 계수').onChange(v => { engine.visc = v; });
gui.add(params, 'windDir',       0, 360,   1       ).name('바람 방향°');
gui.add(params, 'windSpeed',     0, 5,     0.05    ).name('바람 속도');
gui.add(params, 'particleSpeed', 0.5, 4,   0.1     ).name('파티클 속도');
gui.add(params, 'opacity',       0.1, 1.0, 0.01    ).name('투명도');
gui.add(params, 'ventStrength',  0.5, 8,   0.5     ).name('환기구 강도');
gui.add(params, 'showGrid'     ).name('격자선 표시');
gui.add(params, 'showArrows'   ).name('속도 화살표');
gui.add(params, 'showParticles').name('파티클 트레일');

// ── 파티클 시스템 ────────────────────────────────────────────────────────────
const PARTICLE_COUNT = 300;
const TRAIL_LEN      = 10;

const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
  gx: Math.random() * N,
  gy: Math.random() * N,
  trail: [],
}));

function resetParticle(p) {
  p.gx    = Math.random() * (N - 2) + 1;
  p.gy    = Math.random() * (N - 2) + 1;
  p.trail = [];
}

// ── 격자 좌표 ↔ 지리 좌표 ────────────────────────────────────────────────────
function g2geo(gx, gy) {
  return [MIN_LNG + gx * CELL_W, MIN_LAT + gy * CELL_H];
}

// ── 마우스 상태 ───────────────────────────────────────────────────────────────
const mouse = {
  active:  false,
  ctrl:    false,
  prevX:   0,
  prevY:   0,
  curX:    0,
  curY:    0,
};

// 화면 CSS 픽셀 → 격자 좌표
function screenToGrid(cssX, cssY) {
  const latlng = map.containerPointToLatLng(L.point(cssX, cssY));
  const gx = (latlng.lng - MIN_LNG) / CELL_W;
  const gy = (latlng.lat - MIN_LAT) / CELL_H;
  return { gx, gy };
}

// 클릭 → 밀도 주입
map.on('click', (e) => {
  if (mouse.ctrl) return;   // Ctrl+드래그 전용
  const gx = (e.latlng.lng - MIN_LNG) / CELL_W;
  const gy = (e.latlng.lat - MIN_LAT) / CELL_H;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      engine.addSource(Math.round(gx + di), Math.round(gy + dj), 15, 0, 0);
    }
  }
});

// Ctrl+드래그 → 방향 주입
document.addEventListener('keydown', (e) => { if (e.key === 'Control') mouse.ctrl = true; });
document.addEventListener('keyup',   (e) => { if (e.key === 'Control') mouse.ctrl = false; });

const mapDiv = document.getElementById('map');
mapDiv.addEventListener('mousedown', (e) => {
  if (!mouse.ctrl) return;
  mouse.active = true;
  mouse.prevX  = e.clientX;
  mouse.prevY  = e.clientY;
  mouse.curX   = e.clientX;
  mouse.curY   = e.clientY;
  map.dragging.disable();
});
document.addEventListener('mousemove', (e) => {
  if (!mouse.active) return;
  mouse.prevX = mouse.curX;
  mouse.prevY = mouse.curY;
  mouse.curX  = e.clientX;
  mouse.curY  = e.clientY;

  const { gx, gy } = screenToGrid(mouse.curX, mouse.curY);
  const dvx = (mouse.curX - mouse.prevX) * 0.3;
  const dvy = -(mouse.curY - mouse.prevY) * 0.3;  // Y 반전 (화면↓=남쪽)
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      engine.addSource(Math.round(gx + di), Math.round(gy + dj), 8, dvx, dvy);
    }
  }
});
document.addEventListener('mouseup', () => {
  mouse.active = false;
  map.dragging.enable();
});

// ── 그리기 함수들 ─────────────────────────────────────────────────────────────

let maxD = 1;   // 지수 평활로 최대 밀도 추적

function drawCells() {
  const opq = params.opacity;
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const d = engine.getDensityAt(gx + 0.5, gy + 0.5);
      if (d < 0.05) continue;

      const t = Math.min(d / Math.max(maxD, 0.5), 1);
      const [r, g, b] = lerpColor(t);
      const a = Math.round((0.15 + t * 0.75) * opq * 255);

      const sw = proj(MIN_LNG +  gx      * CELL_W, MIN_LAT +  gy      * CELL_H);
      const se = proj(MIN_LNG + (gx + 1) * CELL_W, MIN_LAT +  gy      * CELL_H);
      const ne = proj(MIN_LNG + (gx + 1) * CELL_W, MIN_LAT + (gy + 1) * CELL_H);
      const nw = proj(MIN_LNG +  gx      * CELL_W, MIN_LAT + (gy + 1) * CELL_H);

      ctx.beginPath();
      ctx.moveTo(sw.x, sw.y);
      ctx.lineTo(se.x, se.y);
      ctx.lineTo(ne.x, ne.y);
      ctx.lineTo(nw.x, nw.y);
      ctx.closePath();
      ctx.fillStyle = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
      ctx.fill();
    }
  }
}

function drawGridLines() {
  if (!params.showGrid) return;
  ctx.beginPath();
  for (let gy = 0; gy <= N; gy++) {
    const A = proj(MIN_LNG, MIN_LAT + gy * CELL_H);
    const B = proj(MAX_LNG, MIN_LAT + gy * CELL_H);
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
  }
  for (let gx = 0; gx <= N; gx++) {
    const A = proj(MIN_LNG + gx * CELL_W, MIN_LAT);
    const B = proj(MIN_LNG + gx * CELL_W, MAX_LAT);
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
  }
  ctx.strokeStyle = 'rgba(80, 100, 200, 0.15)';
  ctx.lineWidth   = dpr * 0.6;
  ctx.stroke();
}

function drawBoundary() {
  const corners = [
    proj(MIN_LNG, MIN_LAT),
    proj(MAX_LNG, MIN_LAT),
    proj(MAX_LNG, MAX_LAT),
    proj(MIN_LNG, MAX_LAT),
  ];
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(80, 80, 200, 0.55)';
  ctx.lineWidth   = dpr * 1.5;
  ctx.setLineDash([dpr * 6, dpr * 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawArrows() {
  if (!params.showArrows) return;
  const STEP = 2;
  const HEAD = dpr * 5;

  ctx.strokeStyle = 'rgba(26, 96, 200, 0.70)';
  ctx.fillStyle   = 'rgba(26, 96, 200, 0.70)';
  ctx.lineWidth   = dpr * 1.2;

  for (let gy = 1; gy < N - 1; gy += STEP) {
    for (let gx = 1; gx < N - 1; gx += STEP) {
      const [vx, vy] = engine.getVelocityAt(gx, gy);
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed < 0.05) continue;

      const nx =  vx / speed;
      const ny = -vy / speed;  // 화면 Y는 남쪽이 +, 속도 vy는 북이 +

      const [lng, lat] = g2geo(gx, gy);
      const center = proj(lng, lat);

      const len = Math.min(speed * dpr * 10, dpr * 22);
      const tx  = center.x + nx * len;
      const ty  = center.y + ny * len;

      // 화살대
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      // 화살촉
      const angle = Math.atan2(ny, nx);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - HEAD * Math.cos(angle - 0.45), ty - HEAD * Math.sin(angle - 0.45));
      ctx.lineTo(tx - HEAD * Math.cos(angle + 0.45), ty - HEAD * Math.sin(angle + 0.45));
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawVents(t) {
  const pulse = 0.5 + 0.5 * Math.sin(t * 3);
  VENTS.forEach((v) => {
    const p = proj(v.lng, v.lat);
    const r = (8 + pulse * 5) * dpr;

    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0,   `rgba(220, 50, 0, ${0.85 * params.opacity})`);
    grad.addColorStop(0.6, `rgba(220, 50, 0, ${0.35 * params.opacity})`);
    grad.addColorStop(1,   'rgba(220, 50, 0, 0)');

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  });
}

function drawParticles() {
  if (!params.showParticles) return;
  particles.forEach((p) => {
    if (p.trail.length < 2) return;
    ctx.beginPath();
    const head = p.trail[0];
    const tail = p.trail[p.trail.length - 1];
    const hp   = proj(...g2geo(head.gx, head.gy));
    const tp   = proj(...g2geo(tail.gx, tail.gy));

    const grad = ctx.createLinearGradient(tp.x, tp.y, hp.x, hp.y);
    grad.addColorStop(0, 'rgba(0, 100, 220, 0)');
    grad.addColorStop(1, `rgba(0, 100, 220, ${0.75 * params.opacity})`);

    ctx.moveTo(tp.x, tp.y);
    for (let i = p.trail.length - 2; i >= 0; i--) {
      const pt = proj(...g2geo(p.trail[i].gx, p.trail[i].gy));
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.strokeStyle = grad;
    ctx.lineWidth   = dpr * 1.4;
    ctx.stroke();
  });
}

// ── 파티클 물리 ───────────────────────────────────────────────────────────────
function updateParticles() {
  const speed = params.particleSpeed;
  particles.forEach((p) => {
    const [vx, vy] = engine.getVelocityAt(p.gx, p.gy);
    p.gx += vx * engine.dt * speed * 8;
    p.gy += vy * engine.dt * speed * 8;

    // 경계 이탈 시 재생성
    if (p.gx < 0.5 || p.gx > N - 1.5 || p.gy < 0.5 || p.gy > N - 1.5) {
      resetParticle(p);
      return;
    }

    p.trail.unshift({ gx: p.gx, gy: p.gy });
    if (p.trail.length > TRAIL_LEN) p.trail.length = TRAIL_LEN;

    // 밀도가 너무 낮으면 랜덤 재배치
    if (engine.getDensityAt(p.gx, p.gy) < 0.01 && Math.random() < 0.005) {
      resetParticle(p);
    }
  });
}

// ── 환기구 소스 주입 ──────────────────────────────────────────────────────────
function addVentSources() {
  const str = params.ventStrength;
  VENTS.forEach((v) => {
    const gx = (v.lng - MIN_LNG) / CELL_W;
    const gy = (v.lat - MIN_LAT) / CELL_H;

    // 바람 방향으로 약한 초기 속도
    const rad = (params.windDir * Math.PI) / 180;
    const vx  = Math.cos(rad) * 0.5;
    const vy  = Math.sin(rad) * 0.5;

    engine.addSource(Math.round(gx), Math.round(gy), str, vx, vy);
  });
}

// ── 바람 파라미터 → GridEngine 반영 ──────────────────────────────────────────
function applyWind() {
  const rad = (params.windDir * Math.PI) / 180;
  engine.windX = Math.cos(rad) * params.windSpeed;
  engine.windY = Math.sin(rad) * params.windSpeed;
}

// ── 애니메이션 루프 ───────────────────────────────────────────────────────────
let simTime = 0;

function animate() {
  requestAnimationFrame(animate);

  applyWind();
  addVentSources();
  engine.step();
  updateParticles();

  simTime += engine.dt;

  // 최대 밀도 지수 평활
  let curMax = 0;
  for (let i = 0; i < engine.size; i++) {
    if (engine.density[i] > curMax) curMax = engine.density[i];
  }
  maxD = maxD * 0.95 + curMax * 0.05;

  // 캔버스 클리어
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawGridLines();
  drawBoundary();
  drawCells();
  drawArrows();
  drawVents(simTime);
  drawParticles();
}

// 지도 이동/줌 시 다시 그리기 — animate 루프가 매 프레임 그리므로 별도 핸들러 불필요
// (Leaflet은 tile 레이어를 DOM으로 처리하므로 canvas 재정렬은 자동)

animate();
