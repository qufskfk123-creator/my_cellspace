/**
 * WindEngine.js — 지형 인식 Wind Field 엔진 v4
 *
 * ┌─ 핵심 기능 ──────────────────────────────────────────────────────────────┐
 * │  [1] Bilinear Interpolation (Esri Custom WebGL Layer 방식)               │
 * │      · _bilinear() 헬퍼 → API 격자 샘플링 + 룩업 런타임 샘플링 모두 적용 │
 * │      · step()에서 4-point bilinear로 셀 경계 연속 궤적 보장              │
 * │                                                                          │
 * │  [2] 지형 고도 연동 (map.queryTerrainElevation)                          │
 * │      · buildElevationGrid(): LW×LH 고도 격자 캐시                       │
 * │      · _terrainGradientAt(): 경사도 벡터 (dimensionless slope)           │
 * │      · _applyTerrain(): 오르막 감속(↓0.3×), 내리막 가속(↑2.5×)          │
 * │      · 바람 입자 + 연기 입자 모두 동일한 지형 물리 적용                  │
 * │                                                                          │
 * │  [3] 환기구 점원(Point Source) + Passive Tracer 입자                     │
 * │      · 누출 입자는 배경 풍장을 수정하지 않음 (독립 passive tracer)       │
 * │      · lookupDLng/Lat = 순수 바람만 → 배경 기류와 동일 경로 추종        │
 * │      · 바람·연기 모두 동일 지형 물리 통과 → 계곡/산릉을 따라 이동        │
 * │                                                                          │
 * │  좌표 규약: u=동(+) m/s  v=북(+) m/s                                    │
 * │            lng 증가=동쪽  lat 증가=북쪽(화면 y 감소)                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export class WindEngine {
  /**
   * @param {object} opts
   * @param {number} [opts.cols=5]        API 격자 열 수 (서→동)
   * @param {number} [opts.rows=5]        API 격자 행 수 (남→북)
   * @param {number} [opts.count=3000]    바람 입자 수
   * @param {number} [opts.smokeCount=1500] 연기 입자 풀 크기
   */
  constructor({ cols = 5, rows = 5, count = 3000, smokeCount = 1500 } = {}) {
    this.COLS  = cols;
    this.ROWS  = rows;
    this.count = count;

    // ── API 바람 격자 ────────────────────────────────────────────────────────
    this.geoU     = new Float32Array(cols * rows);  // 동쪽 m/s
    this.geoV     = new Float32Array(cols * rows);  // 북쪽 m/s
    this.gridLngs = new Float32Array(cols);
    this.gridLats = new Float32Array(rows);
    this.hasData    = false;
    this.maxSpeedMs = 1;

    // ── 속도 룩업 격자 (buildLookup이 채움) ─────────────────────────────────
    this.LW = 80;
    this.LH = 80;
    this.lookupDLng = new Float32Array(this.LW * this.LH);  // deg lng/frame
    this.lookupDLat = new Float32Array(this.LW * this.LH);  // deg lat/frame
    this.lookupSpd  = new Float32Array(this.LW * this.LH);  // 0~1 정규화 속도

    // ── 고도 격자 (buildElevationGrid가 채움) ───────────────────────────────
    this.elevGrid     = new Float32Array(this.LW * this.LH);  // meters
    this.hasElevation = false;
    this.terrainStrength = 3.0;  // 경사 영향 강도 (0=비활성)

    // ── 뷰포트 범위 ─────────────────────────────────────────────────────────
    this.bMinLng = 124; this.bMaxLng = 132;
    this.bMinLat =  33; this.bMaxLat =  39;

    // ── 바람 입자 (지리 좌표 보관) ───────────────────────────────────────────
    this.lng  = new Float32Array(count);
    this.lat  = new Float32Array(count);
    this.plng = new Float32Array(count);
    this.plat = new Float32Array(count);
    this.age  = new Float32Array(count);
    this.life = new Float32Array(count);
    this.spd  = new Float32Array(count);  // 0~1 정규화 속도 (색상·두께)

    // ── 야코비안 역행렬 캐시 ─────────────────────────────────────────────────
    this._Ji00 = 0; this._Ji01 = 0;
    this._Ji10 = 0; this._Ji11 = 0;

    // ── 컬 노이즈 ────────────────────────────────────────────────────────────
    this._noiseT = 0;

    // ── 환기구 ───────────────────────────────────────────────────────────────
    this.vents     = [];   // {lng, lat, strengthMs, sigmaM}
    this.emitRate  = 3;   // 프레임당 확산원 1개에서 방출할 입자 수
    this.diffusion = 1.0; // 확산 난보 강도 (CSS px 단위; Ji⁻¹로 deg 변환됨)

    // ── 연기 입자 ────────────────────────────────────────────────────────────
    this.smokeCount = smokeCount;
    this.sLng    = new Float32Array(smokeCount);
    this.sLat    = new Float32Array(smokeCount);
    this.sPlng   = new Float32Array(smokeCount);  // 직전 경도 (트레일 선분용)
    this.sPlat   = new Float32Array(smokeCount);  // 직전 위도
    this.sAge    = new Float32Array(smokeCount);
    this.sLife   = new Float32Array(smokeCount);
    this.sEvx    = new Float32Array(smokeCount);  // 사출 속도 (passive tracer에선 0)
    this.sEvy    = new Float32Array(smokeCount);
    this.sAlpha  = new Float32Array(smokeCount);  // 렌더 투명도 (fade-in × 농도)
    this.sConc   = new Float32Array(smokeCount);  // 물리 농도 1→0 (거리 기반)
    this.sLng0   = new Float32Array(smokeCount);  // 스폰 경도 (발원점)
    this.sLat0   = new Float32Array(smokeCount);  // 스폰 위도 (발원점)
    this.sRadius = new Float32Array(smokeCount);
    this.sT      = new Float32Array(smokeCount);  // 수명 진행률 0→1
    this.sZ        = new Float32Array(smokeCount);  // 입자 현재 고도 (m, 스폰지점 지형 대비 상대값)
    this.sSpawnElev= new Float32Array(smokeCount);  // 스폰 지점 지형 절대 고도 (m)
    this.sIsUpper  = new Float32Array(smokeCount);  // 0(지상)~1(상층) 보간 비율
    this.sModeArr  = new Uint8Array(smokeCount);    // 0=가스누출, 1=화재
    this.sGrowth   = new Float32Array(smokeCount);  // 스폰 시점 화재 성장률 0→1
    this._sPtr     = 0;  // 순환 탐색 포인터

    // 시뮬레이션 모드 (외부에서 변경)
    this.fireMode   = false;
    this.fireSpread = false;   // 연소 확산(옮겨붙기) 활성 여부
    this._spreadTimer = 0;     // 확산 간격 카운터

    // ── 10m / 80m 개별 바람 격자 (고도별 차등 적용용) ──────────────────────
    this.geoU10   = new Float32Array(cols * rows);
    this.geoV10   = new Float32Array(cols * rows);
    this.geoU80   = new Float32Array(cols * rows);
    this.geoV80   = new Float32Array(cols * rows);
    this.hasData10 = false;
    this.hasData80 = false;

    // 10m / 80m 별도 룩업 (연기 입자 수직 보간용 — buildLookup에서 채움)
    this.lookupDLng10 = new Float32Array(this.LW * this.LH);
    this.lookupDLat10 = new Float32Array(this.LW * this.LH);
    this.lookupDLng80 = new Float32Array(this.LW * this.LH);
    this.lookupDLat80 = new Float32Array(this.LW * this.LH);

    // 발원점으로부터 이 거리(도)에서 농도 = 0 (완전 희석)
    // 기본 0.08° ≈ 9 km (km 단위 GUI 파라미터에서 변환)
    this.maxDispDeg = 0.08;
    this.sAge.fill(1e9); this.sLife.fill(1);  // 초기 모두 소멸 상태

    this._scatter();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 환기구 API
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * @param {number} elevZ 발화점 지형 고도 (meters, map.queryTerrainElevation 반환값)
   */
  addVent(lng, lat, { strengthMs = 8, sigmaM = 70000, maxVents = 5, elevZ = 0 } = {}) {
    if (this.vents.length >= maxVents) this.vents.shift();
    this.vents.push({ lng, lat, strengthMs, sigmaM, birthAge: 0, elevZ });
  }

  /** 발화 직후 작게 시작해 GROW_FRAMES 동안 목표 크기로 점진 확대 */
  _effectiveSigma(vent) {
    const GROW_FRAMES = 1200;  // ~20초 @60fps — 더 천천히 성장
    const t = Math.min(1, (vent.birthAge ?? 0) / GROW_FRAMES);
    const ease = 1 - Math.pow(1 - t, 2.5);
    return vent.sigmaM * (0.04 + 0.96 * ease);
  }

  /** 현재 성장 진행률 0→1 (배출량·확산·선폭 스케일링 공용) */
  _growthFactor(vent) {
    const GROW_FRAMES = 1200;
    const t = Math.min(1, (vent.birthAge ?? 0) / GROW_FRAMES);
    return 0.04 + 0.96 * (1 - Math.pow(1 - t, 2.5));
  }

  clearVents() {
    this.vents = [];
    this.sAge.fill(1e9);
    this.sLife.fill(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 입자 생성
  // ══════════════════════════════════════════════════════════════════════════

  _scatter() {
    for (let i = 0; i < this.count; i++) this._spawn(i, true);
  }

  _spawn(i, scatter = false) {
    const { bMinLng, bMaxLng, bMinLat, bMaxLat } = this;
    const wLng = bMaxLng - bMinLng, wLat = bMaxLat - bMinLat;
    let spawnLng, spawnLat;

    if (scatter || !this.hasData) {
      spawnLng = bMinLng + Math.random() * wLng;
      spawnLat = bMinLat + Math.random() * wLat;
    } else {
      // 풍속 비례 재배치: 3회 시도 → 최고 속도 위치 선택
      let bLng = bMinLng + Math.random() * wLng;
      let bLat = bMinLat + Math.random() * wLat;
      let bSpd = Math.hypot(...this._interpGeo(bLng, bLat));
      for (let k = 1; k < 4; k++) {
        const tLng = bMinLng + Math.random() * wLng;
        const tLat = bMinLat + Math.random() * wLat;
        const s = Math.hypot(...this._interpGeo(tLng, tLat));
        if (s > bSpd) { bSpd = s; bLng = tLng; bLat = tLat; }
      }
      spawnLng = bLng; spawnLat = bLat;
    }

    this.lng[i] = this.plng[i] = spawnLng;
    this.lat[i] = this.plat[i] = spawnLat;
    this.age[i]  = scatter ? Math.random() * 200 : 0;
    this.life[i] = 50 + Math.random() * 150;
    this.spd[i]  = 0;
  }

  _spawnSmoke(vent) {
    // 빈 슬롯 탐색
    let slot = -1;
    for (let k = 0; k < this.smokeCount; k++) {
      const i = (this._sPtr + k) % this.smokeCount;
      if (this.sAge[i] >= this.sLife[i]) { slot = i; break; }
    }
    // 풀이 꽉 찼으면 가장 수명이 많이 진행된 입자를 강제 재활용
    if (slot === -1) {
      let maxT = -1;
      for (let i = 0; i < this.smokeCount; i++) {
        const t = this.sAge[i] / (this.sLife[i] + 1e-6);
        if (t > maxT) { maxT = t; slot = i; }
      }
    }
    if (slot === -1) return;
    this._sPtr = (slot + 1) % this.smokeCount;
    {
      const i = slot;
      // ── Passive Tracer: 사출 속도 = 0 ────────────────────────────────────
      this.sEvx[i] = 0;
      this.sEvy[i] = 0;

      // 누출원 위치에 미세 지터 (같은 자리 겹침 방지)
      const j = 0.00008;
      this.sLng[i]  = vent.lng + (Math.random() - 0.5) * j;
      this.sLat[i]  = vent.lat + (Math.random() - 0.5) * j;
      this.sPlng[i] = this.sLng[i];
      this.sPlat[i] = this.sLat[i];
      this.sLng0[i] = this.sLng[i];
      this.sLat0[i] = this.sLat[i];
      this.sConc[i]      = 1.0;
      this.sZ[i]         = 2;              // +2m 오프셋: 지면 바로 위에서 피어오름 (관통 방지)
      this.sSpawnElev[i] = vent.elevZ || 0; // 스폰 지점 절대 고도 (지형+건물), 렌더: sZ+sSpawnElev
      this.sIsUpper[i]   = 0;
      this.sModeArr[i] = this.fireMode ? 1 : 0;
      this.sAge[i]     = 0;
      // 화재 발화점이 많을수록 수명 단축 (풀 포화 방지) — 최소 80 프레임
      const ventFactor = Math.max(1, Math.sqrt(this.vents.length / 3));
      // 화재 성장률: 작을수록 짧은 수명 → 퍼짐 작음 (초기) → 커짐 (성장 후)
      const gf = this.fireMode ? this._growthFactor(vent) : 1.0;
      this.sGrowth[i] = gf;
      this.sLife[i] = this.fireMode
        ? Math.max(30, Math.round((200 + Math.random() * 200) * gf / ventFactor))
        : 120 + Math.random() * 200;
      return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // API 데이터 주입
  // ══════════════════════════════════════════════════════════════════════════

  setWindData(lngs, lats, u, v) {
    for (let c = 0; c < this.COLS; c++) this.gridLngs[c] = lngs[c];
    for (let r = 0; r < this.ROWS; r++) this.gridLats[r] = lats[r];
    for (let i = 0; i < this.COLS * this.ROWS; i++) {
      this.geoU[i] = u[i]; this.geoV[i] = v[i];
    }
    let maxS = 0;
    for (let i = 0; i < this.COLS * this.ROWS; i++) {
      const s = Math.hypot(u[i], v[i]); if (s > maxS) maxS = s;
    }
    this.maxSpeedMs = Math.max(maxS, 0.5);
    this.hasData = true;
  }

  /** 지상 10m 바람 격자 주입 (연기 고도 보간 하단) */
  setWindData10m(lngs, lats, u, v) {
    for (let c = 0; c < this.COLS; c++) this.gridLngs[c] = lngs[c];
    for (let r = 0; r < this.ROWS; r++) this.gridLats[r] = lats[r];
    for (let i = 0; i < this.COLS * this.ROWS; i++) {
      this.geoU10[i] = u[i]; this.geoV10[i] = v[i];
    }
    this.hasData10 = true;
  }

  /** 상층 80m 바람 격자 주입 (연기 고도 보간 상단) */
  setWindData80m(lngs, lats, u, v) {
    for (let i = 0; i < this.COLS * this.ROWS; i++) {
      this.geoU80[i] = u[i]; this.geoV80[i] = v[i];
    }
    this.hasData80 = true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [1] Bilinear Interpolation — Esri WebGL 방식
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 단위 정사각형 4점 쌍선형 보간 헬퍼.
   * Esri 예제의 fragmentShader mix 패턴과 동일한 가중치.
   *
   *  f01 ─── f11
   *   │  ·(fx,fy) │
   *  f00 ─── f10
   */
  _bilinear(f00, f10, f01, f11, fx, fy) {
    const mx0 = f00 + (f10 - f00) * fx;  // 하단 수평 mix
    const mx1 = f01 + (f11 - f01) * fx;  // 상단 수평 mix
    return mx0 + (mx1 - mx0) * fy;       // 수직 mix
  }

  /** 임의 geoU/geoV 격자를 쌍선형 보간 → [u, v] m/s (10m·80m 공용) */
  _interpGeoArr(geoU, geoV, lng, lat) {
    const { COLS, ROWS, gridLngs, gridLats } = this;
    const gx = (lng - gridLngs[0]) / (gridLngs[COLS-1] - gridLngs[0]) * (COLS - 1);
    const gy = (lat - gridLats[0]) / (gridLats[ROWS-1] - gridLats[0]) * (ROWS - 1);
    const cx = Math.max(0, Math.min(COLS - 1 - 1e-6, gx));
    const cy = Math.max(0, Math.min(ROWS - 1 - 1e-6, gy));
    const ix = cx | 0, iy = cy | 0;
    const fx = cx - ix, fy = cy - iy;
    const i00 = ix + iy * COLS, i10 = (ix+1) + iy * COLS;
    const i01 = ix + (iy+1) * COLS, i11 = (ix+1) + (iy+1) * COLS;
    return [
      this._bilinear(geoU[i00], geoU[i10], geoU[i01], geoU[i11], fx, fy),
      this._bilinear(geoV[i00], geoV[i10], geoV[i01], geoV[i11], fx, fy),
    ];
  }

  /**
   * 임의 dLng/dLat 룩업 테이블을 4-point bilinear로 읽기.
   * _lookupInterp의 2-value 버전 (spd 불필요한 smoke 보간용).
   */
  _lookupInterpArr(dLngArr, dLatArr, lng, lat) {
    const { LW, LH, bMinLng, bMaxLng, bMinLat, bMaxLat } = this;
    const spanLng = bMaxLng - bMinLng, spanLat = bMaxLat - bMinLat;
    const gx = (lng - bMinLng) / spanLng * LW - 0.5;
    const gy = (lat - bMinLat) / spanLat * LH - 0.5;
    const ix = Math.max(0, Math.min(LW - 2, gx | 0));
    const iy = Math.max(0, Math.min(LH - 2, gy | 0));
    const fx = Math.max(0, Math.min(1, gx - ix));
    const fy = Math.max(0, Math.min(1, gy - iy));
    const i00 = ix + iy*LW, i10 = (ix+1) + iy*LW;
    const i01 = ix + (iy+1)*LW, i11 = (ix+1) + (iy+1)*LW;
    return [
      this._bilinear(dLngArr[i00], dLngArr[i10], dLngArr[i01], dLngArr[i11], fx, fy),
      this._bilinear(dLatArr[i00], dLatArr[i10], dLatArr[i01], dLatArr[i11], fx, fy),
    ];
  }

  /** API 5×5 격자를 쌍선형 보간 → (lng, lat) 의 [u, v] m/s 반환 */
  _interpGeo(lng, lat) {
    if (!this.hasData) return [0, 0];
    const { COLS, ROWS, gridLngs, gridLats, geoU, geoV } = this;

    const gx = (lng - gridLngs[0]) / (gridLngs[COLS-1] - gridLngs[0]) * (COLS - 1);
    const gy = (lat - gridLats[0]) / (gridLats[ROWS-1] - gridLats[0]) * (ROWS - 1);
    const cx = Math.max(0, Math.min(COLS - 1 - 1e-6, gx));
    const cy = Math.max(0, Math.min(ROWS - 1 - 1e-6, gy));
    const ix = cx | 0, iy = cy | 0;
    const fx = cx - ix, fy = cy - iy;

    const i00 =  ix    +  iy    * COLS;
    const i10 = (ix+1) +  iy    * COLS;
    const i01 =  ix    + (iy+1) * COLS;
    const i11 = (ix+1) + (iy+1) * COLS;
    return [
      this._bilinear(geoU[i00], geoU[i10], geoU[i01], geoU[i11], fx, fy),
      this._bilinear(geoV[i00], geoV[i10], geoV[i01], geoV[i11], fx, fy),
    ];
  }

  /**
   * 사전 계산된 80×80 룩업 테이블을 4-point bilinear로 읽기.
   * nearest-cell 대비: 셀 경계에서 속도가 연속적으로 변해 입자 궤적이 부드러움.
   * @returns {[number, number, number]}  [dLng, dLat, normSpd]
   */
  _lookupInterp(lng, lat) {
    const { LW, LH, bMinLng, bMaxLng, bMinLat, bMaxLat } = this;
    const spanLng = bMaxLng - bMinLng, spanLat = bMaxLat - bMinLat;

    const gx = (lng - bMinLng) / spanLng * LW - 0.5;
    const gy = (lat - bMinLat) / spanLat * LH - 0.5;
    const ix = Math.max(0, Math.min(LW - 2, gx | 0));
    const iy = Math.max(0, Math.min(LH - 2, gy | 0));
    const fx = Math.max(0, Math.min(1, gx - ix));
    const fy = Math.max(0, Math.min(1, gy - iy));

    const i00 =  ix    +  iy    * LW;
    const i10 = (ix+1) +  iy    * LW;
    const i01 =  ix    + (iy+1) * LW;
    const i11 = (ix+1) + (iy+1) * LW;
    return [
      this._bilinear(this.lookupDLng[i00], this.lookupDLng[i10],
                     this.lookupDLng[i01], this.lookupDLng[i11], fx, fy),
      this._bilinear(this.lookupDLat[i00], this.lookupDLat[i10],
                     this.lookupDLat[i01], this.lookupDLat[i11], fx, fy),
      this._bilinear(this.lookupSpd[i00],  this.lookupSpd[i10],
                     this.lookupSpd[i01],  this.lookupSpd[i11],  fx, fy),
    ];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [2] 지형 고도 — 경사도 기반 속도 수정
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * map.queryTerrainElevation으로 LW×LH 고도 격자를 채웁니다.
   * buildLookup() 이후 호출. terrain이 활성화된 후에만 유효한 값을 반환.
   */
  buildElevationGrid(map) {
    const { LW, LH, bMinLng, bMaxLng, bMinLat, bMaxLat } = this;
    const dLng = (bMaxLng - bMinLng) / LW;
    const dLat = (bMaxLat - bMinLat) / LH;

    for (let ly = 0; ly < LH; ly++) {
      for (let lx = 0; lx < LW; lx++) {
        const lng = bMinLng + (lx + 0.5) * dLng;
        const lat = bMinLat + (ly + 0.5) * dLat;
        const elev = map.queryTerrainElevation([lng, lat]);
        this.elevGrid[lx + ly * LW] = elev ?? 0;
      }
    }
    this.hasElevation = true;
  }

  /**
   * 룩업 셀 좌표 (lx, ly) 에서 지형 경사도 벡터 반환.
   * 중앙 차분으로 계산. 반환값: [slope_lng, slope_lat] (dimensionless, m/m)
   */
  _terrainGradientAt(lx, ly) {
    const { LW, LH } = this;
    const ix = Math.max(1, Math.min(LW - 2, lx | 0));
    const iy = Math.max(1, Math.min(LH - 2, ly | 0));

    // 인접 셀의 고도 차 (meters per cell)
    const dzx = (this.elevGrid[(ix+1) + iy*LW] - this.elevGrid[(ix-1) + iy*LW]) / 2;
    const dzy = (this.elevGrid[ix + (iy+1)*LW] - this.elevGrid[ix + (iy-1)*LW]) / 2;

    // 셀 수평 크기 (meters per cell) — 구면 보정
    const cosLat = Math.cos((this.bMinLat + this.bMaxLat) / 2 * Math.PI / 180);
    const cellLngM = (this.bMaxLng - this.bMinLng) / LW * 111320 * cosLat;
    const cellLatM = (this.bMaxLat - this.bMinLat) / LH * 111320;

    return [dzx / cellLngM, dzy / cellLatM];  // dimensionless slope
  }

  /**
   * 입자 속도 벡터에 지형 경사도 영향 적용.
   *
   * 물리 모델:
   *   · uphillSlope = 속도 방향과 경사 벡터의 내적 (양수=오르막)
   *   · speedMod = 1 - uphillSlope × terrainStrength
   *     → 오르막: mod < 1 (감속, min=0.3)
   *     → 내리막: mod > 1 (가속, max=2.5)
   */
  _applyTerrain(dLng, dLat, lx, ly) {
    if (!this.hasElevation || this.terrainStrength === 0) return [dLng, dLat];

    const [sx, sy] = this._terrainGradientAt(lx, ly);
    const velMag = Math.hypot(dLng, dLat);
    if (velMag < 1e-10) return [dLng, dLat];

    const uphillSlope = (dLng / velMag) * sx + (dLat / velMag) * sy;
    const mod = Math.max(0.3, Math.min(2.5, 1.0 - uphillSlope * this.terrainStrength));

    return [dLng * mod, dLat * mod];
  }

  /**
   * bilinear 지형 고도 샘플링 (절대 고도 m 반환)
   * _elevAt(lng, lat) → 그 위치의 지형 고도 (meters above sea level)
   * elevGrid가 없으면 0 반환.
   */
  _elevAt(lng, lat) {
    if (!this.hasElevation) return 0;
    const { LW, LH, bMinLng, bMaxLng, bMinLat, bMaxLat } = this;
    const lx = Math.max(0, Math.min(LW - 1.001,
      (lng - bMinLng) / (bMaxLng - bMinLng) * LW - 0.5));
    const ly = Math.max(0, Math.min(LH - 1.001,
      (lat - bMinLat) / (bMaxLat - bMinLat) * LH - 0.5));
    const ix = lx | 0, iy = ly | 0;
    const fx = lx - ix, fy = ly - iy;
    const nx = Math.min(LW - 1, ix + 1), ny = Math.min(LH - 1, iy + 1);
    return this._bilinear(
      this.elevGrid[ix + iy  * LW], this.elevGrid[nx + iy  * LW],
      this.elevGrid[ix + ny  * LW], this.elevGrid[nx + ny  * LW],
      fx, fy
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // [3] 환기구 점원 속도장
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 모든 환기구의 Gaussian 방사형 유출 속도 합산 → [u, v] m/s.
   * buildLookup()에서 API 바람과 벡터 합산 → 동일 m/s 공간에서 자연스럽게 혼합.
   */
  _ventVelocityAt(lng, lat) {
    if (this.vents.length === 0) return [0, 0];

    const cosLat     = Math.cos(lat * Math.PI / 180);
    const mPerDegLng = 111320 * cosLat;
    const mPerDegLat = 111320;
    let totalU = 0, totalV = 0;

    for (const vent of this.vents) {
      const dx = (lng - vent.lng) * mPerDegLng;   // 동 m
      const dy = (lat - vent.lat) * mPerDegLat;   // 북 m
      const distSq = dx * dx + dy * dy;
      if (distSq < 1.0) continue;

      const effSigma = this._effectiveSigma(vent);
      const falloff = Math.exp(-distSq / (2 * effSigma * effSigma));
      if (falloff < 0.002) continue;

      const dist = Math.sqrt(distSq);
      totalU += (dx / dist) * vent.strengthMs * falloff;
      totalV += (dy / dist) * vent.strengthMs * falloff;
    }
    return [totalU, totalV];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 컬 노이즈 난류
  // ══════════════════════════════════════════════════════════════════════════

  _noiseF(x, y) {
    const t = this._noiseT;
    return (Math.sin(x * 2.1 + y * 1.7 + t * 0.18) * 0.50 +
            Math.sin(x * 4.3 + y * 3.9 + t * 0.34) * 0.30 +
            Math.sin(x * 8.7 + y * 7.2 + t * 0.12) * 0.20);
  }

  _curlNoise(x, y, strength) {
    const eps  = 0.005;
    const dfdx = (this._noiseF(x+eps, y) - this._noiseF(x-eps, y)) / (2*eps);
    const dfdy = (this._noiseF(x, y+eps) - this._noiseF(x, y-eps)) / (2*eps);
    return [-dfdy * strength, dfdx * strength];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // buildLookup — 순수 바람 → Jacobian 스케일링 → 룩업 저장
  // (환기구는 풍장과 독립 — passive tracer이므로 여기서 합산하지 않음)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 변환 파이프라인 (per lookup cell):
   *   ① API bilinear [windU, windV] m/s
   *   ② 컬 노이즈 난류 추가 (바람 속도 비례 강도)
   *   ③ m/s → deg/s (구면 보정)
   *   ④ Jacobian → screen CSS px/s (지도 회전·기울기 포함)
   *   ⑤ normSpd 기반 목표 시각 속도로 스케일
   *   ⑥ Jacobian 역행렬 → deg/frame 저장
   */
  buildLookup(map, dpr, speedScale = 1, noiseAmt = 0.3) {
    if (!this.hasData) return;

    const { LW, LH, bMinLng, bMaxLng, bMinLat, bMaxLat } = this;

    // Jacobian: 뷰포트 중심의 지도 투영 선형 근사
    const ctr = map.getCenter();
    const EPS = 0.01;
    const p0 = map.project([ctr.lng,       ctr.lat]);
    const pE = map.project([ctr.lng + EPS,  ctr.lat]);
    const pN = map.project([ctr.lng,        ctr.lat + EPS]);

    const J00 = (pE.x - p0.x) / EPS, J10 = (pE.y - p0.y) / EPS;
    const J01 = (pN.x - p0.x) / EPS, J11 = (pN.y - p0.y) / EPS;
    const det = J00*J11 - J01*J10;
    if (Math.abs(det) < 1e-10) return;

    const Ji00 =  J11/det, Ji01 = -J01/det;
    const Ji10 = -J10/det, Ji11 =  J00/det;
    this._Ji00=Ji00; this._Ji01=Ji01; this._Ji10=Ji10; this._Ji11=Ji11;

    const latRad     = ctr.lat * Math.PI / 180;
    const mPerDegLng = 111320 * Math.cos(latRad);
    const mPerDegLat = 111320;
    const maxVisCssPx = window.innerWidth * 0.0035 * speedScale;

    const spanLng = bMaxLng - bMinLng, spanLat = bMaxLat - bMinLat;
    const noiseFq = 4.0 / Math.max(spanLng, spanLat, 0.01);
    const dLng    = spanLng / LW, dLat = spanLat / LH;

    for (let ly = 0; ly < LH; ly++) {
      for (let lx = 0; lx < LW; lx++) {
        const lng = bMinLng + (lx + 0.5) * dLng;
        const lat = bMinLat + (ly + 0.5) * dLat;
        const idx = lx + ly * LW;

        // ① + ③ 순수 바람 bilinear (환기구는 풍장에 영향 없음 — passive tracer)
        const [windU, windV] = this._interpGeo(lng, lat);
        let totalU = windU, totalV = windV;

        // ④ 컬 노이즈 (바람 속도 기준 강도)
        const windSpd = Math.hypot(windU, windV);
        const turbStr = windSpd * noiseAmt;
        if (turbStr > 0.05) {
          const [nu, nv] = this._curlNoise(lng * noiseFq, lat * noiseFq, turbStr);
          totalU += nu; totalV += nv;
        }

        const totalSpd = Math.hypot(totalU, totalV);
        if (totalSpd < 0.01) {
          this.lookupDLng[idx] = 0; this.lookupDLat[idx] = 0; this.lookupSpd[idx] = 0;
          continue;
        }

        // ⑤ m/s → deg/s
        const vLng_dps = totalU / mPerDegLng;
        const vLat_dps = totalV / mPerDegLat;

        // ⑥ Jacobian → screen px/s
        const screenVX  = J00 * vLng_dps + J01 * vLat_dps;
        const screenVY  = J10 * vLng_dps + J11 * vLat_dps;
        const screenSpd = Math.hypot(screenVX, screenVY);

        // ⑦ 목표 시각 속도 스케일 (최대 풍속 기준 정규화)
        const normSpd       = Math.min(totalSpd / this.maxSpeedMs, 1.5);
        const visCssPxFrame = Math.min(normSpd, 1) * maxVisCssPx;
        const scale         = visCssPxFrame / (screenSpd + 1e-8);

        // ⑧ 역 Jacobian → deg/frame 저장
        const visVX = screenVX * scale, visVY = screenVY * scale;
        this.lookupDLng[idx] = Ji00 * visVX + Ji01 * visVY;
        this.lookupDLat[idx] = Ji10 * visVX + Ji11 * visVY;
        this.lookupSpd[idx]  = Math.min(normSpd, 1);
      }
    }

    // ── 10m / 80m 별도 룩업 빌드 (연기 입자 수직 보간용) ───────────────────
    if (this.hasData10 && this.hasData80) {
      // 두 레이어 통합 최대 속도 (공통 정규화 기준)
      let altMax = 0.5;
      for (let i = 0; i < this.COLS * this.ROWS; i++) {
        const s10 = Math.hypot(this.geoU10[i], this.geoV10[i]);
        const s80 = Math.hypot(this.geoU80[i], this.geoV80[i]);
        if (s10 > altMax) altMax = s10;
        if (s80 > altMax) altMax = s80;
      }
      const altVisPx = window.innerWidth * 0.0035 * speedScale;

      // 클로저로 10m / 80m 공용 빌드 (중복 루프 최소화)
      const fillAlt = (geoU, geoV, outDLng, outDLat) => {
        for (let ly = 0; ly < LH; ly++) {
          for (let lx = 0; lx < LW; lx++) {
            const lng = bMinLng + (lx + 0.5) * dLng;
            const lat = bMinLat + (ly + 0.5) * dLat;
            const idx = lx + ly * LW;
            const [u, v] = this._interpGeoArr(geoU, geoV, lng, lat);
            let tU = u, tV = v;
            const ws = Math.hypot(tU, tV);
            if (ws * noiseAmt > 0.05) {
              const [nu, nv] = this._curlNoise(lng * noiseFq, lat * noiseFq, ws * noiseAmt);
              tU += nu; tV += nv;
            }
            const ts = Math.hypot(tU, tV);
            if (ts < 0.01) { outDLng[idx] = 0; outDLat[idx] = 0; continue; }
            const vLng = tU / mPerDegLng, vLat = tV / mPerDegLat;
            const sVX = J00 * vLng + J01 * vLat;
            const sVY = J10 * vLng + J11 * vLat;
            const sSpd = Math.hypot(sVX, sVY);
            const norm = Math.min(ts / altMax, 1.5);
            const vis  = Math.min(norm, 1) * altVisPx;
            const sc   = vis / (sSpd + 1e-8);
            outDLng[idx] = Ji00 * sVX * sc + Ji01 * sVY * sc;
            outDLat[idx] = Ji10 * sVX * sc + Ji11 * sVY * sc;
          }
        }
      };

      fillAlt(this.geoU10, this.geoV10, this.lookupDLng10, this.lookupDLat10);
      fillAlt(this.geoU80, this.geoV80, this.lookupDLng80, this.lookupDLat80);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // step() — 1 프레임 진행 (바람 + 연기, 모두 지형 물리 적용)
  // ══════════════════════════════════════════════════════════════════════════

  step() {
    this._noiseT += 0.008;
    const { LW, LH, bMinLng, bMaxLng, bMinLat, bMaxLat } = this;
    const spanLng = bMaxLng - bMinLng, spanLat = bMaxLat - bMinLat;

    // ── 바람 입자 ──────────────────────────────────────────────────────────
    for (let i = 0; i < this.count; i++) {
      this.age[i]++;
      if (this.age[i] > this.life[i]) { this._spawn(i); continue; }

      this.plng[i] = this.lng[i]; this.plat[i] = this.lat[i];

      let [dLng, dLat, spd] = this._lookupInterp(this.lng[i], this.lat[i]);

      // 지형 영향 (경사도 기반 속도 수정)
      if (this.hasElevation) {
        const lx = (this.lng[i] - bMinLng) / spanLng * LW - 0.5;
        const ly = (this.lat[i] - bMinLat) / spanLat * LH - 0.5;
        [dLng, dLat] = this._applyTerrain(dLng, dLat, lx, ly);
        // 지형 수정에 따라 시각 속도도 재계산
        spd *= Math.hypot(dLng, dLat) / (Math.hypot(
          this.lookupDLng[Math.min(LW-1, Math.max(0, lx|0)) + Math.min(LH-1, Math.max(0, ly|0))*LW],
          this.lookupDLat[Math.min(LW-1, Math.max(0, lx|0)) + Math.min(LH-1, Math.max(0, ly|0))*LW]
        ) + 1e-8);
        spd = Math.min(1, Math.max(0, spd));
      }

      this.spd[i] = spd;
      this.lng[i] += dLng; this.lat[i] += dLat;

      if (this.lng[i] < bMinLng || this.lng[i] > bMaxLng ||
          this.lat[i] < bMinLat || this.lat[i] > bMaxLat) this._spawn(i);
    }

    // ── 환기구 방출 ─────────────────────────────────────────────────────────
    // 발화점 수에 관계없이 총 방출량을 일정하게 유지 (풀 고갈 방지)
    // 총 목표량 = emitRate × min(vent수, 6) → 많아도 emitRate×6 이하
    const _vc = this.vents.length;
    const _totalRate = this.emitRate * Math.min(_vc, 6);
    const _perVent   = Math.max(1, Math.round(_totalRate / _vc));
    for (const vent of this.vents) {
      vent.birthAge = (vent.birthAge ?? 0) + 1;  // 매 프레임 성장 카운터 증가
      // 화재 모드: 성장률에 비례해 배출량 조절 (초기=소량, 완전 성장=정상)
      const emitN = this.fireMode
        ? Math.max(1, Math.round(_perVent * this._growthFactor(vent)))
        : _perVent;
      for (let k = 0; k < emitN; k++) this._spawnSmoke(vent);
    }

    // ── 누출 입자 (Passive Tracer + Plume Dispersion) ────────────────────────
    const baseD = this.diffusion;  // 확산 강도 기준값
    for (let i = 0; i < this.smokeCount; i++) {
      if (this.sAge[i] >= this.sLife[i]) continue;
      this.sAge[i]++;
      const t = this.sAge[i] / this.sLife[i];
      this.sT[i] = t;

      const isFire = this.sModeArr[i] === 1;

      // [0] 고도 물리 (모드별 분기)
      if (isFire) {
        // 화재: 강력한 상승기류 — z<20m 구간은 중력 무시하고 최대 가속
        // z=0→20m: 플룸(Plume) 기둥 형성 구간 (강력 상승)
        // z=20~100m: 상층풍에 진입하며 점진 감속
        // z>100m: 연기 기둥, 느린 상승
        // 화재: sZ = 지형 대비 상대 고도 (0 = 지표면) → riseRate 판단 직관적
        const riseRate = this.sZ[i] < 20
          ? 2.5 + Math.random() * 1.5     // 2.5~4.0 m/frame (플룸 기둥 형성)
          : this.sZ[i] < 100
          ? 1.2 + Math.random() * 0.8     // 1.2~2.0 m/frame
          : 0.2 + Math.random() * 0.3;    // 0.2~0.5 m/frame (고층 연기)
        this.sZ[i] = Math.min(800, this.sZ[i] + riseRate);
      } else {
        // 가스: 부력(고농도→서서히 상승) / 냉각 하강
        // sZ = 지형 대비 상대 고도 → 바닥은 현재 위치 지형과 스폰 지형의 차이
        const absElev    = this.hasElevation ? this._elevAt(this.sLng[i], this.sLat[i]) : this.sSpawnElev[i];
        const relFloorG  = absElev - this.sSpawnElev[i];  // 현재 지형의 상대 바닥
        const buoyancy   = Math.max(0, this.sConc[i] - 0.5) * 0.25;
        if (buoyancy > 0) {
          this.sZ[i] = Math.min(relFloorG + 150, this.sZ[i] + buoyancy);
        } else {
          this.sZ[i] = Math.max(relFloorG, this.sZ[i] - 0.4);
        }
      }

      // 고도별 바람 가중치 (모드별 보간 구간 다름)
      //   가스: z<10m=지상만, 10~80m=보간, 80m+=상층만
      //   화재: z<15m=지상만(수직 플룸 유지), 15~45m=급격 보간, 45m+=상층풍(횡방향 견인)
      //         → 30~40m대에서 이미 상층풍에 완전히 휩쓸려 옆으로 뻗어나감
      const altBlend = isFire
        ? (this.sZ[i] < 15 ? 0 : this.sZ[i] > 45 ? 1 : (this.sZ[i] - 15) / 30)
        : (this.sZ[i] < 10 ? 0 : this.sZ[i] > 80 ? 1 : (this.sZ[i] - 10) / 70);
      this.sIsUpper[i] = altBlend;

      // [1] 수직 보간 바람: 지상 10m ↔ 상층 80m를 고도 비율로 혼합
      let dLng, dLat;
      if (this.hasData10 && this.hasData80) {
        const [dl10, dlat10] = this._lookupInterpArr(this.lookupDLng10, this.lookupDLat10, this.sLng[i], this.sLat[i]);
        const [dl80, dlat80] = this._lookupInterpArr(this.lookupDLng80, this.lookupDLat80, this.sLng[i], this.sLat[i]);
        dLng = dl10 * (1 - altBlend) + dl80 * altBlend;
        dLat = dlat10 * (1 - altBlend) + dlat80 * altBlend;
      } else {
        [dLng, dLat] = this._lookupInterp(this.sLng[i], this.sLat[i]);
      }

      // [2] 지형 물리 (경사 감속/가속 — 배경 바람과 동일 적용)
      if (this.hasElevation) {
        const lx = (this.sLng[i] - bMinLng) / spanLng * LW - 0.5;
        const ly = (this.sLat[i] - bMinLat) / spanLat * LH - 0.5;
        [dLng, dLat] = this._applyTerrain(dLng, dLat, lx, ly);
      }

      // [3] 대기 확산 난보 (Random Walk Diffusion)
      //     화재: 성장률에 비례해 확산 폭 조절 (초기=좁게, 성장 후=넓게 뭉게뭉게)
      const fireScale = isFire ? 1.5 + 6.0 * this.sGrowth[i] : 1.0;
      const D  = baseD * fireScale;
      const nX = (Math.random() - 0.5) * D;
      const nY = (Math.random() - 0.5) * D;
      dLng += this._Ji00 * nX + this._Ji01 * nY;
      dLat += this._Ji10 * nX + this._Ji11 * nY;

      // 직전 위치 저장 (트레일 선분 렌더용)
      this.sPlng[i] = this.sLng[i];
      this.sPlat[i] = this.sLat[i];

      this.sLng[i] += dLng;
      this.sLat[i] += dLat;

      // 지형 추적: 이동 후 새 위치의 지형 높이 변화 → 상대 z 하한으로 적용
      // 예) 평지(0m)→산(300m) 이동 시: relFloor=300-spawnElev, sZ가 그 아래면 올림
      // → 산맥을 타고 넘을 때 연기가 지형을 뚫지 않고 지표면을 따라 오름
      if (this.hasElevation) {
        const newAbsElev = this._elevAt(this.sLng[i], this.sLat[i]);
        const relFloor   = newAbsElev - this.sSpawnElev[i];
        if (this.sZ[i] < relFloor) this.sZ[i] = relFloor;
      }

      // [4] 농도 계산
      //     화재: 시간 기반 감쇠 (t^1.2) — 연기가 멀리 이동해도 기둥 유지
      //     가스: 거리 기반 감쇠 — 발원점에서 멀어질수록 희석
      if (isFire) {
        this.sConc[i] = Math.max(0, 1.0 - Math.pow(t, 1.2));
      } else {
        const dDx  = this.sLng[i] - this.sLng0[i];
        const dDy  = this.sLat[i] - this.sLat0[i];
        const dist = Math.hypot(dDx, dDy);
        this.sConc[i] = Math.max(0, 1.0 - dist / this.maxDispDeg);
      }

      // [5] 렌더 투명도 = fade-in × 농도
      //     fade-in (t < 0.05): 스폰 직후 갑작스러운 등장 방지
      const fadeIn = t < 0.05 ? (t / 0.05) : 1.0;
      this.sAlpha[i] = fadeIn * this.sConc[i];

      if (this.sLng[i] < bMinLng || this.sLng[i] > bMaxLng ||
          this.sLat[i] < bMinLat || this.sLat[i] > bMaxLat) {
        this.sAge[i] = this.sLife[i];
      }
    }

    // ── 연소 확산 (옮겨붙기) — fireSpread 활성 시 주기적으로 새 발화점 생성 ──
    if (this.fireMode && this.fireSpread && this.vents.length > 0) {
      this._spreadTimer++;
      if (this._spreadTimer >= 25) {  // ~0.4초마다 (더 빠른 확산)
        this._spreadTimer = 0;
        this._doFireSpread();
      }
    }
  }

  /**
   * 화재 확산: 바람에 실려 이동한 화재 입자 위치에서 새 발화점을 적극적으로 생성.
   *
   * 설계 원칙:
   *   · z < 45m 저고도 입자만 후보 — 지상 근처가 실제 불이 번지는 높이
   *   · 기존 발화점으로부터 MIN_DIST(~60m) 이상 떨어진 곳에만 생성
   *   · 1회 호출당 2~4개 동시 생성 → 빠르고 넓게 번짐
   *   · 90% 고확률 → 거의 매 호출마다 확산
   */
  _doFireSpread() {
    const MAX_SPREAD_VENTS = 40;
    // 새 발화점이 기존 발화점과 최소 이 거리 이상 떨어져야 함 (~200m)
    // → 겹침 방지. 상한은 두지 않음 (바람이 실어나른 거리가 곧 확산 거리)
    const MIN_DIST_DEG = 0.0018;   // ~200m
    if (this.vents.length >= MAX_SPREAD_VENTS) return;

    // 후보: 고도 무관, 살아있는 화재 입자 전체
    // (저고도 제한을 없애야 바람에 실려 멀리 이동한 입자도 잡힘)
    // 단, 너무 오래된 입자(t > 0.85)는 이미 희박해진 상태 → 제외
    const pool = [];
    for (let i = 0; i < this.smokeCount; i++) {
      if (this.sModeArr[i] !== 1)        continue;
      if (this.sAge[i] >= this.sLife[i]) continue;
      const t = this.sAge[i] / this.sLife[i];
      if (t > 0.85)                      continue;
      pool.push(i);
    }
    if (pool.length === 0) return;

    // 1회에 2~4개 발화점 생성 시도
    const wantAdd = 2 + Math.floor(Math.random() * 3);
    let added = 0;
    const maxTry = Math.min(pool.length, 80);

    for (let attempt = 0; attempt < maxTry && added < wantAdd; attempt++) {
      const i = pool[Math.floor(Math.random() * pool.length)];
      const lng = this.sLng[i], lat = this.sLat[i];

      // 기존 발화점 모두와 거리 체크: MIN_DIST 이내면 스킵 (겹침 방지)
      let tooClose = false;
      for (const v of this.vents) {
        if (Math.hypot(lng - v.lng, lat - v.lat) < MIN_DIST_DEG) { tooClose = true; break; }
      }
      if (tooClose) continue;

      if (Math.random() > 0.90) continue;  // 90% 확률

      const vent0 = this.vents[0];
      this.vents.push({
        lng,
        lat,
        strengthMs: vent0?.strengthMs ?? 8,
        sigmaM:     vent0?.sigmaM     ?? 70000,
        birthAge:   0,
      });
      added++;
      if (this.vents.length >= MAX_SPREAD_VENTS) break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 유틸리티
  // ══════════════════════════════════════════════════════════════════════════

  setBounds(minLng, minLat, maxLng, maxLat) {
    this.bMinLng = minLng; this.bMaxLng = maxLng;
    this.bMinLat = minLat; this.bMaxLat = maxLat;
  }

  reset() { this._scatter(); }
}
