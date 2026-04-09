/**
 * ParticleEngine.js — Wind-demo 스타일 입자 추적기
 *
 * 수천 개의 입자가 환기구에서 생성돼 바람 + 유체 속도장을 따라 흐릅니다.
 * 렌더링은 app.js에서 flat typed array(x, y, px, py, spd)를 직접 읽어 처리합니다.
 *
 * 좌표계: 격자 좌표 (0 ~ N). SpatialGrid와 동일한 N 사용.
 */

export class ParticleEngine {
  /**
   * @param {object} opts
   * @param {number} [opts.count=5000]  입자 수
   * @param {number} [opts.N=64]        격자 해상도 (SpatialGrid N과 일치)
   */
  constructor({ count = 5000, N = 64 } = {}) {
    this.N     = N;
    this.count = count;

    // 현재/이전 위치 (격자 좌표) — 트레일 선분 그리기에 사용
    this.x   = new Float32Array(count);
    this.y   = new Float32Array(count);
    this.px  = new Float32Array(count);
    this.py  = new Float32Array(count);

    // 수명
    this.age  = new Float32Array(count);
    this.life = new Float32Array(count);

    // 속도 크기 — 색상 매핑용
    this.spd  = new Float32Array(count);

    // 기본 바람 (Open-Meteo → 격자 단위로 변환된 값)
    this.windX = 0;
    this.windY = 0;

    // 환기구 (생성 지점)
    this.ventGx  = N / 2;
    this.ventGy  = N / 2;
    this.ventSet = false;  // setVent() 호출 전까지 false

    // SpatialGrid 참조 (국소 난류 속도장)
    this.fluidGrid = null;

    // GUI에서 조절 가능한 속도 배율
    this.speedMult = 1.0;

    this._scatter();
  }

  // ── 내부 생성 헬퍼 ──────────────────────────────────────────────────────────

  /** 격자 전체에 무작위 분산 (초기화 / 환기구 미설정 상태) */
  _scatter() {
    const N = this.N;
    for (let i = 0; i < this.count; i++) {
      this.x[i] = this.px[i] = 1 + Math.random() * (N - 2);
      this.y[i] = this.py[i] = 1 + Math.random() * (N - 2);
      this.age[i]  = Math.random() * 220;  // 일제히 죽지 않도록 분산
      this.life[i] = 80 + Math.random() * 160;
      this.spd[i]  = 0;
    }
  }

  /** 환기구 위치에서 생성 */
  _spawnAtVent(i) {
    const j = 0.7;  // 생성 jitter 반경
    this.x[i] = this.px[i] = this.ventGx + (Math.random() - 0.5) * j;
    this.y[i] = this.py[i] = this.ventGy + (Math.random() - 0.5) * j;
    this.age[i]  = 0;
    this.life[i] = 50 + Math.random() * 210;
    this.spd[i]  = 0;
  }

  /** 격자 무작위 위치에서 생성 (환기구 미설정 시 폴백) */
  _spawnRandom(i) {
    const N = this.N;
    this.x[i] = this.px[i] = 1 + Math.random() * (N - 2);
    this.y[i] = this.py[i] = 1 + Math.random() * (N - 2);
    this.age[i]  = 0;
    this.life[i] = 80 + Math.random() * 160;
    this.spd[i]  = 0;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** 환기구 위치 설정 — 모든 입자를 해당 위치에서 재생성 */
  setVent(gx, gy) {
    this.ventGx  = Math.max(1, Math.min(this.N - 2, gx));
    this.ventGy  = Math.max(1, Math.min(this.N - 2, gy));
    this.ventSet = true;
    for (let i = 0; i < this.count; i++) this._spawnAtVent(i);
  }

  setWind(wx, wy)  { this.windX = wx; this.windY = wy; }
  setFluidGrid(g)  { this.fluidGrid = g; }

  reset() {
    this.ventSet = false;
    this._scatter();
  }

  /** 1 프레임 스텝 — 모든 입자 이동 */
  step() {
    const N  = this.N;
    const sm = this.speedMult;

    for (let i = 0; i < this.count; i++) {
      this.age[i]++;

      if (this.age[i] > this.life[i]) {
        this.ventSet ? this._spawnAtVent(i) : this._spawnRandom(i);
        continue;
      }

      // 이전 위치 저장 (트레일 선분용)
      this.px[i] = this.x[i];
      this.py[i] = this.y[i];

      // 속도 = 직접 바람 + 유체 난류 + 미세 노이즈
      let vx = this.windX * 0.30;
      let vy = this.windY * 0.30;

      if (this.fluidGrid) {
        const [fx, fy] = this.fluidGrid.getVelocityAt(this.x[i], this.y[i]);
        vx += fx * 2.8;
        vy += fy * 2.8;
      }

      // 미세 무작위 보행 (시각적 풍성함)
      vx += (Math.random() - 0.5) * 0.06;
      vy += (Math.random() - 0.5) * 0.06;

      this.spd[i] = Math.hypot(vx, vy);

      this.x[i] += vx * 0.58 * sm;
      this.y[i] += vy * 0.58 * sm;

      // 격자 범위 이탈 시 재생성
      if (this.x[i] < 0.5 || this.x[i] >= N - 0.5 ||
          this.y[i] < 0.5 || this.y[i] >= N - 0.5) {
        this.ventSet ? this._spawnAtVent(i) : this._spawnRandom(i);
      }
    }
  }
}
