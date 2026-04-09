/**
 * SpatialGrid.js — 2D Navier-Stokes 유체 시뮬레이터
 *
 * constructor(n) 로 격자 해상도 설정 가능 (기본 32×32).
 * app.js에서 new SpatialGrid(N_RESOLUTION) 형태로 생성.
 *
 * 바람 주입 규칙:
 *   windX > 0  동쪽 이동    windX < 0  서쪽 이동
 *   windY > 0  화면 아래(남쪽) 이동   windY < 0  화면 위(북쪽) 이동
 *
 * Open-Meteo wind_direction_10m → windX/Y 변환:
 *   movRad = ((metDeg + 180) % 360) × π/180
 *   windX  =  sin(movRad) × simSpeed
 *   windY  = -cos(movRad) × simSpeed
 */

export class SpatialGrid {
  /**
   * @param {number} n 격자 한 변의 셀 수 (기본 32).
   *                   app.js의 N_RESOLUTION 상수로 제어.
   */
  constructor(n = 32) {
    this.N    = n;
    this.size = n * n;

    this.dt   = 0.016;
    this.diff = 0.00008;
    this.visc = 0.00006;

    this.windX = 1.0;
    this.windY = 0.0;

    const s = this.size;
    this.density  = new Float32Array(s);
    this.density0 = new Float32Array(s);
    this.vx  = new Float32Array(s);
    this.vx0 = new Float32Array(s);
    this.vy  = new Float32Array(s);
    this.vy0 = new Float32Array(s);

    console.log(`[SpatialGrid] 초기화 N=${n} (${n}×${n} = ${s} cells)`);
  }

  IX(i, j) { return i + j * this.N; }

  addSource(gx, gy, density, vx = 0, vy = 0) {
    const N = this.N;
    gx = gx | 0; gy = gy | 0;
    if (gx < 1 || gx >= N - 1 || gy < 1 || gy >= N - 1) return;
    const idx = this.IX(gx, gy);
    this.density[idx] = Math.min(this.density[idx] + density, 80);
    this.vx[idx] += vx;
    this.vy[idx] += vy;
  }

  reset() {
    this.density.fill(0);  this.density0.fill(0);
    this.vx.fill(0);       this.vx0.fill(0);
    this.vy.fill(0);       this.vy0.fill(0);
  }

  step() {
    const wf = this.dt * 0.08;
    const s  = this.size;
    for (let i = 0; i < s; i++) {
      this.vx[i] += this.windX * wf;
      this.vy[i] += this.windY * wf;
    }

    this._diffuse(1, this.vx0, this.vx, this.visc);
    this._diffuse(2, this.vy0, this.vy, this.visc);
    this._project(this.vx0, this.vy0, this.vx, this.vy);
    this._advect(1, this.vx, this.vx0, this.vx0, this.vy0);
    this._advect(2, this.vy, this.vy0, this.vx0, this.vy0);
    this._project(this.vx, this.vy, this.vx0, this.vy0);

    this._diffuse(0, this.density0, this.density, this.diff);
    this._advect(0, this.density, this.density0, this.vx, this.vy);

    for (let i = 0; i < s; i++) {
      this.density[i] *= 0.994;
      this.vx[i]      *= 0.972;
      this.vy[i]      *= 0.972;
    }
  }

  getVelocityAt(px, py) {
    const N = this.N;
    px = Math.max(0.5, Math.min(N - 1.5, px));
    py = Math.max(0.5, Math.min(N - 1.5, py));
    const i0 = px | 0, i1 = i0 + 1, j0 = py | 0, j1 = j0 + 1;
    const sx1 = px - i0, sx0 = 1 - sx1, sy1 = py - j0, sy0 = 1 - sy1;
    const b = f =>
      sx0 * (sy0 * f[this.IX(i0, j0)] + sy1 * f[this.IX(i0, j1)]) +
      sx1 * (sy0 * f[this.IX(i1, j0)] + sy1 * f[this.IX(i1, j1)]);
    return [b(this.vx), b(this.vy)];
  }

  getDensityAt(px, py) {
    const N = this.N;
    px = Math.max(0.5, Math.min(N - 1.5, px));
    py = Math.max(0.5, Math.min(N - 1.5, py));
    const i0 = px | 0, i1 = i0 + 1, j0 = py | 0, j1 = j0 + 1;
    const sx1 = px - i0, sx0 = 1 - sx1, sy1 = py - j0, sy0 = 1 - sy1;
    return (
      sx0 * (sy0 * this.density[this.IX(i0, j0)] + sy1 * this.density[this.IX(i0, j1)]) +
      sx1 * (sy0 * this.density[this.IX(i1, j0)] + sy1 * this.density[this.IX(i1, j1)])
    );
  }

  // ── 내부 솔버 ──────────────────────────────────────────────────────────────

  _diffuse(b, x, x0, diff) {
    const a = this.dt * diff * (this.N - 2) * (this.N - 2);
    this._linSolve(b, x, x0, a, 1 + 4 * a);
  }

  _linSolve(b, x, x0, a, c) {
    const N = this.N;
    const cR = 1.0 / c;
    for (let iter = 0; iter < 4; iter++) {
      for (let j = 1; j < N - 1; j++) {
        for (let i = 1; i < N - 1; i++) {
          x[this.IX(i, j)] = (x0[this.IX(i, j)] + a * (
            x[this.IX(i+1, j)] + x[this.IX(i-1, j)] +
            x[this.IX(i, j+1)] + x[this.IX(i, j-1)]
          )) * cR;
        }
      }
      this._setBnd(b, x);
    }
  }

  _project(vx, vy, p, div) {
    const N = this.N;
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        div[this.IX(i, j)] = -0.5 * (
          vx[this.IX(i+1, j)] - vx[this.IX(i-1, j)] +
          vy[this.IX(i, j+1)] - vy[this.IX(i, j-1)]
        ) / N;
        p[this.IX(i, j)] = 0;
      }
    }
    this._setBnd(0, div); this._setBnd(0, p);
    this._linSolve(0, p, div, 1, 4);
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        vx[this.IX(i, j)] -= 0.5 * N * (p[this.IX(i+1, j)] - p[this.IX(i-1, j)]);
        vy[this.IX(i, j)] -= 0.5 * N * (p[this.IX(i, j+1)] - p[this.IX(i, j-1)]);
      }
    }
    this._setBnd(1, vx); this._setBnd(2, vy);
  }

  _advect(b, d, d0, vx, vy) {
    const N   = this.N;
    const dt0 = this.dt * (N - 2);
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const x = Math.max(0.5, Math.min(N - 1.5, i - dt0 * vx[this.IX(i, j)]));
        const y = Math.max(0.5, Math.min(N - 1.5, j - dt0 * vy[this.IX(i, j)]));
        const i0 = x|0, i1 = i0+1, j0 = y|0, j1 = j0+1;
        const sx1 = x-i0, sx0 = 1-sx1, sy1 = y-j0, sy0 = 1-sy1;
        d[this.IX(i, j)] =
          sx0 * (sy0 * d0[this.IX(i0, j0)] + sy1 * d0[this.IX(i0, j1)]) +
          sx1 * (sy0 * d0[this.IX(i1, j0)] + sy1 * d0[this.IX(i1, j1)]);
      }
    }
    this._setBnd(b, d);
  }

  _setBnd(b, x) {
    const N = this.N;
    for (let i = 1; i < N - 1; i++) {
      x[this.IX(i, 0)]     = b === 2 ? -x[this.IX(i, 1)]     : x[this.IX(i, 1)];
      x[this.IX(i, N - 1)] = b === 2 ? -x[this.IX(i, N - 2)] : x[this.IX(i, N - 2)];
    }
    for (let j = 1; j < N - 1; j++) {
      x[this.IX(0, j)]     = b === 1 ? -x[this.IX(1, j)]     : x[this.IX(1, j)];
      x[this.IX(N - 1, j)] = b === 1 ? -x[this.IX(N - 2, j)] : x[this.IX(N - 2, j)];
    }
    x[this.IX(0, 0)]     = 0.5 * (x[this.IX(1, 0)]   + x[this.IX(0, 1)]);
    x[this.IX(N-1, 0)]   = 0.5 * (x[this.IX(N-2, 0)] + x[this.IX(N-1, 1)]);
    x[this.IX(0, N-1)]   = 0.5 * (x[this.IX(1, N-1)] + x[this.IX(0, N-2)]);
    x[this.IX(N-1, N-1)] = 0.5 * (x[this.IX(N-2, N-1)] + x[this.IX(N-1, N-2)]);
  }
}
