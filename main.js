/**
 * main.js
 * Entry point — wires GridEngine + Visualizer together and runs the loop.
 *
 * Interactions:
 *   Mouse drag   → inject density + velocity into the fluid
 *   Scroll / RMB → OrbitControls zoom / pan (handled by Visualizer)
 *   GUI          → top-right panel, created inside Visualizer.setupGUI()
 *
 * Auto-animation: two counter-rotating vortex sources keep the fluid alive
 * even without user input.
 */

import * as THREE        from 'three';
import { GridEngine }    from './GridEngine.js';
import { Visualizer }    from './Visualizer.js';

// ── Init ─────────────────────────────────────────────────────────────────────
const canvas     = document.getElementById('canvas');
const engine     = new GridEngine();
const visualizer = new Visualizer(canvas);

visualizer.setupGUI(engine);

// ── Mouse / Touch interaction ─────────────────────────────────────────────────
const raycaster   = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);  // y = 0
const hitPoint    = new THREE.Vector3();

const pointer = { active: false, ndcX: 0, ndcY: 0, prevNdcX: 0, prevNdcY: 0 };

function onPointerMove(clientX, clientY) {
  pointer.prevNdcX = pointer.ndcX;
  pointer.prevNdcY = pointer.ndcY;
  pointer.ndcX =  (clientX / window.innerWidth)  * 2 - 1;
  pointer.ndcY = -(clientY / window.innerHeight) * 2 + 1;

  if (!pointer.active) return;
  injectAtCursor();
}

function injectAtCursor() {
  raycaster.setFromCamera({ x: pointer.ndcX, y: pointer.ndcY }, visualizer.camera);
  if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return;

  const N    = engine.N;
  const HALF = N / 2;
  const gx   = Math.round(hitPoint.x + HALF);
  const gz   = Math.round(hitPoint.z + HALF);
  const gy   = Math.floor(N * 0.30);          // inject near the bottom third

  const strength = visualizer.params.flowStrength;
  const dvx = (pointer.ndcX - pointer.prevNdcX) * strength * 3;
  const dvz = (pointer.ndcY - pointer.prevNdcY) * strength * 3;

  // Paint a 5×5 cross in Y to create a visible plume
  for (let dj = -2; dj <= 2; dj++) {
    for (let di = -2; di <= 2; di++) {
      engine.addSource(
        gx + di, gy + dj, gz + di,
        5.0,
        dvx,
        Math.max(0, Math.abs(dvx + dvz)) * 0.4 + 0.6,  // always some upward push
        dvz
      );
    }
  }
}

// Mouse
canvas.addEventListener('mousemove',  (e) => onPointerMove(e.clientX, e.clientY));
canvas.addEventListener('mousedown',  () => { pointer.active = true; });
canvas.addEventListener('mouseup',    () => { pointer.active = false; });
canvas.addEventListener('mouseleave', () => { pointer.active = false; });

// Touch
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });
canvas.addEventListener('touchstart', () => { pointer.active = true; });
canvas.addEventListener('touchend',   () => { pointer.active = false; });

// ── Auto-animation ────────────────────────────────────────────────────────────
/**
 * Two counter-rotating vortex sources orbit the grid centre, keeping the
 * fluid in continuous motion without any user interaction.
 * A third source fires random vertical bursts at low probability.
 */
let autoTime = 0;

function addAutoSources() {
  const N    = engine.N;
  const HALF = N / 2;
  autoTime  += engine.dt;

  // ── Primary orbit (clockwise, large radius) ───────────────────────────────
  const r1  = N * 0.28;
  const a1  = autoTime * 0.40;
  const cx1 = HALF + Math.cos(a1) * r1;
  const cz1 = HALF + Math.sin(a1) * r1;
  engine.addSource(
    cx1, Math.floor(N * 0.22), cz1,
    2.2,
    -Math.sin(a1) * 5,   // tangential velocity
    2.8,
     Math.cos(a1) * 5
  );

  // ── Secondary orbit (counter-clockwise, smaller radius) ───────────────────
  const r2  = N * 0.16;
  const a2  = -autoTime * 0.55 + Math.PI;
  const cx2 = HALF + Math.cos(a2) * r2;
  const cz2 = HALF + Math.sin(a2) * r2;
  engine.addSource(
    cx2, Math.floor(N * 0.45), cz2,
    1.6,
     Math.sin(a2) * 4,
    1.8,
    -Math.cos(a2) * 4
  );

  // ── Random upward burst (2 % chance per frame) ────────────────────────────
  if (Math.random() < 0.02) {
    engine.addSource(
      Math.floor(Math.random() * (N - 4) + 2),
      Math.floor(N * 0.12),
      Math.floor(Math.random() * (N - 4) + 2),
      10.0, 0, 6, 0
    );
  }
}

// ── Animation loop ────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  addAutoSources();
  engine.step();
  visualizer.update(engine);
  visualizer.render();
}

animate();
