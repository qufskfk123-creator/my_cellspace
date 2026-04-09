/**
 * AdvancedWindEngine.js — 이중 입자 시스템
 *
 * WindEngine (배경 바람 라인) + 연기 입자 (환기구 클릭 위치에서 방출)
 *
 * 연기 입자 설계:
 *   · 지리 좌표(lng/lat)로 보관 → 지도 완전 동기화
 *   · 사출 속도 = 랜덤 방향 CSS px → 야코비안 역행렬로 deg/frame 변환
 *   · 사출 감쇠(×0.92/frame) → 바람 흐름으로 자연스럽게 전환
 *   · 수명 동안 반지름/불투명도 변화 → 퍼져나가는 연기 형태
 */

import { WindEngine } from './WindEngine.js';

export class AdvancedWindEngine {
  /**
   * @param {object} opts
   * @param {number} [opts.windCols=5]
   * @param {number} [opts.windRows=5]
   * @param {number} [opts.windCount=3000]   배경 바람 입자 수
   * @param {number} [opts.smokeCount=2000]  연기 입자 풀 크기
   * @param {number} [opts.maxVents=5]       최대 환기구 수
   */
  constructor({ windCols = 5, windRows = 5, windCount = 3000,
                smokeCount = 2000, maxVents = 5 } = {}) {

    // ── 배경 바람 엔진 ─────────────────────────────────────────────────────
    this.wind = new WindEngine({ cols: windCols, rows: windRows, count: windCount });

    // ── 연기 입자 풀 ──────────────────────────────────────────────────────
    this.smokeCount = smokeCount;
    this.sLng    = new Float32Array(smokeCount);   // 현재 경도
    this.sLat    = new Float32Array(smokeCount);   // 현재 위도
    this.sPlng   = new Float32Array(smokeCount);   // 직전 경도 (미사용, 호환용)
    this.sPlat   = new Float32Array(smokeCount);   // 직전 위도
    this.sAge    = new Float32Array(smokeCount);
    this.sLife   = new Float32Array(smokeCount);
    this.sEvx    = new Float32Array(smokeCount);   // 사출 속도 lng (deg/frame)
    this.sEvy    = new Float32Array(smokeCount);   // 사출 속도 lat (deg/frame)
    this.sAlpha  = new Float32Array(smokeCount);   // 렌더 불투명도 (0~1)
    this.sRadius = new Float32Array(smokeCount);   // 렌더 반지름 (CSS px)
    this.sT      = new Float32Array(smokeCount);   // 수명 진행률 0~1 (색상용)

    // 초기에는 모두 죽은 상태
    this.sAge.fill(1e9);
    this.sLife.fill(1);

    // ── 환기구 목록 ───────────────────────────────────────────────────────
    this.vents    = [];
    this.maxVents = maxVents;
    this.emitRate = 5;   // 프레임당 환기구 1개에서 방출할 입자 수

    // 내부 재사용: 빈 슬롯 탐색 시작 인덱스 (순환 최적화)
    this._sPtr = 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 환기구 관리
  // ══════════════════════════════════════════════════════════════════════════

  /** 환기구 추가 (최대 maxVents 개; 초과 시 가장 오래된 것 제거) */
  addVent(lng, lat) {
    if (this.vents.length >= this.maxVents) this.vents.shift();
    this.vents.push({ lng, lat });
  }

  clearVents() {
    this.vents = [];
    // 살아 있는 연기 입자도 모두 소멸
    this.sAge.fill(1e9);
    this.sLife.fill(1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WindEngine 위임
  // ══════════════════════════════════════════════════════════════════════════

  setWindData(lngs, lats, u, v) { this.wind.setWindData(lngs, lats, u, v); }
  setBounds(mn, ms, mx, my)     { this.wind.setBounds(mn, ms, mx, my); }
  buildLookup(map, dpr, ss, na) { this.wind.buildLookup(map, dpr, ss, na); }
  reset()                       { this.wind.reset(); }
  get hasData()                 { return this.wind.hasData; }
  get maxSpeedMs()              { return this.wind.maxSpeedMs; }

  // ══════════════════════════════════════════════════════════════════════════
  // 연기 입자 생성
  // ══════════════════════════════════════════════════════════════════════════

  _spawnSmoke(vent) {
    const sc = this.smokeCount;
    // 빈 슬롯 탐색 (순환 포인터로 O(1) 평균)
    for (let k = 0; k < sc; k++) {
      const i = (this._sPtr + k) % sc;
      if (this.sAge[i] < this.sLife[i]) continue;  // 살아 있으면 스킵

      this._sPtr = (i + 1) % sc;

      // 랜덤 사출 방향 (CSS px 단위)
      const angle    = Math.random() * Math.PI * 2;
      const ejectPx  = 1.5 + Math.random() * 3.5;   // 1.5~5 CSS px/frame
      const eX       = Math.cos(angle) * ejectPx;
      const eY       = Math.sin(angle) * ejectPx;

      // CSS px → 지리 deg/frame (야코비안 역행렬 사용)
      const w = this.wind;
      this.sEvx[i] = w._Ji00 * eX + w._Ji01 * eY;
      this.sEvy[i] = w._Ji10 * eX + w._Ji11 * eY;

      // 환기구 위치에서 미세 지터로 스폰
      const jitter = 0.00012;
      this.sLng[i]  = this.sPlng[i] = vent.lng + (Math.random() - 0.5) * jitter;
      this.sLat[i]  = this.sPlat[i] = vent.lat + (Math.random() - 0.5) * jitter;

      this.sAge[i]  = 0;
      this.sLife[i] = 70 + Math.random() * 130;  // 70~200 프레임
      return true;
    }
    return false;  // 풀 가득 참
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1프레임 진행
  // ══════════════════════════════════════════════════════════════════════════

  step() {
    // 1. 배경 바람 입자
    this.wind.step();

    // 2. 환기구에서 연기 방출
    for (const vent of this.vents) {
      for (let k = 0; k < this.emitRate; k++) this._spawnSmoke(vent);
    }

    // 3. 연기 입자 진행
    const w = this.wind;
    const { bMinLng, bMaxLng, bMinLat, bMaxLat, LW, LH } = w;
    const spanLng = bMaxLng - bMinLng;
    const spanLat = bMaxLat - bMinLat;
    const EJECT_DECAY = 0.92;  // 사출 속도 감쇠율

    for (let i = 0; i < this.smokeCount; i++) {
      if (this.sAge[i] >= this.sLife[i]) continue;

      this.sAge[i]++;
      const t = this.sAge[i] / this.sLife[i];  // 0→1
      this.sT[i] = t;

      this.sPlng[i] = this.sLng[i];
      this.sPlat[i] = this.sLat[i];

      // 바람 룩업 (배경과 동일 룩업 테이블 공유)
      const lx  = Math.min(LW-1, Math.max(0,
        ((this.sLng[i] - bMinLng) / spanLng * LW) | 0));
      const ly  = Math.min(LH-1, Math.max(0,
        ((this.sLat[i] - bMinLat) / spanLat * LH) | 0));
      const idx = lx + ly * LW;

      const windDLng = w.lookupDLng[idx];
      const windDLat = w.lookupDLat[idx];

      // 이동 = 바람 + 사출 속도
      this.sLng[i] += windDLng + this.sEvx[i];
      this.sLat[i] += windDLat + this.sEvy[i];

      // 사출 속도 감쇠
      this.sEvx[i] *= EJECT_DECAY;
      this.sEvy[i] *= EJECT_DECAY;

      // 수명에 따른 시각 속성
      // 반지름: 초반 성장(0→0.3) → 중반 유지(0.3→0.7) → 말기 소멸
      if (t < 0.3) {
        this.sRadius[i] = 2 + t / 0.3 * 8;  // 2 → 10 px
      } else if (t < 0.7) {
        this.sRadius[i] = 10 + (t - 0.3) / 0.4 * 8;  // 10 → 18 px
      } else {
        this.sRadius[i] = 18 + (t - 0.7) / 0.3 * 4;  // 18 → 22 px (서서히 팽창)
      }

      // 불투명도: fade-in → 유지 → fade-out
      if (t < 0.15) {
        this.sAlpha[i] = t / 0.15;
      } else if (t < 0.70) {
        this.sAlpha[i] = 1.0;
      } else {
        this.sAlpha[i] = 1.0 - (t - 0.70) / 0.30;
      }

      // 뷰포트 이탈 시 소멸
      if (this.sLng[i] < bMinLng || this.sLng[i] > bMaxLng ||
          this.sLat[i] < bMinLat || this.sLat[i] > bMaxLat) {
        this.sAge[i] = this.sLife[i];  // 강제 소멸
      }
    }
  }
}
