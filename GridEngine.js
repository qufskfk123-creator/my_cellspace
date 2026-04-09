/**
 * GridEngine.js
 * 32x32x32 3D Fluid Simulation (Jos Stam Navier-Stokes)
 * - Diffusion  : Gauss-Seidel linear solver
 * - Advection  : Semi-Lagrangian back-trace + trilinear interpolation
 * - Projection : Helmholtz decomposition (divergence-free enforcement)
 */

const N    = 32;
const SIZE = N * N * N;

export class GridEngine {
  constructor() {
    this.N    = N;
    this.size = SIZE;

    // Simulation parameters (tweakable via GUI)
    this.dt   = 0.016;
    this.diff = 0.00005;   // density diffusion
    this.visc = 0.00005;   // velocity viscosity

    // Density field
    this.density  = new Float32Array(SIZE);
    this.density0 = new Float32Array(SIZE);

    // Velocity field
    this.vx  = new Float32Array(SIZE);  this.vx0 = new Float32Array(SIZE);
    this.vy  = new Float32Array(SIZE);  this.vy0 = new Float32Array(SIZE);
    this.vz  = new Float32Array(SIZE);  this.vz0 = new Float32Array(SIZE);
  }

  // ── Flat index helper ─────────────────────────────────────────────────────
  IX(i, j, k) { return i + j * N + k * N * N; }

  // ── External API ──────────────────────────────────────────────────────────

  /** Inject density and velocity impulse at grid cell (x,y,z). */
  addSource(x, y, z, d, ax, ay, az) {
    x = x | 0;  y = y | 0;  z = z | 0;
    if (x < 1 || x >= N - 1 || y < 1 || y >= N - 1 || z < 1 || z >= N - 1) return;
    const idx = this.IX(x, y, z);
    this.density[idx] = Math.min(this.density[idx] + d, 60);
    this.vx[idx] += ax;
    this.vy[idx] += ay;
    this.vz[idx] += az;
  }

  /** Advance simulation by one time-step. */
  step() {
    const { diff, visc } = this;

    // ── Velocity step ──────────────────────────────────────────────────────
    // 1. Diffuse each component into *0 buffers
    this._diffuse(1, this.vx0, this.vx, visc);
    this._diffuse(2, this.vy0, this.vy, visc);
    this._diffuse(3, this.vz0, this.vz, visc);

    // 2. Project diffused field (vx0/vy0/vz0) to be divergence-free
    //    using vx/vy as scratch buffers for pressure & divergence
    this._project(this.vx0, this.vy0, this.vz0, this.vx, this.vy);

    // 3. Advect each component using the divergence-free diffused field
    this._advect(1, this.vx, this.vx0, this.vx0, this.vy0, this.vz0);
    this._advect(2, this.vy, this.vy0, this.vx0, this.vy0, this.vz0);
    this._advect(3, this.vz, this.vz0, this.vx0, this.vy0, this.vz0);

    // 4. Project advected field again
    this._project(this.vx, this.vy, this.vz, this.vx0, this.vy0);

    // ── Density step ───────────────────────────────────────────────────────
    this._diffuse(0, this.density0, this.density, diff);
    this._advect(0, this.density, this.density0, this.vx, this.vy, this.vz);

    // ── Natural decay ──────────────────────────────────────────────────────
    for (let i = 0; i < SIZE; i++) {
      this.density[i] *= 0.995;
      this.vx[i]      *= 0.997;
      this.vy[i]      *= 0.997;
      this.vz[i]      *= 0.997;
    }
  }

  /**
   * Sum density along the Y axis for each (X, Z) column.
   * Returns Float32Array of length N*N indexed as [x + z*N].
   * Used by Visualizer to drive column heights (deck.gl GridLayer style).
   */
  getColumnDensity() {
    const cols = new Float32Array(N * N);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        let sum = 0;
        for (let y = 0; y < N; y++) sum += this.density[this.IX(x, y, z)];
        cols[x + z * N] = sum;
      }
    }
    return cols;
  }

  /**
   * Trilinear-interpolated velocity at fractional grid position (px, py, pz).
   * Returns [vx, vy, vz].  Used to advect flow particles.
   */
  getVelocityAt(px, py, pz) {
    px = Math.max(0.5, Math.min(N - 1.5, px));
    py = Math.max(0.5, Math.min(N - 1.5, py));
    pz = Math.max(0.5, Math.min(N - 1.5, pz));

    const i0 = px | 0, i1 = i0 + 1;
    const j0 = py | 0, j1 = j0 + 1;
    const k0 = pz | 0, k1 = k0 + 1;
    const sx1 = px - i0, sx0 = 1 - sx1;
    const sy1 = py - j0, sy0 = 1 - sy1;
    const sz1 = pz - k0, sz0 = 1 - sz1;

    const tri = (f) =>
      sx0 * (sy0 * (sz0 * f[this.IX(i0,j0,k0)] + sz1 * f[this.IX(i0,j0,k1)]) +
             sy1 * (sz0 * f[this.IX(i0,j1,k0)] + sz1 * f[this.IX(i0,j1,k1)])) +
      sx1 * (sy0 * (sz0 * f[this.IX(i1,j0,k0)] + sz1 * f[this.IX(i1,j0,k1)]) +
             sy1 * (sz0 * f[this.IX(i1,j1,k0)] + sz1 * f[this.IX(i1,j1,k1)]));

    return [tri(this.vx), tri(this.vy), tri(this.vz)];
  }

  // ── Internal physics ──────────────────────────────────────────────────────

  _diffuse(b, x, x0, diff) {
    const a = this.dt * diff * (N - 2) * (N - 2);
    this._linSolve(b, x, x0, a, 1 + 6 * a);
  }

  /** Gauss-Seidel relaxation to solve the diffusion linear system. */
  _linSolve(b, x, x0, a, c) {
    const cRecip = 1.0 / c;
    for (let iter = 0; iter < 4; iter++) {
      for (let k = 1; k < N - 1; k++) {
        for (let j = 1; j < N - 1; j++) {
          for (let i = 1; i < N - 1; i++) {
            x[this.IX(i,j,k)] = (
              x0[this.IX(i,j,k)] + a * (
                x[this.IX(i+1,j,k)] + x[this.IX(i-1,j,k)] +
                x[this.IX(i,j+1,k)] + x[this.IX(i,j-1,k)] +
                x[this.IX(i,j,k+1)] + x[this.IX(i,j,k-1)]
              )
            ) * cRecip;
          }
        }
      }
      this._setBnd(b, x);
    }
  }

  /**
   * Helmholtz-Hodge decomposition: make (vx, vy, vz) divergence-free.
   * p and div are scratch buffers.
   */
  _project(vx, vy, vz, p, div) {
    // Compute divergence
    for (let k = 1; k < N - 1; k++) {
      for (let j = 1; j < N - 1; j++) {
        for (let i = 1; i < N - 1; i++) {
          div[this.IX(i,j,k)] = -0.5 * (
            vx[this.IX(i+1,j,k)] - vx[this.IX(i-1,j,k)] +
            vy[this.IX(i,j+1,k)] - vy[this.IX(i,j-1,k)] +
            vz[this.IX(i,j,k+1)] - vz[this.IX(i,j,k-1)]
          ) / N;
          p[this.IX(i,j,k)] = 0;
        }
      }
    }
    this._setBnd(0, div);
    this._setBnd(0, p);

    // Solve Poisson equation: ∇²p = div
    this._linSolve(0, p, div, 1, 6);

    // Subtract pressure gradient from velocity
    for (let k = 1; k < N - 1; k++) {
      for (let j = 1; j < N - 1; j++) {
        for (let i = 1; i < N - 1; i++) {
          vx[this.IX(i,j,k)] -= 0.5 * N * (p[this.IX(i+1,j,k)] - p[this.IX(i-1,j,k)]);
          vy[this.IX(i,j,k)] -= 0.5 * N * (p[this.IX(i,j+1,k)] - p[this.IX(i,j-1,k)]);
          vz[this.IX(i,j,k)] -= 0.5 * N * (p[this.IX(i,j,k+1)] - p[this.IX(i,j,k-1)]);
        }
      }
    }
    this._setBnd(1, vx);
    this._setBnd(2, vy);
    this._setBnd(3, vz);
  }

  /** Semi-Lagrangian back-trace advection with trilinear interpolation. */
  _advect(b, d, d0, vx, vy, vz) {
    const dt0 = this.dt * (N - 2);
    for (let k = 1; k < N - 1; k++) {
      for (let j = 1; j < N - 1; j++) {
        for (let i = 1; i < N - 1; i++) {
          let x = i - dt0 * vx[this.IX(i,j,k)];
          let y = j - dt0 * vy[this.IX(i,j,k)];
          let z = k - dt0 * vz[this.IX(i,j,k)];

          x = Math.max(0.5, Math.min(N - 1.5, x));
          y = Math.max(0.5, Math.min(N - 1.5, y));
          z = Math.max(0.5, Math.min(N - 1.5, z));

          const i0 = x | 0, i1 = i0 + 1;
          const j0 = y | 0, j1 = j0 + 1;
          const k0 = z | 0, k1 = k0 + 1;
          const sx1 = x - i0, sx0 = 1 - sx1;
          const sy1 = y - j0, sy0 = 1 - sy1;
          const sz1 = z - k0, sz0 = 1 - sz1;

          d[this.IX(i,j,k)] =
            sx0 * (sy0 * (sz0 * d0[this.IX(i0,j0,k0)] + sz1 * d0[this.IX(i0,j0,k1)]) +
                   sy1 * (sz0 * d0[this.IX(i0,j1,k0)] + sz1 * d0[this.IX(i0,j1,k1)])) +
            sx1 * (sy0 * (sz0 * d0[this.IX(i1,j0,k0)] + sz1 * d0[this.IX(i1,j0,k1)]) +
                   sy1 * (sz0 * d0[this.IX(i1,j1,k0)] + sz1 * d0[this.IX(i1,j1,k1)]));
        }
      }
    }
    this._setBnd(b, d);
  }

  /** Enforce boundary conditions: zero-normal-flow walls. */
  _setBnd(b, x) {
    // ── Faces ─────────────────────────────────────────────────────────────
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        x[this.IX(i,j,0)]   = b === 3 ? -x[this.IX(i,j,1)]   : x[this.IX(i,j,1)];
        x[this.IX(i,j,N-1)] = b === 3 ? -x[this.IX(i,j,N-2)] : x[this.IX(i,j,N-2)];
      }
    }
    for (let k = 1; k < N - 1; k++) {
      for (let i = 1; i < N - 1; i++) {
        x[this.IX(i,0,k)]   = b === 2 ? -x[this.IX(i,1,k)]   : x[this.IX(i,1,k)];
        x[this.IX(i,N-1,k)] = b === 2 ? -x[this.IX(i,N-2,k)] : x[this.IX(i,N-2,k)];
      }
    }
    for (let k = 1; k < N - 1; k++) {
      for (let j = 1; j < N - 1; j++) {
        x[this.IX(0,j,k)]   = b === 1 ? -x[this.IX(1,j,k)]   : x[this.IX(1,j,k)];
        x[this.IX(N-1,j,k)] = b === 1 ? -x[this.IX(N-2,j,k)] : x[this.IX(N-2,j,k)];
      }
    }

    // ── Corners (average of the three adjacent face values) ────────────────
    x[this.IX(0,0,0)]         = (x[this.IX(1,0,0)]       + x[this.IX(0,1,0)]       + x[this.IX(0,0,1)])       / 3;
    x[this.IX(N-1,0,0)]       = (x[this.IX(N-2,0,0)]     + x[this.IX(N-1,1,0)]     + x[this.IX(N-1,0,1)])     / 3;
    x[this.IX(0,N-1,0)]       = (x[this.IX(1,N-1,0)]     + x[this.IX(0,N-2,0)]     + x[this.IX(0,N-1,1)])     / 3;
    x[this.IX(N-1,N-1,0)]     = (x[this.IX(N-2,N-1,0)]   + x[this.IX(N-1,N-2,0)]   + x[this.IX(N-1,N-1,1)])   / 3;
    x[this.IX(0,0,N-1)]       = (x[this.IX(1,0,N-1)]     + x[this.IX(0,1,N-1)]     + x[this.IX(0,0,N-2)])     / 3;
    x[this.IX(N-1,0,N-1)]     = (x[this.IX(N-2,0,N-1)]   + x[this.IX(N-1,1,N-1)]   + x[this.IX(N-1,0,N-2)])   / 3;
    x[this.IX(0,N-1,N-1)]     = (x[this.IX(1,N-1,N-1)]   + x[this.IX(0,N-2,N-1)]   + x[this.IX(0,N-1,N-2)])   / 3;
    x[this.IX(N-1,N-1,N-1)]   = (x[this.IX(N-2,N-1,N-1)] + x[this.IX(N-1,N-2,N-1)] + x[this.IX(N-1,N-1,N-2)]) / 3;
  }
}
