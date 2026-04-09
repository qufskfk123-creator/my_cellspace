/**
 * Visualizer.js
 * deck.gl-style 3D renderer using Three.js
 *
 * Grid Extrusion  : InstancedMesh — each XZ column scales in Y by column density
 * Dynamic Coloring: Indigo → Cyan → Yellow → Orange interpolation per column
 * Flow Particles  : 3 000 points following the velocity field with TRAIL_LENGTH trail segments
 * GUI             : lil-gui (loaded globally as `lil`) controls diff / flow / opacity
 */

import * as THREE          from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';

// ── Constants ────────────────────────────────────────────────────────────────
const N              = 32;
const HALF           = N / 2;
const CELL_SIZE      = 1.0;
const MAX_HEIGHT     = 14;          // world-units, tallest possible column

const PARTICLE_COUNT = 3000;
const TRAIL_LENGTH   = 12;          // segments per particle
const TOTAL_TRAIL_PTS = PARTICLE_COUNT * TRAIL_LENGTH;

// ── Color palette (Indigo → Cyan → Yellow → Orange) ─────────────────────────
const COLOR_STOPS = [
  new THREE.Color(0x3300cc),  // Indigo
  new THREE.Color(0x00eeff),  // Cyan
  new THREE.Color(0xffee00),  // Yellow
  new THREE.Color(0xff5500),  // Orange
];

function lerpColor(t) {
  t = Math.max(0, Math.min(1, t));
  const s   = t * (COLOR_STOPS.length - 1);
  const idx = Math.min(Math.floor(s), COLOR_STOPS.length - 2);
  return new THREE.Color().lerpColors(COLOR_STOPS[idx], COLOR_STOPS[idx + 1], s - idx);
}

// ── Coordinate helpers ────────────────────────────────────────────────────────
// Grid space → World space
const gToWx = (gx) => (gx - HALF) * CELL_SIZE;
const gToWy = (gy) => (gy / N)    * MAX_HEIGHT;
const gToWz = (gz) => (gz - HALF) * CELL_SIZE;

// ═════════════════════════════════════════════════════════════════════════════
export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;

    // Shared GUI-controlled params (read by both this and main.js)
    this.params = {
      diffusionRate: 0.00005,
      flowStrength:  10,
      gridOpacity:   0.88,
    };

    this._dummy = new THREE.Object3D();

    this._initRenderer();
    this._initScene();
    this._initLights();
    this._initGrid();
    this._initParticles();
    this._initCamera();
    this._initControls();
    this._initResize();
  }

  // ── Renderer ───────────────────────────────────────────────────────────────
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas:    this.canvas,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0a0a0a, 1);
  }

  // ── Scene ──────────────────────────────────────────────────────────────────
  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0a0a0a, 0.010);
  }

  // ── Lighting ───────────────────────────────────────────────────────────────
  _initLights() {
    // Soft fill
    this.scene.add(new THREE.AmbientLight(0x223355, 1.4));

    // Key — top-center blue
    const key = new THREE.PointLight(0x4488ff, 4, 80);
    key.position.set(0, 28, 0);
    this.scene.add(key);

    // Side — warm orange
    const side = new THREE.PointLight(0xff7700, 2, 60);
    side.position.set(N * 0.5, 10, N * 0.5);
    this.scene.add(side);

    // Rim — cool teal
    const rim = new THREE.PointLight(0x00ffaa, 1.2, 50);
    rim.position.set(-N * 0.4, 8, -N * 0.4);
    this.scene.add(rim);
  }

  // ── Grid (InstancedMesh) ───────────────────────────────────────────────────
  _initGrid() {
    // Dark ground plane
    const planeGeo = new THREE.PlaneGeometry(N * 1.4, N * 1.4);
    const planeMat = new THREE.MeshBasicMaterial({ color: 0x04040e });
    const plane    = new THREE.Mesh(planeGeo, planeMat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.02;
    this.scene.add(plane);

    // Subtle grid lines
    const gridHelper = new THREE.GridHelper(N * CELL_SIZE, N, 0x151530, 0x0e0e1e);
    gridHelper.position.y = -0.01;
    this.scene.add(gridHelper);

    // Column geometry: unit-height box, scaled per instance
    const geo = new THREE.BoxGeometry(CELL_SIZE * 0.84, 1, CELL_SIZE * 0.84);
    const mat = new THREE.MeshPhongMaterial({
      transparent: true,
      opacity:     this.params.gridOpacity,
      shininess:   110,
      specular:    new THREE.Color(0x223366),
    });

    this.gridMesh = new THREE.InstancedMesh(geo, mat, N * N);
    this.gridMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.gridMesh);

    // Initialise all instances flat on the ground
    const initColor = new THREE.Color(0x3300cc);
    for (let i = 0; i < N * N; i++) {
      this._dummy.position.set(0, 0.001, 0);
      this._dummy.scale.set(1, 0.002, 1);
      this._dummy.updateMatrix();
      this.gridMesh.setMatrixAt(i, this._dummy.matrix);
      this.gridMesh.setColorAt(i, initColor);
    }
    this.gridMesh.instanceMatrix.needsUpdate = true;
    this.gridMesh.instanceColor.needsUpdate  = true;
  }

  // ── Flow Particles with Trails ─────────────────────────────────────────────
  _initParticles() {
    // Flat Float32Array: particle grid-space positions [gx, gy, gz, ...]
    this._pGPos = new Float32Array(PARTICLE_COUNT * 3);

    const trailPos = new Float32Array(TOTAL_TRAIL_PTS * 3);
    const trailCol = new Float32Array(TOTAL_TRAIL_PTS * 3);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const pi = i * 3;
      const gx = Math.random() * (N - 2) + 1;
      const gy = Math.random() * (N - 2) + 1;
      const gz = Math.random() * (N - 2) + 1;
      this._pGPos[pi]   = gx;
      this._pGPos[pi+1] = gy;
      this._pGPos[pi+2] = gz;

      const wx = gToWx(gx), wy = gToWy(gy), wz = gToWz(gz);

      for (let t = 0; t < TRAIL_LENGTH; t++) {
        const b = (i * TRAIL_LENGTH + t) * 3;
        trailPos[b]   = wx;
        trailPos[b+1] = wy;
        trailPos[b+2] = wz;
        // Head is bright, tail fades to zero
        const fade      = Math.pow(1 - t / TRAIL_LENGTH, 2);
        trailCol[b]   = fade * 0.15;
        trailCol[b+1] = fade * 0.90;
        trailCol[b+2] = fade * 1.00;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(trailCol, 3));

    const mat = new THREE.PointsMaterial({
      size:            0.20,
      vertexColors:    true,
      transparent:     true,
      opacity:         0.95,
      blending:        THREE.AdditiveBlending,
      depthWrite:      false,
      sizeAttenuation: true,
    });

    this.particles = new THREE.Points(geo, mat);
    this.scene.add(this.particles);
  }

  // ── Camera ─────────────────────────────────────────────────────────────────
  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 300);
    this.camera.position.set(N * 0.9, N * 0.65, N * 0.9);
    this.camera.lookAt(0, 4, 0);
  }

  // ── OrbitControls ──────────────────────────────────────────────────────────
  _initControls() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping  = true;
    this.controls.dampingFactor  = 0.06;
    this.controls.target.set(0, 4, 0);
    this.controls.minDistance    = 8;
    this.controls.maxDistance    = 130;
    this.controls.maxPolarAngle  = Math.PI * 0.47;
  }

  // ── Resize ─────────────────────────────────────────────────────────────────
  _initResize() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ── lil-gui ────────────────────────────────────────────────────────────────
  /**
   * @param {GridEngine} engine  – reference so GUI can write engine.diff
   */
  setupGUI(engine) {
    /* global lil */
    const gui = new lil.GUI({ title: '⚙ Fluid Controls', width: 220 });

    gui.add(this.params, 'diffusionRate', 0.000005, 0.0006, 0.000005)
       .name('확산 속도')
       .onChange(v => { engine.diff = v; });

    gui.add(this.params, 'flowStrength', 1, 35, 0.5)
       .name('기류 강도');

    gui.add(this.params, 'gridOpacity', 0.05, 1.0, 0.01)
       .name('격자 투명도')
       .onChange(v => { this.gridMesh.material.opacity = v; });

    return gui;
  }

  // ── Per-frame update ────────────────────────────────────────────────────────
  update(engine) {
    this._updateGrid(engine);
    this._updateParticles(engine);
  }

  _updateGrid(engine) {
    const cols = engine.getColumnDensity();

    // Normalise against running maximum so colours always span full range
    let maxD = 0.001;
    for (let i = 0; i < N * N; i++) if (cols[i] > maxD) maxD = cols[i];

    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const ci     = x + z * N;
        const t      = Math.min(cols[ci] / maxD, 1.0);
        const height = Math.max(0.003, t * MAX_HEIGHT);

        // Position: centre of cell, half-height above ground
        this._dummy.position.set(
          (x - HALF + 0.5) * CELL_SIZE,
          height * 0.5,
          (z - HALF + 0.5) * CELL_SIZE
        );
        // Scale: Y stretches the unit-height box
        this._dummy.scale.set(1, height, 1);
        this._dummy.updateMatrix();

        this.gridMesh.setMatrixAt(ci, this._dummy.matrix);
        this.gridMesh.setColorAt(ci, lerpColor(t));
      }
    }

    this.gridMesh.instanceMatrix.needsUpdate = true;
    this.gridMesh.instanceColor.needsUpdate  = true;
  }

  _updateParticles(engine) {
    const geo   = this.particles.geometry;
    const pos   = geo.attributes.position.array;
    const col   = geo.attributes.color.array;
    const speed = this.params.flowStrength * 0.045;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const pi = i * 3;
      let gx = this._pGPos[pi];
      let gy = this._pGPos[pi+1];
      let gz = this._pGPos[pi+2];

      const [vx, vy, vz] = engine.getVelocityAt(gx, gy, gz);

      const ngx = gx + vx * speed;
      const ngy = gy + vy * speed;
      const ngz = gz + vz * speed;

      // Respawn if particle escapes the grid interior
      const oob = ngx < 1 || ngx >= N-1 || ngy < 1 || ngy >= N-1 || ngz < 1 || ngz >= N-1;
      if (oob) {
        const rx = Math.random() * (N - 2) + 1;
        const ry = Math.random() * (N - 2) + 1;
        const rz = Math.random() * (N - 2) + 1;
        this._pGPos[pi]   = rx;
        this._pGPos[pi+1] = ry;
        this._pGPos[pi+2] = rz;

        // Collapse the entire trail to the respawn position
        const wx = gToWx(rx), wy = gToWy(ry), wz = gToWz(rz);
        for (let t = 0; t < TRAIL_LENGTH; t++) {
          const b = (i * TRAIL_LENGTH + t) * 3;
          pos[b] = wx;  pos[b+1] = wy;  pos[b+2] = wz;
        }
        continue;
      }

      // Shift trail: index 0 = head (newest), TRAIL_LENGTH-1 = tail (oldest)
      for (let t = TRAIL_LENGTH - 1; t > 0; t--) {
        const dst = (i * TRAIL_LENGTH + t) * 3;
        const src = dst - 3;
        pos[dst]   = pos[src];
        pos[dst+1] = pos[src+1];
        pos[dst+2] = pos[src+2];
      }

      // Write new head in world space
      const headBase    = i * TRAIL_LENGTH * 3;
      pos[headBase]   = gToWx(ngx);
      pos[headBase+1] = gToWy(ngy);
      pos[headBase+2] = gToWz(ngz);

      // Update particle grid position
      this._pGPos[pi]   = ngx;
      this._pGPos[pi+1] = ngy;
      this._pGPos[pi+2] = ngz;

      // Update trail colours — hue shifts with velocity magnitude
      const mag = Math.min(Math.sqrt(vx*vx + vy*vy + vz*vz) * 1.5, 1.0);
      for (let t = 0; t < TRAIL_LENGTH; t++) {
        const cb   = (i * TRAIL_LENGTH + t) * 3;
        const fade = Math.pow(1 - t / TRAIL_LENGTH, 1.8);
        // Slow = cool cyan, fast = warm yellow-white
        col[cb]   = fade * (0.10 + mag * 0.70);  // R
        col[cb+1] = fade * (0.85 + mag * 0.10);  // G
        col[cb+2] = fade * (1.00 - mag * 0.55);  // B
      }
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate    = true;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
