/**
 * app.js — 실사 위성 기반 지형 인식 시뮬레이터
 *
 * 구성:
 *   · 배경: Esri World Imagery 위성 타일
 *   · 지형: AWS Terrarium DEM → map.queryTerrainElevation
 *   · 건물: OpenFreeMap PMTiles → fill-extrusion (불투명 회색조)
 *   · 바람: WindEngine v4 (bilinear + 지형 물리 + 확산 점원)
 *   · 연기: WindEngine 내장 smoke 입자 → 블러 캔버스로 구름 시각화
 *   · 색상: 바람 = 파랑→노랑→빨강  /  연기 = 주황→회색
 */

import { WindEngine } from './WindEngine.js';

// ══════════════════════════════════════════════════════════════════════════════
const PARTICLE_COUNT = 1500;   // 성능 최적화: 기존 3000의 절반
const SMOKE_COUNT    = 1500;   // 성능 최적화: 기존 3000의 절반
const GRID_COLS      = 3;      // 멀티포인트 윈드 필드 열 수 (3×3 = 9 API 지점)
const GRID_ROWS      = 3;
// ══════════════════════════════════════════════════════════════════════════════

// ── 시간 시뮬레이션 상태 ──────────────────────────────────────────────────────
// null = 자동(실제 시간), 0~23 = 시뮬레이션 모드
let _simHour = null;

/** 현재 유효 시간 반환 (시뮬레이션 > 실제) */
function _effectiveHour() {
  return _simHour !== null ? _simHour : new Date().getHours();
}

// ── MapLibre 초기화 ───────────────────────────────────────────────────────────
// 전략: OpenFreeMap liberty 스타일(검증된 벡터 타일 + 3D 건물)을 기반으로 로드한 뒤
//       Esri 위성 래스터를 맨 아래에, AWS Terrarium DEM을 지형으로 동적 삽입.
const map = new maplibregl.Map({
  container: 'map',
  style:     'https://tiles.openfreemap.org/styles/liberty',
  center:    [127.78, 36.0],
  zoom:       7,
  pitch:      30,
  bearing:    0,
  antialias:  true,
  maxPitch:   85,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

map.on('load', () => {
  _setupSatelliteAndTerrain();
  fetchWindField();           // 최초 1회 호출
  fetchLocationName();
  startLoop();
  // 매 정각: 캐시된 9개 지점 데이터에서 현재 시간 인덱스로 자동 전환 (시뮬레이션 중엔 스킵)
  setInterval(() => { if (_simHour === null) _applyCurrentHourWindGrid(); }, 3600000);
  // 8시간마다 자동 재갱신 (하루 최대 3회) — API 429 방지
  setInterval(() => {
    const elapsed = Date.now() - _lastGridFetchMs;
    if (elapsed >= 8 * 3600 * 1000) fetchWindField();
  }, 3600000);
  // 수동 동기화 버튼
  document.getElementById('wind-sync-btn')?.addEventListener('click', () => fetchWindField(true));
  setTimeout(() => {
    _applyMapEnvironment();   // 로드 직후 시간대 환경 초기 적용
    if (map.getTerrain()) engine.buildElevationGrid(map);
  }, 2000);
  setInterval(() => { if (engine.hasData && map.getTerrain()) engine.buildElevationGrid(map); }, 5000);

  // ── 모바일 드래그 카메라 핸들 ──────────────────────────────────────────────
  if (window.matchMedia('(max-width: 640px)').matches) {
    const handle = document.getElementById('cam-drag');
    if (handle) {
      const BEAR_SENS  = 0.35;  // px → 방위각(°)
      const PITCH_SENS = 0.25;  // px → 시야각(°)
      let dragging = false;
      let lastX = 0, lastY = 0;

      handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        handle.classList.add('active');
      });

      handle.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        map.setBearing(map.getBearing() + dx * BEAR_SENS);
        map.setPitch(Math.min(Math.max(map.getPitch() - dy * PITCH_SENS, 0), 85));
      });

      const stopDrag = () => { dragging = false; handle.classList.remove('active'); };
      handle.addEventListener('pointerup',     stopDrag);
      handle.addEventListener('pointercancel', stopDrag);
    }
  }
});

function _setupSatelliteAndTerrain() {
  const layers = map.getStyle().layers;

  // ── 1. Esri 위성 래스터: 모든 레이어보다 아래에 삽입 ─────────────────────
  map.addSource('esri-satellite', {
    type:        'raster',
    tiles:       ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize:    256,
    attribution: '© Esri',
    maxzoom:     19,
  });
  // 첫 번째 레이어 바로 앞에 삽입 → 모든 벡터 레이어 아래에 위치
  map.addLayer({ id: 'esri-satellite-bg', type: 'raster', source: 'esri-satellite' },
               layers[0].id);

  // ── 2. 배경(background) 레이어 숨김 → 위성이 보이도록 ────────────────────
  layers.forEach(l => {
    if (l.type === 'background') map.setLayoutProperty(l.id, 'visibility', 'none');
  });

  // ── 3. 수면·육지 fill 레이어 숨김 (위성 사진에서 이미 보임) ──────────────
  const HIDE_KEYWORDS = ['water', 'landcover', 'landuse', 'park', 'grass', 'sand', 'ice'];
  layers.forEach(l => {
    if (l.type === 'fill' &&
        HIDE_KEYWORDS.some(k => l.id.toLowerCase().includes(k))) {
      try { map.setLayoutProperty(l.id, 'visibility', 'none'); } catch { /* 무시 */ }
    }
  });

  // ── 4. 기존 건물(fill-extrusion) 레이어 → 반투명 회색조 ──
  layers.forEach(l => {
    if (l.type === 'fill-extrusion') {
      map.setPaintProperty(l.id, 'fill-extrusion-opacity', 1.0);
      map.setPaintProperty(l.id, 'fill-extrusion-color', [
        'step',
        ['coalesce', ['get', 'render_height'], ['get', 'height'], 0],
        '#2a2d3e',
         5, '#303350',
        15, '#3a3d5a',
        30, '#444760',
        80, '#505468',
      ]);
    }
  });

  // ── 5. 지형 DEM 추가 (AWS Terrarium — 무료·무인증) ───────────────────────
  map.addSource('terrain-dem', {
    type:     'raster-dem',
    tiles:    ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom:  14,
  });
  map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });

  console.log('[TerrainSim] 위성 + 지형 설정 완료');
}

// ── 지리 정보 토글 (지명·라벨 심볼만 표시/숨김 — 위성/건물/지형 유지) ───────
function _setGeoInfoVisible(show) {
  try {
    map.getStyle().layers.forEach(l => {
      // symbol 타입(지명, 도로명, POI 라벨)만 제어
      if (l.type !== 'symbol') return;
      map.setLayoutProperty(l.id, 'visibility', show ? 'visible' : 'none');
    });
  } catch (e) { /* 스타일 로드 전 호출 방지 */ }
}

// 체크박스 이벤트 (map 로드 완료 후에만 레이어 조작 가능)
document.getElementById('geo-check').addEventListener('change', e => {
  if (map.loaded()) _setGeoInfoVisible(e.target.checked);
});

// ── Canvas 3종 ───────────────────────────────────────────────────────────────
const canvas     = document.getElementById('sim-canvas');     // 최종 출력
const ctx        = canvas.getContext('2d');
const ventCanvas = document.getElementById('vent-canvas');    // 확산원 아이콘
const ventCtx    = ventCanvas.getContext('2d');
const dpr        = window.devicePixelRatio || 1;

// 오프스크린 트레일 (바람 입자 잔상)
const trailCanvas = document.createElement('canvas');
const trailCtx    = trailCanvas.getContext('2d');

// 오프스크린 연기/화재 (smoke trail — 천천히 페이드)
const smokeCanvas = document.createElement('canvas');
const smokeCtx    = smokeCanvas.getContext('2d');

function resizeCanvas() {
  const w = Math.round(window.innerWidth  * dpr);
  const h = Math.round(window.innerHeight * dpr);
  canvas.width  = trailCanvas.width  = smokeCanvas.width  = ventCanvas.width  = w;
  canvas.height = trailCanvas.height = smokeCanvas.height = ventCanvas.height = h;
}
resizeCanvas();
window.addEventListener('resize', () => { resizeCanvas(); map.resize(); if (engine.hasData) _rebuildAndClear(); });

// ── WindEngine ────────────────────────────────────────────────────────────────
const engine = new WindEngine({
  cols: GRID_COLS, rows: GRID_ROWS,
  count: PARTICLE_COUNT, smokeCount: SMOKE_COUNT,
});
engine.diffusion = 3.0;

// ── 건물 발화 상태 ────────────────────────────────────────────────────────────
const _buildingHeat    = new Map();   // "source::sourceLayer::id" → 누적 열기
const _ignitedBldgPts  = [];          // {lng, lat} 이미 발화한 지점 목록
let   _ignCheckFrame   = 0;

function _rebuildAndClear() {
  const b    = map.getBounds();
  const dLng = (b.getEast()  - b.getWest())  * 0.10;
  const dLat = (b.getNorth() - b.getSouth()) * 0.10;
  engine.setBounds(b.getWest()-dLng, b.getSouth()-dLat, b.getEast()+dLng, b.getNorth()+dLat);
  engine.buildLookup(map, dpr, _autoSpeedScale * params.speedMult, params.noiseAmt);
  trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
  // 지형 갱신 (약간의 지연으로 새 타일 로드 대기)
  if (map.getTerrain()) setTimeout(() => engine.buildElevationGrid(map), 800);
}

// ── 지도 이벤트 ───────────────────────────────────────────────────────────────
map.on('movestart',  () => {
  trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
});
map.on('moveend',    () => { _rebuildAndClear(); fetchLocationName(); });
map.on('pitchend',   () => { _rebuildAndClear(); });
map.on('rotateend',  () => { _rebuildAndClear(); });

// ── 줌 → 80m 고도 자동 전환 + 줌 비율에 따른 API 재호출 ────────────────────
map.on('zoomend', () => {
  const z = map.getZoom();

  // 고도 레이어 자동 전환 — 전환 시 최신 뷰포트로 바람 재호출
  if (z > 12 && params.useHeight) {
    params.useHeight = false;
    useHeightCtrl.updateDisplay();
    autoInfo.elevation = '10m (배경) | 확산: 10m+80m';
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    fetchWindField();
  } else if (z < 10 && !params.useHeight) {
    params.useHeight = true;
    useHeightCtrl.updateDisplay();
    autoInfo.elevation = '80m (배경) | 확산: 10m+80m';
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    fetchWindField();
  } else {
    _rebuildAndClear();
  }

  // 줌 변화량이 임계치(2레벨) 이상이면 API 재호출 (30초 쿨다운)
  if (Math.abs(z - _lastFetchZoom) >= ZOOM_FETCH_THRESHOLD &&
      Date.now() - _lastFetchTime > ZOOM_FETCH_COOLDOWN) {
    console.log(`[Wind] 줌 변화 ${_lastFetchZoom.toFixed(1)}→${z.toFixed(1)} — 바람 재호출`);
    fetchWindField();
  }
});

// ── 클릭 지점 표면 고도 계산 (지형 + 건물 옥상) ─────────────────────────────
/**
 * map.queryTerrainElevation  → 지형 고도 (DEM, 시각적 exaggeration 적용값)
 * queryRenderedFeatures       → 클릭 픽셀의 fill-extrusion 피쳐 → 건물 높이 합산
 * 결과: 실제 클릭 표면 고도 (산등성이/건물 옥상 모두 정확)
 */
function _pickSurfaceElevation(screenPoint, lngLat) {
  const terrainElev = map.queryTerrainElevation([lngLat.lng, lngLat.lat]) ?? 0;
  let bldgHeight = 0;
  try {
    const feats = map.queryRenderedFeatures(screenPoint)
      .filter(f => f.layer?.type === 'fill-extrusion');
    if (feats.length > 0) {
      const p = feats[0].properties ?? {};
      bldgHeight = Math.max(0, Number(p.height ?? p.render_height ?? p['building:levels'] * 3 ?? 0));
    }
  } catch { /* 피쳐 쿼리 실패 무시 */ }
  return { terrainElev, bldgHeight, total: terrainElev + bldgHeight };
}

// ── 확산원 클릭 ──────────────────────────────────────────────────────────────
map.on('click', e => {
  const { terrainElev, bldgHeight, total } = _pickSurfaceElevation(e.point, e.lngLat);

  engine.addVent(e.lngLat.lng, e.lngLat.lat,
    { strengthMs: params.ventStrength, sigmaM: params.ventSigmaKm * 1000, elevZ: total });

  const label = engine.fireMode ? '🔥 화재 발생' : '💨 확산원 추가됨';
  const info  = bldgHeight > 1
    ? `지형 ${Math.round(terrainElev)}m + 건물 ${Math.round(bldgHeight)}m`
    : `고도 ${Math.round(total)}m`;
  setStatus(`${label} (${engine.vents.length}개)  [${info}]`, 2500);
});


// ── GUI ───────────────────────────────────────────────────────────────────────
// 자동 보정 기저값 (API 호출마다 갱신 — buildLookup에 _autoSpeedScale×speedMult 형태로 전달)
let _autoSpeedScale = 1.0;
let _autoNoiseAmt   = 0.30;

// ── 줌 기반 API 재호출 추적
let _lastFetchZoom = map.getZoom();
let _lastFetchTime = 0;
const ZOOM_FETCH_THRESHOLD = 2;     // 2레벨 이상 변화 시 재호출
const ZOOM_FETCH_COOLDOWN  = 30000; // 30초 내 중복 호출 차단

const params = {
  speedMult:       1.0,     // 사용자 배율 (자동 base에 곱함; 기본 ×1.0)
  trailFade:       0.040,   // 배경 바람 잔상 (짧은 꼬리)
  lineWidth:       0.7,     // 배경 바람 선 굵기
  smokeFade:       0.022,   // 누출 잔상 소멸
  smokeWidth:      0.7,     // 누출 입자 선 굵기 기본값
  smokeBloom:      3,       // 누출 입자 미세 글로우
  diffusion:       3.0,     // 대기 확산 난보 강도 (CSS px 단위)
  dispersionKm:    9,       // 발원점에서 이 거리(km)에서 농도 0 (거리 기반 감쇠)
  noiseAmt:        0.30,
  useHeight:       true,
  terrainStrength: 3.0,
  ventStrength:    8,
  ventSigmaKm:     70,
  smokeAlpha:      0.35,    // 파티클 1개당 최대 불투명도 (낮을수록 그라데이션 부드러움)
  fireMode:        false,   // 화재 모드 (false=가스누출, true=대형화재)
  fireSpread:      false,   // 연소 확산 (옮겨붙기)
};

const autoInfo = { windSpeed: '--', autoScale: '--', elevation: '--' };

const gui = new lil.GUI({ title: '🛰 지형 시뮬레이터' });
gui.close();  // 기본 닫힘 — 햄버거 버튼으로 열기

// 햄버거 버튼 토글
const _menuBtn = document.getElementById('menu-btn');
if (_menuBtn) {
  _menuBtn.addEventListener('click', () => {
    if (gui._closed) {
      gui.open();
      _menuBtn.classList.add('open');
    } else {
      gui.close();
      _menuBtn.classList.remove('open');
    }
  });
}

const infoFolder = gui.addFolder('📡 실시간 정보');
infoFolder.add(autoInfo, 'windSpeed').name('대표 풍속 m/s').disable();
infoFolder.add(autoInfo, 'autoScale').name('자동 속도 배율').disable();
infoFolder.add(autoInfo, 'elevation').name('배경 바람 고도').disable();
infoFolder.open();

const windFolder = gui.addFolder('🌬 바람 입자 (Bloom 스타일)');
const speedCtrl = windFolder.add(params, 'speedMult', 0.25, 4.0, 0.25).name('속도 배율 ×').onChange(() => {
  if (engine.hasData) engine.buildLookup(map, dpr, _autoSpeedScale * params.speedMult, params.noiseAmt);
});
windFolder.add(params, 'trailFade',  0.005, 0.10, 0.005).name('배경 잔상 ↓=길게');
windFolder.add(params, 'lineWidth',  0.2,   2.0,  0.05 ).name('배경 선 굵기');
windFolder.add(params, 'noiseAmt',   0.0,   1.0,  0.05 ).name('난류 강도').onChange(() => {
  if (engine.hasData) engine.buildLookup(map, dpr, _autoSpeedScale * params.speedMult, params.noiseAmt);
});
const useHeightCtrl = windFolder.add(params, 'useHeight').name('80m 고도 바람').onChange(() => {
  autoInfo.elevation = params.useHeight ? '80m (배경) | 확산: 10m+80m' : '10m (배경) | 확산: 10m+80m';
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  // 고도 전환 시 현재 뷰포트로 바람 재호출 (10m↔80m 풍장 차이 즉시 반영)
  fetchWindField();
});
windFolder.add({ reload: fetchWindField }, 'reload').name('🔄 바람 새로고침');
windFolder.add({ reset: _resetToDefaults }, 'reset').name('↺ 기본값 복원');

const terrainFolder = gui.addFolder('⛰ 지형 물리');
terrainFolder.add(params, 'terrainStrength', 0, 10, 0.5).name('경사 영향 강도').onChange(v => {
  engine.terrainStrength = v;
});

const smokeWindInfo = { mode: '항상 10m+80m 고도 보간' };
const ventFolder = gui.addFolder('💨 확산 (클릭으로 배치)');
ventFolder.add(smokeWindInfo, 'mode').name('바람 고도').disable();
ventFolder.add(params, 'ventSigmaKm',  10, 300, 5  ).name('표시 반경 km');
ventFolder.add(params, 'smokeAlpha',  0.2, 1.0, 0.05).name('농도 (투명도)');
ventFolder.add(params, 'smokeFade',  0.001, 0.03, 0.001).name('잔상 ↓=길게');
ventFolder.add(params, 'smokeBloom',  0, 10, 1).name('글로우 강도');
ventFolder.add(params, 'diffusion',  0, 10, 0.5).name('확산 폭 (난보)').onChange(v => {
  engine.diffusion = v;
});
ventFolder.add(params, 'dispersionKm',  1, 50, 0.5).name('확산 도달 거리 km').onChange(v => {
  engine.maxDispDeg = v / 111.32;
});

// ── 화재 옵션 서브폴더 ─────────────────────────────────────────────────────
const fireFolder = ventFolder.addFolder('🔥 화재 옵션');

// 가스/화재 토글 스위치
fireFolder.add(params, 'fireMode').name('🔥 화재 모드').onChange(v => {
  engine.fireMode = v;
  engine.emitRate = v ? 6 : 3;
  // 화재 끄면 확산도 자동 해제
  if (!v) {
    params.fireSpread   = false;
    engine.fireSpread   = false;
    engine._spreadTimer = 0;
    gui.controllersRecursive().forEach(c => c.updateDisplay());
  }
  setStatus(v ? '🔥 대형 화재 모드 활성' : '💨 가스 누출 모드 전환', 2000);
});

fireFolder.add(params, 'fireSpread').name('💥 연소 확산 (옮겨붙기)').onChange(v => {
  if (v && !engine.fireMode) {
    // 화재 모드가 꺼져 있으면 자동으로 켜줌
    params.fireMode     = true;
    engine.fireMode     = true;
    engine.emitRate     = 6;
    gui.controllersRecursive().forEach(c => c.updateDisplay());
  }
  engine.fireSpread   = v;
  engine._spreadTimer = 0;
});

fireFolder.open();

ventFolder.add({ clear: () => {
  _buildingHeat.clear();
  _ignitedBldgPts.length = 0;

  engine.clearVents();
  engine.fireSpread   = false;
  params.fireSpread   = false;
  engine._spreadTimer = 0;
  ventCtx.clearRect(0, 0, ventCanvas.width, ventCanvas.height);
  smokeCtx.clearRect(0, 0, smokeCanvas.width, smokeCanvas.height);
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}}, 'clear').name('🗑 확산 전체 제거');

// ── Auto-calibration ──────────────────────────────────────────────────────────
function _applyAutoParams(maxSpeedMs) {
  const sc = Math.min(Math.max(maxSpeedMs / 8, 0.35), 5.0);
  // 난류 강도: 풍속에 정비례 (0→잔잔, 15m/s→최대 난류)
  //   Beaufort 1 (0.5m/s) → 0.10,  Beaufort 5 (8m/s) → 0.42,  Beaufort 8 (15m/s) → 0.65
  const na = Math.min(0.65, Math.max(0.05, maxSpeedMs * 0.040));
  _autoSpeedScale = sc;
  _autoNoiseAmt   = na;
  params.noiseAmt = na;   // GUI 슬라이더에도 실시간 반영
  autoInfo.windSpeed = maxSpeedMs.toFixed(1);
  autoInfo.autoScale = `base ×${sc.toFixed(2)}  user ×${params.speedMult.toFixed(2)}`;
  autoInfo.elevation = params.useHeight ? '80m (배경) | 확산: 10m+80m' : '10m (배경) | 확산: 10m+80m';
  gui.controllersRecursive().forEach(c => c.updateDisplay());
}

/** 모든 파라미터를 자동 보정 기본값으로 복원 */
function _resetToDefaults() {
  params.speedMult     = 1.0;
  params.noiseAmt      = _autoNoiseAmt;
  params.trailFade     = 0.040;
  params.lineWidth     = 0.7;
  params.smokeFade     = 0.022;
  params.smokeWidth    = 0.7;
  params.smokeBloom    = 3;
  params.diffusion     = 3.0;
  params.dispersionKm  = 9;
  params.terrainStrength = 3.0;
  params.ventStrength  = 8;
  params.ventSigmaKm   = 70;
  params.smokeAlpha    = 0.35;
  params.fireMode      = false;
  params.fireSpread    = false;
  engine.fireMode      = false;
  engine.fireSpread    = false;
  engine.emitRate      = 3;
  engine._spreadTimer  = 0;
  engine.diffusion     = 3.0;
  engine.maxDispDeg    = 9 / 111.32;
  engine.terrainStrength = 3.0;
  autoInfo.autoScale = `base ×${_autoSpeedScale.toFixed(2)}  user ×1.00`;
  gui.controllersRecursive().forEach(c => c.updateDisplay());
  if (engine.hasData) engine.buildLookup(map, dpr, _autoSpeedScale * params.speedMult, params.noiseAmt);
  setStatus('↺ 기본값으로 복원됨', 2000);
}

// ══════════════════════════════════════════════════════════════════════════════
// Open-Meteo API — 멀티포인트 윈드 필드 호출 정책
//   · 앱 로드 시 딱 1회: 뷰포트 3×3 = 9개 지점의 24시간치 hourly 데이터를 배치 수신
//   · 이후 API 호출 없음 — 매 정각 현재 시간 인덱스로 자동 전환 (9개 모두)
//   · 8시간 간격 자동 재갱신 (하루 최대 3회)
//   · 수동 동기화 버튼 클릭 시에만 즉시 재호출
//   · 에러 시 기존 dailyWindGrid 보존, 없으면 폴백 적용
// ══════════════════════════════════════════════════════════════════════════════

window.dailyWindGrid  = null;   // { lngs, lats, points: [{lat,lng,hourly}×9] }
window.currentWindData = null;  // 현재 시간 중앙 지점 단일 값 { spd10, dir10, spd80, dir80 }
let isFetching    = false;
let _lastGridFetchMs = 0;   // 마지막 API 호출 타임스탬프

// ── localStorage 캐시 헬퍼 ────────────────────────────────────────────────────
const WIND_CACHE_KEY = 'wind_data_cache';
function _getTodayDate() { return new Date().toISOString().slice(0, 10); }

function _saveWindCache(grid) {
  try {
    localStorage.setItem(WIND_CACHE_KEY, JSON.stringify({
      date:   _getTodayDate(),
      lngs:   Array.from(grid.lngs),
      lats:   Array.from(grid.lats),
      points: grid.points,
    }));
  } catch (e) { console.warn('[Wind] 캐시 저장 실패:', e.message); }
}

function _loadWindCache() {
  try {
    const raw = localStorage.getItem(WIND_CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p.date !== _getTodayDate()) return null;
    return {
      lngs:   new Float32Array(p.lngs),
      lats:   new Float32Array(p.lats),
      points: p.points,
    };
  } catch (e) { console.warn('[Wind] 캐시 로드 실패:', e.message); return null; }
}

// ── 풍속/풍향(단일) → deg UV 변환 헬퍼 ──────────────────────────────────────
function _spdDirToUV(spd, dir) {
  const rad = ((dir + 180) % 360) * (Math.PI / 180);
  return [spd * Math.sin(rad), spd * Math.cos(rad)];
}

// ── 폴백: 균일 바람을 3×3 격자에 채워 엔진에 적용 ───────────────────────────
function _applyWindData({ spd10, dir10, spd80, dir80 }) {
  const b    = map.getBounds();
  const lngs = Array.from({ length: GRID_COLS }, (_, c) =>
    b.getWest()  + (c / (GRID_COLS - 1)) * (b.getEast()  - b.getWest()));
  const lats = Array.from({ length: GRID_ROWS }, (_, r) =>
    b.getSouth() + (r / (GRID_ROWS - 1)) * (b.getNorth() - b.getSouth()));
  const n = GRID_COLS * GRID_ROWS;

  const [u10v, v10v] = _spdDirToUV(spd10, dir10);
  const [u80v, v80v] = _spdDirToUV(spd80, dir80);

  const uArr   = new Float32Array(n).fill(params.useHeight ? u80v : u10v);
  const vArr   = new Float32Array(n).fill(params.useHeight ? v80v : v10v);
  const uArr10 = new Float32Array(n).fill(u10v);
  const vArr10 = new Float32Array(n).fill(v10v);
  const uArr80 = new Float32Array(n).fill(u80v);
  const vArr80 = new Float32Array(n).fill(v80v);

  _applyAutoParams(params.useHeight ? spd80 : spd10);
  engine.setWindData(lngs, lats, uArr, vArr);
  engine.setWindData10m(lngs, lats, uArr10, vArr10);
  engine.setWindData80m(lngs, lats, uArr80, vArr80);
  _rebuildAndClear();
  engine.reset();
  _updateWindBadge(params.useHeight ? spd80 : spd10,
                   params.useHeight ? dir80  : dir10,
                   params.useHeight);
}

// ── 멀티포인트 격자 → 엔진 적용 (핵심) ─────────────────────────────────────
// dailyWindGrid.points[col + row*COLS] 의 현재 시간 값을 셀별 U/V로 변환해
// engine.setWindData에 실제 다른 값의 3×3 격자로 주입.
// 엔진 내부 bilinear interpolation이 나머지 보간을 담당.
function _applyCurrentHourWindGrid(overrideH) {
  const grid = window.dailyWindGrid;
  if (!grid) return;

  const hi = Math.min(overrideH !== undefined ? overrideH : _effectiveHour(), 23);
  const n  = GRID_COLS * GRID_ROWS;

  const uArr   = new Float32Array(n);
  const vArr   = new Float32Array(n);
  const uArr10 = new Float32Array(n);
  const vArr10 = new Float32Array(n);
  const uArr80 = new Float32Array(n);
  const vArr80 = new Float32Array(n);

  let maxSpd = 0;

  for (let i = 0; i < n; i++) {
    const d    = grid.points[i].hourly;
    const len  = d.wind_speed_10m?.length ?? 0;
    const idx  = Math.min(hi, len - 1);

    const spd10 = d.wind_speed_10m?.[idx]    ?? 3.0;
    const dir10 = d.wind_direction_10m?.[idx] ?? 270;
    const spd80 = d.wind_speed_80m?.[idx]    ?? spd10 * 1.4;
    const dir80 = d.wind_direction_80m?.[idx] ?? dir10;

    const [u10, v10] = _spdDirToUV(spd10, dir10);
    const [u80, v80] = _spdDirToUV(spd80, dir80);

    uArr10[i] = u10; vArr10[i] = v10;
    uArr80[i] = u80; vArr80[i] = v80;
    uArr[i]   = params.useHeight ? u80 : u10;
    vArr[i]   = params.useHeight ? v80 : v10;

    const spd = params.useHeight ? spd80 : spd10;
    if (spd > maxSpd) maxSpd = spd;
  }

  // 중앙 셀(인덱스 4)을 배지 표시 기준으로 사용
  const ci  = Math.floor(n / 2);
  const cd  = grid.points[ci].hourly;
  const idx = Math.min(hi, (cd.wind_speed_10m?.length ?? 1) - 1);
  const cs10 = cd.wind_speed_10m?.[idx]    ?? 3.0;
  const cd10 = cd.wind_direction_10m?.[idx] ?? 270;
  const cs80 = cd.wind_speed_80m?.[idx]    ?? cs10 * 1.4;
  const cd80 = cd.wind_direction_80m?.[idx] ?? cd10;
  window.currentWindData = { spd10: cs10, dir10: cd10, spd80: cs80, dir80: cd80 };

  _applyAutoParams(maxSpd);
  engine.setWindData(grid.lngs, grid.lats, uArr, vArr);
  engine.setWindData10m(grid.lngs, grid.lats, uArr10, vArr10);
  engine.setWindData80m(grid.lngs, grid.lats, uArr80, vArr80);
  _rebuildAndClear();
  engine.reset();
  _updateWindBadge(params.useHeight ? cs80 : cs10,
                   params.useHeight ? cd80 : cd10,
                   params.useHeight);
  // 자동 모드일 때만 환경 갱신 (시뮬레이션 모드에서는 슬라이더가 직접 제어)
  if (_simHour === null) _applyMapEnvironment(hi);

  console.log(
    `[Wind] ⏰ ${hi}시 멀티포인트 적용 (${n}셀)` +
    `  중앙 10m: ${cs10.toFixed(1)}m/s ${cd10}°` +
    `  최대: ${maxSpd.toFixed(1)}m/s`,
  );
}

/** 앱 로드 1회 + 수동 동기화 + 8시간 자동 갱신:
 *  뷰포트 3×3 = 9개 지점의 24시간 데이터를 배치 API로 수신 */
async function fetchWindField(forceRefresh = false) {
  if (isFetching) return;

  // ── 캐시 우선 확인 (수동 갱신[forceRefresh=true] 시에는 건너뜀) ────────────
  if (!forceRefresh) {
    const cached = _loadWindCache();
    if (cached) {
      console.log('[Wind] 로컬 캐시에서 기상 데이터를 불러왔습니다');
      window.dailyWindGrid = cached;
      _applyCurrentHourWindGrid();
      setStatus(null);
      return;
    }
  }
  console.log('[Wind] 새로운 기상 데이터를 요청합니다');

  isFetching = true;
  _lastFetchZoom = map.getZoom();
  _lastFetchTime = Date.now();
  _lastGridFetchMs = Date.now();

  const btn = document.getElementById('wind-sync-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 로딩 중...'; }
  setStatus('🌐 멀티포인트 기상 데이터 로드 중...');

  try {
    const b = map.getBounds();
    // 뷰포트 안쪽 15% 패딩: 가장자리 데이터가 경계 밖으로 나가지 않도록
    const padLng = (b.getEast()  - b.getWest())  * 0.15;
    const padLat = (b.getNorth() - b.getSouth()) * 0.15;

    // 3열 경도 (서→동)
    const gLngs = [
      b.getWest()  + padLng,
      (b.getWest()  + b.getEast())  / 2,
      b.getEast()  - padLng,
    ];
    // 3행 위도 (남→북) — row 0=남, row 2=북
    const gLats = [
      b.getSouth() + padLat,
      (b.getSouth() + b.getNorth()) / 2,
      b.getNorth() - padLat,
    ];

    // 9개 지점 목록 (col + row*COLS 순서, 엔진과 동일한 row-major)
    const pts = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        pts.push({ lat: gLats[r], lng: gLngs[c] });
      }
    }

    // Open-Meteo 배치 API: latitude/longitude에 쉼표 구분 9개 좌표
    const latStr = pts.map(p => p.lat.toFixed(4)).join(',');
    const lngStr = pts.map(p => p.lng.toFixed(4)).join(',');
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${latStr}&longitude=${lngStr}` +
      `&hourly=wind_speed_10m,wind_direction_10m,wind_speed_80m,wind_direction_80m` +
      `&forecast_days=1&wind_speed_unit=ms&timezone=auto`;

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 15000); // 9개 지점 → 15초
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();

    // 단일 지점이면 배열로, 배열이면 그대로
    const responses = Array.isArray(raw) ? raw : [raw];

    // Float32Array로 격자 좌표 보관 (엔진 setWindData 형식)
    const lngsF32 = new Float32Array(gLngs);
    const latsF32 = new Float32Array(gLats);

    window.dailyWindGrid = {
      lngs:   lngsF32,
      lats:   latsF32,
      points: responses.map((d, i) => ({
        lat:    pts[i].lat,
        lng:    pts[i].lng,
        hourly: d.hourly ?? {},
      })),
    };

    _saveWindCache(window.dailyWindGrid);   // ← 오늘 날짜와 함께 캐시 저장
    _applyCurrentHourWindGrid();
    setStatus(null);

    console.log(`[Wind] ✓ 멀티포인트 ${responses.length}개 지점 수신 — 매 정각 자동 전환`);

  } catch (err) {
    const is429    = err.message.includes('429');
    const isAbort  = err.name === 'AbortError';
    console.warn(`[Wind] API 실패 (${err.message})`);

    if (window.dailyWindGrid) {
      _applyCurrentHourWindGrid();
      setStatus(`⚠ ${is429 ? 'API 초과' : isAbort ? '응답 시간 초과' : '연결 실패'} — 기존 데이터 유지`, 5000);
    } else if (window.currentWindData) {
      _applyWindData(window.currentWindData);
      _applyMapEnvironment();
      setStatus('⚠ 연결 실패 — 이전 데이터 유지', 5000);
    } else {
      _applyFallbackWind();
      setStatus('⚠ 기상 연결 실패 (기본 바람 적용)', 5000);
    }
  } finally {
    isFetching = false;
    if (btn) { btn.disabled = false; btn.textContent = '🔄 기상 동기화'; }
  }
}

/** 폴백: 지상 3 m/s · 상층 8 m/s 서풍 — 환경도 함께 초기화 */
function _applyFallbackWind() {
  _applyWindData({ spd10: 3.0, dir10: 270, spd80: 8.0, dir80: 270 });
  _applyMapEnvironment();
  console.log('[Wind] 기본 바람 데이터 사용 중 (지상 3 m/s, 상층 8 m/s, 서풍)');
}

// ══════════════════════════════════════════════════════════════════════════════
// 시간대 기반 지도 환경 (조명 + 안개)
//   MORNING   05~11 : 동쪽 낮은 노란빛 + 옅은 아침 안개
//   AFTERNOON 11~17 : 수직 백색 직사광 + 맑은 하늘
//   EVENING   17~05 : 서쪽 낮은 주황빛 + 노을 안개 (화재 연출 최적)
// ══════════════════════════════════════════════════════════════════════════════

function _getTimeOfDay(h) {
  const hour = h !== undefined ? h : _effectiveHour();
  if (hour >= 5  && hour < 11) return 'MORNING';
  if (hour >= 11 && hour < 17) return 'AFTERNOON';
  return 'EVENING';
}

// ── 시간별 조명 키프레임 (15개) ───────────────────────────────────────────────
// col=광원색[r,g,b]  it=강도  fog/fogH=안개[r,g,b,a]  hb=수평혼합  rn=가시거리
// st=별  sp=우주색[r,g,b]  sky=하늘대기색[r,g,b]  skyI=태양강도  skyHalo=헤일로[r,g,b]
const _LK = [
  { h: 0,  az:  0, po:92, col:[8,6,28],     it:0.08,
    fog:[3,3,14,0.97],      fogH:[1,1,5,0.99],       hb:0.00, rn:[0,1.5], st:0.50, sp:[2,1,8],
    sky:[2,2,12],    skyI:0,   skyHalo:[5,3,15]    },
  { h: 4,  az: 68, po:91, col:[14,10,32],   it:0.08,
    fog:[7,5,18,0.94],      fogH:[2,1,8,0.97],       hb:0.00, rn:[0,1.5], st:0.45, sp:[3,2,10],
    sky:[3,2,15],    skyI:0,   skyHalo:[8,4,20]    },
  { h: 5,  az: 78, po:86, col:[190,75,42],  it:0.28,
    fog:[78,30,12,0.72],    fogH:[30,9,4,0.74],      hb:0.24, rn:[0.4,7], st:0.12, sp:[8,4,16],
    sky:[125,48,22], skyI:4,   skyHalo:[210,85,32]  },
  { h: 6,  az: 83, po:76, col:[228,112,48], it:0.42,
    fog:[148,68,20,0.56],   fogH:[58,20,5,0.48],     hb:0.24, rn:[0.7,9], st:0.00, sp:[15,8,25],
    sky:[185,82,32], skyI:10,  skyHalo:[255,160,55]  },
  { h: 8,  az: 95, po:56, col:[255,205,78], it:0.58,
    fog:[180,210,240,0.55], fogH:[130,180,220,0.35], hb:0.13, rn:[1,14],  st:0.00, sp:[28,48,80],
    sky:[105,165,225],skyI:18, skyHalo:[255,238,185] },
  { h:10,  az:135, po:28, col:[255,235,165],it:0.68,
    fog:[200,224,248,0.26], fogH:[170,204,240,0.16], hb:0.08, rn:[2,18],  st:0.00, sp:[38,65,128],
    sky:[72,135,205],skyI:22,  skyHalo:[255,252,225] },
  { h:13,  az:185, po:12, col:[255,255,255],it:0.82,
    fog:[210,230,250,0.16], fogH:[180,210,240,0.06], hb:0.05, rn:[2.5,22],st:0.00, sp:[40,68,130],
    sky:[50,118,198],skyI:28,  skyHalo:[255,255,245] },
  { h:15,  az:222, po:28, col:[255,232,155],it:0.72,
    fog:[200,220,244,0.20], fogH:[170,200,234,0.10], hb:0.07, rn:[2,18],  st:0.00, sp:[38,62,125],
    sky:[62,128,205],skyI:24,  skyHalo:[255,252,210] },
  { h:16,  az:244, po:47, col:[255,198,78], it:0.78,
    fog:[200,150,78,0.26],  fogH:[120,58,20,0.16],   hb:0.13, rn:[1.4,13],st:0.00, sp:[25,30,65],
    sky:[145,105,62],skyI:20,  skyHalo:[255,215,105] },
  { h:17,  az:257, po:64, col:[255,128,20], it:0.86,
    fog:[192,78,20,0.54],   fogH:[80,20,5,0.52],     hb:0.34, rn:[0.4,7], st:0.06, sp:[12,6,20],
    sky:[208,82,22], skyI:14,  skyHalo:[255,162,42]  },
  { h:18,  az:268, po:77, col:[255,110,14], it:0.92,
    fog:[192,60,8,0.75],    fogH:[60,11,3,0.72],     hb:0.54, rn:[0.25,5],st:0.24, sp:[5,2,12],
    sky:[228,68,12], skyI:9,   skyHalo:[255,125,22]  },
  { h:19,  az:277, po:87, col:[200,70,6],   it:0.68,
    fog:[118,30,4,0.84],    fogH:[30,6,1,0.90],      hb:0.40, rn:[0.15,3.5],st:0.34,sp:[4,2,10],
    sky:[145,32,6],  skyI:3,   skyHalo:[225,82,16]   },
  { h:20,  az:283, po:91, col:[48,15,6],    it:0.18,
    fog:[20,5,2,0.93],      fogH:[6,1,1,0.95],       hb:0.18, rn:[0.1,2.5],st:0.44,sp:[3,1,8],
    sky:[16,6,2],    skyI:0,   skyHalo:[42,12,6]     },
  { h:21,  az:290, po:92, col:[18,7,14],    it:0.09,
    fog:[5,3,10,0.95],      fogH:[2,1,5,0.97],       hb:0.05, rn:[0,1.5], st:0.50, sp:[2,1,8],
    sky:[3,2,12],    skyI:0,   skyHalo:[6,3,18]      },
  { h:23,  az:300, po:92, col:[8,6,28],     it:0.08,
    fog:[3,3,14,0.97],      fogH:[1,1,5,0.99],       hb:0.00, rn:[0,1.5], st:0.50, sp:[2,1,8],
    sky:[2,2,12],    skyI:0,   skyHalo:[5,3,15]      },
];

/** 분수 시간(0.0~23.99)으로 두 키프레임 사이를 선형 보간 */
function _lerpLightKey(h) {
  const k = _LK;
  if (h <= k[0].h) return _keyToOut(k[0], k[0], 0);
  if (h >= k[k.length-1].h) return _keyToOut(k[k.length-1], k[k.length-1], 0);
  let lo = k[0], hi = k[1];
  for (let i = 0; i < k.length-1; i++) {
    if (h >= k[i].h && h < k[i+1].h) { lo = k[i]; hi = k[i+1]; break; }
  }
  return _keyToOut(lo, hi, (h - lo.h) / (hi.h - lo.h));
}

function _keyToOut(lo, hi, t) {
  // Smoothstep easing — 끊김 없는 부드러운 보간
  const s  = t * t * (3 - 2*t);
  const lv = (a, b) => a + (b - a) * s;
  const la = (a, b) => a.map((v, i) => lv(v, b[i]));
  const hexC = c => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2,'0')).join('');
  const rgbaC = c => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3].toFixed(3)})`;
  return {
    az:      lv(lo.az,  hi.az),
    po:      lv(lo.po,  hi.po),
    col:     hexC(la(lo.col,  hi.col)),
    it:      lv(lo.it,  hi.it),
    fog:     rgbaC(la(lo.fog,  hi.fog)),
    fogH:    rgbaC(la(lo.fogH, hi.fogH)),
    hb:      lv(lo.hb,  hi.hb),
    rn:      la(lo.rn,  hi.rn),
    st:      lv(lo.st ?? 0,   hi.st ?? 0),
    sp:      hexC(la(lo.sp ?? [2,2,10], hi.sp ?? [2,2,10])),
  };
}

function _applyMapEnvironment(overrideH) {
  const h  = overrideH !== undefined ? Number(overrideH) : _effectiveHour();
  const lk = _lerpLightKey(h);
  // 환경 갱신 시 fire 조명 캐시 무효화 → 다음 프레임에 _updateFireLight 재실행
  if (typeof _prevFireVentCnt !== 'undefined') _prevFireVentCnt = -1;

  // 1. 조명 — 태양 고도·방위·색상·강도
  try {
    map.setLight({
      anchor:    'map',
      color:     lk.col,
      intensity: lk.it,
      position:  [1.5, lk.az, lk.po],
    });
  } catch(e) { console.warn('[Env] setLight 실패:', e.message); }

  // 2. 대기 안개 — 거리감·공기감·별
  try {
    if (typeof map.setFog === 'function') {
      map.setFog({
        color:            lk.fog,
        'high-color':     lk.fogH,
        'horizon-blend':  lk.hb,
        range:            lk.rn,
        'star-intensity': lk.st,
        'space-color':    lk.sp,
      });
    }
  } catch(e) { console.warn('[Env] setFog 실패:', e.message); }

  // 3. 건물 셰이딩 — 시간대별 색상 + 수직 그라디언트
  _applyBuildingColor(h);

  console.log(`[Env] 🌤 ${h.toFixed(2)}h | az${lk.az.toFixed(0)}° po${lk.po.toFixed(0)}° | it${lk.it.toFixed(2)}`);
}

/** 시간대별 건물 색상 + fill-extrusion-vertical-gradient 제어 */
function _applyBuildingColor(h) {
  try {
    const layers = map.getStyle().layers.filter(l => l.type === 'fill-extrusion');
    if (!layers.length) return;

    const htExpr = ['coalesce', ['get', 'render_height'], ['get', 'height'], 0];

    let baseStep, useGradient;

    if (h >= 17 && h < 20) {
      // ── 황금시간: 하단 앰버→상단 냉청 실루엣, vertical-gradient ON ──
      // 절정 18.5시 기준 종 모양 강도
      const f = Math.min(1, h < 18.5 ? (h-17)/1.5 : (20-h)/1.5);
      const w = Math.round(95 * f);           // 0(무) ~ 95(절정)
      useGradient = true;
      baseStep = [
        'step', htExpr,
        `rgb(${22+w},${14+Math.round(w*0.25)},${28})`,
         5,  `rgb(${30+w},${18+Math.round(w*0.25)},${34})`,
        15,  `rgb(${38+w},${24+Math.round(w*0.20)},${42})`,
        30,  `rgb(${40+Math.round(w*0.5)},${38+Math.round(w*0.1)},${56})`,
        80,  '#50546c',
      ];

    } else if (h >= 20 || h < 5) {
      // ── 심야: #111 수준 극암 + 고층부에만 희미한 창문 앰비언트 ──
      useGradient = true;   // 수직 그라디언트로 지붕 반사 표현
      baseStep = [
        'step', htExpr,
        '#0d0c18',   //  0~5m  : 지상층, 완전 암흑
         5,  '#100f1e',   //  5~15m : 저층부
        15,  '#13121f',   // 15~30m : 중층부
        30,  '#161425',   // 30~80m : 사무빌딩 — 창 산란광 미세 틴트
        80,  '#1a182c',   // 80m+   : 고층타워 — 상단에 은은한 도시광
      ];

    } else if (h >= 5 && h < 7) {
      // ── 새벽: 보라빛 어둠에서 서서히 깨어남 ──
      const f = (h - 5) / 2;   // 0→1
      useGradient = true;
      const dkR = Math.round(20 + f*12), dkG = Math.round(18 + f*14), dkB = Math.round(34 + f*12);
      baseStep = [
        'step', htExpr,
        `rgb(${dkR},${dkG},${dkB})`,
         5,  `rgb(${dkR+4},${dkG+4},${dkB+4})`,
        15,  `rgb(${dkR+8},${dkG+8},${dkB+8})`,
        30,  `rgb(${dkR+14},${dkG+12},${dkB+14})`,
        80,  `rgb(${dkR+20},${dkG+18},${dkB+18})`,
      ];

    } else {
      // ── 주간 기본: 중성 청회색 ──
      useGradient = true;
      baseStep = [
        'step', htExpr,
        '#2a2d3e', 5, '#303350', 15, '#3a3d5a', 30, '#444760', 80, '#505468',
      ];
    }

    layers.forEach(l => {
      map.setPaintProperty(l.id, 'fill-extrusion-color', baseStep);
      map.setPaintProperty(l.id, 'fill-extrusion-vertical-gradient', useGradient);
    });
  } catch (e) { /* 스타일 미로드 */ }
}

// ── Nominatim 역지오코딩 ──────────────────────────────────────────────────────
let geoTimer = null;
function fetchLocationName() {
  clearTimeout(geoTimer);
  geoTimer = setTimeout(async () => {
    const c = map.getCenter();
    try {
      const res  = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json` +
        `&lat=${c.lat.toFixed(5)}&lon=${c.lng.toFixed(5)}&zoom=10`,
        { headers: { 'Accept-Language': 'ko' } },
      );
      const data = await res.json();
      const a    = data.address ?? {};
      const name = a.county || a.city || a.state || a.country ||
                   data.display_name?.split(',')[0] ||
                   `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
      const el = document.getElementById('location-label');
      if (el) el.textContent = `📍 ${name}`;
    } catch {
      const el = document.getElementById('location-label');
      if (el) {
        const c2 = map.getCenter();
        el.textContent = `📍 ${c2.lat.toFixed(3)}, ${c2.lng.toFixed(3)}`;
      }
    }
  }, 700);
}

// ══════════════════════════════════════════════════════════════════════════════
// 주소 검색 (Nominatim) + 비행 이동
// ══════════════════════════════════════════════════════════════════════════════

;(function _initAddressSearch() {
  const labelEl   = document.getElementById('location-label');
  const boxEl     = document.getElementById('search-box');
  const inputEl   = document.getElementById('search-input');
  const closeEl   = document.getElementById('search-close');
  const resultsEl = document.getElementById('search-results');
  if (!labelEl || !boxEl || !inputEl) return;

  let _searchTimer  = null;
  let _searchCtrl   = null;   // AbortController

  function openSearch() {
    labelEl.style.display = 'none';
    boxEl.classList.add('active');
    inputEl.value = '';
    inputEl.focus();
  }

  function closeSearch() {
    boxEl.classList.remove('active');
    resultsEl.classList.remove('active');
    resultsEl.innerHTML = '';
    inputEl.value = '';
    labelEl.style.display = '';
    if (_searchCtrl) { _searchCtrl.abort(); _searchCtrl = null; }
    clearTimeout(_searchTimer);
  }

  function showResults(items) {
    resultsEl.innerHTML = '';
    if (!items.length) {
      resultsEl.innerHTML = '<div class="sr-empty">검색 결과가 없습니다</div>';
      resultsEl.classList.add('active');
      return;
    }
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'sr-item';

      // 표시 이름 분리: 앞부분 = 장소명, 나머지 = 상세주소
      const parts = item.display_name.split(',');
      const name  = parts[0].trim();
      const detail = parts.slice(1, 4).join(',').trim();

      el.innerHTML =
        `<div class="sr-name">${name}</div>` +
        (detail ? `<div class="sr-detail">${detail}</div>` : '');

      el.addEventListener('mousedown', e => {
        e.preventDefault();   // blur 이벤트가 먼저 닫히지 않도록
        closeSearch();
        // 현재 위치명 즉시 표시
        labelEl.textContent = `📍 ${name}`;
        // 비행 이동 (줌 17, curve로 지구 표면 스쳐가는 연출)
        map.flyTo({
          center:   [parseFloat(item.lon), parseFloat(item.lat)],
          zoom:     17,
          duration: 2800,
          curve:    1.6,
          speed:    1.2,
          essential: true,
        });
      });
      resultsEl.appendChild(el);
    });
    resultsEl.classList.add('active');
  }

  async function doSearch(q) {
    if (_searchCtrl) _searchCtrl.abort();
    _searchCtrl = new AbortController();
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&addressdetails=1`,
        { headers: { 'Accept-Language': 'ko' }, signal: _searchCtrl.signal },
      );
      const data = await res.json();
      showResults(data);
    } catch (e) {
      if (e.name !== 'AbortError') showResults([]);
    }
  }

  // 핀 배지 클릭 → 검색 모드
  labelEl.addEventListener('click', openSearch);

  // 닫기 버튼
  closeEl.addEventListener('click', closeSearch);

  // 입력 → 300ms 디바운스 검색
  inputEl.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    const q = inputEl.value.trim();
    if (!q) { resultsEl.classList.remove('active'); resultsEl.innerHTML = ''; return; }
    _searchTimer = setTimeout(() => doSearch(q), 300);
  });

  // Enter 키 → 즉시 검색
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(_searchTimer);
      const q = inputEl.value.trim();
      if (q) doSearch(q);
    }
    if (e.key === 'Escape') closeSearch();
  });

  // 검색창 바깥 클릭 → 닫기
  document.addEventListener('mousedown', e => {
    const wrap = document.getElementById('location-search-wrap');
    if (wrap && !wrap.contains(e.target)) closeSearch();
  });
})();

// ══════════════════════════════════════════════════════════════════════════════
// 색상 함수
// ══════════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════════
// 색상 헬퍼
// ══════════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════════
// 렌더링
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 배경 바람 입자 렌더 — Windy 스타일 형광 하늘색
 *
 * 렌더 기법:
 *   · 느린 잔상 소멸 (trailFade=0.012) → 입자가 지나간 자리에 긴 꼬리
 *   · 속도 → 밝기·투명도 비례: 빠름=발광하는 밝은 시안, 느림=짙은 남색
 *   · Pass A (미세 글로우, s>0.3): 3× 굵기, 낮은 alpha → 위성 지도 위 가시성
 *   · Pass B (코어): 얇은 선, 선명 → 흐름 경로 명확
 *   · shadowBlur=2: 형광 특유의 미세 발광감 (성능: 루프 밖 1회 설정)
 */
function renderParticles() {
  const tw = trailCanvas.width, th = trailCanvas.height;

  // Windy 스타일 긴 잔상 (배경 바람이 지나간 경로가 오래 남음)
  trailCtx.globalCompositeOperation = 'destination-out';
  trailCtx.fillStyle = `rgba(0,0,0,${params.trailFade})`;
  trailCtx.fillRect(0, 0, tw, th);
  trailCtx.globalCompositeOperation = 'source-over';

  trailCtx.lineCap  = 'round';
  trailCtx.lineJoin = 'round';

  // 형광 하늘색 발광 분위기 (낮은 shadowBlur — 너무 강하면 smoke와 혼동)
  trailCtx.shadowColor = 'rgba(0, 220, 255, 0.7)';
  trailCtx.shadowBlur  = 2 * dpr;

  const baseW = params.lineWidth * dpr;

  for (let i = 0; i < engine.count; i++) {
    const s = engine.spd[i];
    if (s < 0.012) continue;

    const pp = map.project([engine.plng[i], engine.plat[i]]);
    const cp = map.project([engine.lng[i],  engine.lat[i]]);
    const x0 = pp.x * dpr, y0 = pp.y * dpr;
    const x1 = cp.x * dpr, y1 = cp.y * dpr;

    const dx = x1-x0, dy = y1-y0;
    if (dx*dx + dy*dy > (80*dpr)*(80*dpr)) continue;

    const lifeAlpha = Math.min(engine.age[i] / 20, 1.0);

    // 속도 → HSL(195) 밝기·농도 매핑
    //   느림(s→0): L=35%, alpha=0.40 → 어두운 심해 파랑
    //   빠름(s→1): L=75%, alpha=0.85 → 밝은 형광 시안
    const L     = 35 + s * 42;
    const alpha = (0.40 + s * 0.45) * lifeAlpha;

    // Pass A: 미세 글로우 (빠른 입자만 — 위성 위 가시성 강화)
    if (s > 0.30) {
      trailCtx.lineWidth   = baseW * 3.0;
      trailCtx.strokeStyle = `hsla(195, 92%, ${L}%, ${(alpha * 0.15).toFixed(3)})`;
      trailCtx.beginPath();
      trailCtx.moveTo(x0, y0); trailCtx.lineTo(x1, y1);
      trailCtx.stroke();
    }

    // Pass B: 형광 하늘색 코어 (얇고 선명)
    trailCtx.lineWidth   = baseW * (0.5 + s * 0.5);
    trailCtx.strokeStyle = `hsla(195, 100%, ${L}%, ${alpha.toFixed(3)})`;
    trailCtx.beginPath();
    trailCtx.moveTo(x0, y0); trailCtx.lineTo(x1, y1);
    trailCtx.stroke();
  }

  trailCtx.shadowBlur = 0;
}

// 연기/화재/가스는 renderSmoke() — smokeCanvas에 canvas 2D로 렌더링

/** 확산원 맥동 링 아이콘 */
let _ventPulse = 0;
function renderVentIcons() {
  ventCtx.clearRect(0, 0, ventCanvas.width, ventCanvas.height);
  if (engine.vents.length === 0) return;
  _ventPulse += 0.05;

  for (const vent of engine.vents) {
    const pos = map.project([vent.lng, vent.lat]);
    const cx  = pos.x * dpr, cy = pos.y * dpr;

    // 영향 반경 원 (희미하게) — 성장 애니메이션 반영
    const sigPx = _metersToScreenPx(engine._effectiveSigma(vent), vent.lat) * dpr;
    if (sigPx < 600 * dpr) {  // 너무 크면 생략
      ventCtx.beginPath();
      ventCtx.arc(cx, cy, sigPx, 0, Math.PI * 2);
      ventCtx.strokeStyle = 'rgba(255,140,40,0.08)';
      ventCtx.lineWidth   = 1 * dpr;
      ventCtx.stroke();
    }

    // 맥동 링 3개 (화재=빨강, 가스=주황)
    const ringColor = engine.fireMode ? '255,50,20' : '255,140,30';
    for (let k = 0; k < 3; k++) {
      const phase  = (_ventPulse + k * Math.PI * 2 / 3) % (Math.PI * 2);
      const t      = phase / (Math.PI * 2);
      const radius = (5 + t * 26) * dpr;
      const alpha  = (1 - t) * 0.85;
      ventCtx.beginPath();
      ventCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      ventCtx.strokeStyle = `rgba(${ringColor},${alpha.toFixed(3)})`;
      ventCtx.lineWidth   = engine.fireMode ? 2.2 * dpr : 1.8 * dpr;
      ventCtx.stroke();
    }

    // 중심 점 (화재=밝은 빨강, 가스=노랑)
    ventCtx.beginPath();
    ventCtx.arc(cx, cy, 4.5 * dpr, 0, Math.PI * 2);
    ventCtx.fillStyle = engine.fireMode ? 'rgba(255,80,30,0.95)' : 'rgba(255,190,60,0.95)';
    ventCtx.fill();
  }
}

// ── 건물 발화 감지 ─────────────────────────────────────────────────────────────
/**
 * 매 20프레임마다 화재 입자 샘플링 → queryRenderedFeatures로 건물 위 감지
 * 열기 누적 → 임계치 초과 시 해당 건물에 새 발화점 생성 + 빨간색 표시
 */
function _checkBuildingIgnition() {
  if (!engine.fireMode || !engine.fireSpread || engine.vents.length === 0) return;
  _ignCheckFrame++;

  // 풍속에 따른 점검 주기 조절: 강풍일수록 자주 점검 (빠른 전파)
  const windSpd = window.currentWindData
    ? (params.useHeight ? window.currentWindData.spd80 : window.currentWindData.spd10)
    : 3.0;
  // interval: 5m/s → 15프레임, 10m/s → 10프레임, 1m/s → 25프레임
  const checkInterval = Math.max(8, Math.round(20 - windSpd * 1.2));
  if (_ignCheckFrame % checkInterval !== 0) return;

  // 풍속 기반 발화 임계치: 강풍→낮은 임계(빠른 발화), 약풍→높은 임계(느린 발화)
  // 5m/s → 10,  10m/s → 6,  1m/s → 18
  const igniteThreshold = Math.max(4, Math.round(14 - windSpd * 0.9));

  // heat decay: 매 tick마다 열기를 1씩 감쇠 (지속 노출 없으면 자연 냉각)
  for (const [k, v] of _buildingHeat) {
    if (v <= 1) _buildingHeat.delete(k);
    else        _buildingHeat.set(k, v - 1);
  }

  // 저고도(z<30m) 화재 입자만 샘플링
  const candidates = [];
  for (let i = 0; i < engine.smokeCount; i++) {
    if (engine.sAge[i] >= engine.sLife[i]) continue;
    if (engine.sModeArr[i] !== 1)          continue;
    if (engine.sZ[i] > 30 || engine.sZ[i] < 0.5) continue;
    if (engine.sConc[i] < 0.2)            continue;
    candidates.push(i);
  }
  if (candidates.length === 0) return;

  // 최대 40개 랜덤 샘플 (열기 누적 속도 조절)
  const sample = candidates.length <= 40
    ? candidates
    : Array.from({ length: 40 }, () => candidates[Math.floor(Math.random() * candidates.length)]);

  for (const i of sample) {
    const screenPt = map.project([engine.sLng[i], engine.sLat[i]]);
    let features;
    try {
      features = map.queryRenderedFeatures(
        [screenPt.x, screenPt.y], {}
      ).filter(f => f.layer.type === 'fill-extrusion');
    } catch { continue; }
    if (features.length === 0) continue;

    const f   = features[0];
    // feature ID가 유효한 경우만 키로 사용 (null/undefined 건물은 스킵)
    const fid = f.id ?? f.properties?.id;
    if (fid == null) continue;
    const key = `${f.source}::${f.sourceLayer ?? ''}::${fid}`;

    // 열기 누적
    const heat = (_buildingHeat.get(key) ?? 0) + 1;
    _buildingHeat.set(key, heat);

    // 임계치(풍속 기반) 미달이면 발화 안 함
    if (heat < igniteThreshold) continue;

    const lng = engine.sLng[i], lat = engine.sLat[i];
    // 기존 발화점과 충분히 떨어진 경우만 발화
    const tooClose = _ignitedBldgPts.some(p =>
      Math.hypot(p.lng - lng, p.lat - lat) < 0.0004);
    if (tooClose) continue;

    // 열기 초기화 (발화 후 재발화 방지)
    _buildingHeat.set(key, 0);

    // 새 발화점 추가: 지형 고도 + 건물 높이 (f.properties 에서 직접 추출)
    const terrainElev = map.queryTerrainElevation([lng, lat]) ?? 0;
    const bldgH = Math.max(0, Number(f.properties?.height ?? f.properties?.render_height ?? 0));
    const elevZ = terrainElev + bldgH;
    engine.addVent(lng, lat,
      { strengthMs: params.ventStrength, sigmaM: params.ventSigmaKm * 1000, maxVents: 25, elevZ });
    _ignitedBldgPts.push({ lng, lat });

    setStatus(`🔥 건물 발화! (발화점 ${engine.vents.length}개)`, 3000);
  }
}

/** 미터 거리 → 현재 줌의 CSS px 변환 */
function _metersToScreenPx(meters, lat) {
  const cosLat = Math.cos(lat * Math.PI / 180);
  const dLng   = meters / (111320 * cosLat);
  const ctr    = map.getCenter();
  const pA     = map.project([ctr.lng,        ctr.lat]);
  const pB     = map.project([ctr.lng + dLng,  ctr.lat]);
  return Math.abs(pB.x - pA.x);
}

// ── 메인 렌더 ────────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(trailCanvas, 0, 0);    // 바람 입자 잔상
  ctx.drawImage(smokeCanvas, 0, 0);    // 연기/화재/가스 입자
}

// ══════════════════════════════════════════════════════════════════════════════
// Canvas 연기/화재/가스 파티클 시스템
//   · map.project(lng,lat) 좌표 변환 → 정확한 위치 (deck.gl pitch 변위 없음)
//   · radial gradient 원형 → 소프트 연기 질감
//   · smokeCanvas (오프스크린, 천천히 페이드) → render()에서 합성
//   · 화염: lighter 합성 (가산혼합) → 발광 효과
// ══════════════════════════════════════════════════════════════════════════════

let _prevFireVentCnt = -1;

/**
 * 시간대별 파티클 밝기/색 보정 팩터 반환
 * 낮: ambient=1.0, 밤: ambient 낮아져 연기는 어둡고 화재는 더 밝게 빛남
 */
function _timeLightFactor() {
  const h = _simHour !== null ? _simHour : new Date().getHours();
  // 0~4 / 21~24: 심야
  if (h < 4 || h >= 21) return { smoke: 0.38, gas: 0.50, flame: 1.85, glow: 1.60 };
  // 4~6 / 19~21: 새벽/황혼
  if (h < 6 || h >= 19) return { smoke: 0.55, gas: 0.68, flame: 1.55, glow: 1.35 };
  // 6~9 / 17~19: 아침/저녁 노을
  if (h < 9 || h >= 17) return { smoke: 0.75, gas: 0.82, flame: 1.25, glow: 1.15 };
  // 9~17: 낮
  return { smoke: 1.00, gas: 1.00, flame: 1.00, glow: 1.00 };
}

// 가스 농도→명도 보정: 밤에는 저농도 가스가 더 잘 보임
function _nightGasAlpha(conc, timeFactor) {
  // 밤에는 높은 농도 가스만 더 선명하게
  return timeFactor + (1 - timeFactor) * Math.pow(conc, 0.7);
}


// ── 색상 유틸 ─────────────────────────────────────────────────────────────────

/** HSL(0-360, 0-100, 0-100) → [r,g,b] 0-255 */
function _hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** '#rrggbb' → [r,g,b] */
function _hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

/**
 * 가스 입자 색상 — 4단계 그라데이션
 *   고농도(발원): 밝은 주황  →  중농도: 주황-회  →  저농도: 짙은 회  →  희석: 청회(대기색)
 */
function _dkGasRGB(conc) {
  if (conc >= 0.68) {
    const t = (conc - 0.68) / 0.32;
    return _hslToRgb(22, 100, 52 + t * 12);          // 밝은 주황
  } else if (conc >= 0.38) {
    const t = (conc - 0.38) / 0.30;
    return _hslToRgb(16 + t * 6, 60 + t * 38, 35 + t * 17);  // 중주황
  } else if (conc >= 0.12) {
    const t = (conc - 0.12) / 0.26;
    return _hslToRgb(t * 16, t * 60, 26 + t * 9);   // 회→중주황
  } else {
    const t = conc / 0.12;
    return _hslToRgb(210, 10, 62 + (1 - t) * 12);   // 청회 (대기에 스며듦)
  }
}

/**
 * 화재 화염 기저부 색상 (z < 25m)
 * 백열 핵심 → 황 → 주황 → 적주황
 * 매우 밝은 색상 → 가산혼합 레이어에서 눈부신 발광 효과
 */
function _dkFlameRGB(z) {
  if (z < 2) {
    return [255, 250, 235];                       // 백열 핵심 (거의 흰색)
  } else if (z < 6) {
    const t = (z - 2) / 4;
    return [255, Math.round(250 - t*72), Math.round(235 - t*220)];  // 백열→황
  } else if (z < 13) {
    const t = (z - 6) / 7;
    return [255, Math.round(178 - t*68), Math.round(15 - t*12)];    // 황→주황
  } else {
    const t = Math.min(1, (z - 13) / 12);
    return [Math.round(255 - t*35), Math.round(110 - t*65), Math.round(3)]; // 주황→적주황
  }
}

/**
 * 화재 연기 기둥 색상 (z >= 25m)
 * 적갈 → 흑회 → 중간 회 → 연한 청회 (하늘에 녹아드는 전환)
 */
function _dkSmokeRGB(z) {
  if (z < 55) {
    const t = (z - 25) / 30;
    return _hslToRgb(12 - t * 12, 42 - t * 42, 24 - t * 6);  // 적갈 → 짙은 흑회
  } else if (z < 180) {
    const t = (z - 55) / 125;
    return _hslToRgb(0, 0, 18 + t * 16);                       // 흑회 → 중간 회
  } else {
    const t = Math.min(1, (z - 180) / 220);
    return _hslToRgb(210, 6, 34 + t * 20);                     // 중간 회 → 연한 청회
  }
}

// ── 발화점 조명 (MapLibre 건물 반사) ─────────────────────────────────────────

/**
 * 화재 발화점 수에 따라 MapLibre 건물 환경 조명을 주황빛으로 보정
 * → fill-extrusion 건물 벽면이 화재 빛을 받는 것처럼 보임
 */
function _updateFireLight() {
  const cnt = engine.fireMode ? engine.vents.length : 0;
  if (cnt === _prevFireVentCnt) return;
  _prevFireVentCnt = cnt;

  const h  = _simHour !== null ? _simHour : _effectiveHour();
  const lk = _lerpLightKey(h);

  if (cnt === 0) {
    try { map.setLight({ anchor:'map', color:lk.col, intensity:lk.it, position:[1.5,lk.az,lk.po] }); } catch(e) {}
    return;
  }

  const str  = Math.min(0.65, cnt * 0.13);
  const base = _hexToRgb(lk.col);
  const fire = [255, 105, 18];
  const rc   = v => Math.round(Math.min(255, v));
  const blR  = rc(base[0] + (fire[0]-base[0]) * str);
  const blG  = rc(base[1] + (fire[1]-base[1]) * str);
  const blB  = rc(base[2] + (fire[2]-base[2]) * str);
  const blI  = Math.min(1.0, lk.it + str * 0.28);

  try {
    map.setLight({ anchor:'map', color:`rgb(${blR},${blG},${blB})`, intensity:blI, position:[1.5,lk.az,lk.po] });
  } catch(e) {}
}

// ── Canvas 기반 연기/화재/가스 렌더러 ────────────────────────────────────────

/**
 * 매 프레임 smokeCanvas에 연기·화재·가스 입자를 radial gradient 원으로 그림.
 * map.project([lng, lat]) 로 화면 좌표 변환 → deck.gl pitch 변위 없음.
 *
 * [레이어 순서] (smokeCanvas 위에서 아래로 합성)
 *   1. 연기 기둥 (source-over, z≥25m)
 *   2. 가스 누출 (source-over)
 *   3. 화염 기저 (lighter/가산혼합, z<25m)
 *   4. 지면 글로우 (lighter, vent당 1개 큰 원)
 */
function renderSmoke() {
  const sw = smokeCanvas.width, sh = smokeCanvas.height;

  // 천천히 페이드 (바람 입자보다 훨씬 느리게 — 연기가 오래 남는 효과)
  smokeCtx.globalCompositeOperation = 'destination-out';
  smokeCtx.fillStyle = 'rgba(0,0,0,0.040)';
  smokeCtx.fillRect(0, 0, sw, sh);
  smokeCtx.globalCompositeOperation = 'source-over';

  if (engine.vents.length === 0) return;

  const tf = _timeLightFactor();

  for (let i = 0; i < engine.smokeCount; i++) {
    if (engine.sAge[i] >= engine.sLife[i]) continue;
    const alpha = engine.sAlpha[i];
    if (alpha < 0.016) continue;

    const mode   = engine.sModeArr[i];
    const z      = engine.sZ[i];
    const conc   = engine.sConc[i];
    const growth = engine.sGrowth[i];

    // map.project → 화면 픽셀 (lng/lat만 사용, 고도 변위 없음)
    const sp = map.project([engine.sLng[i], engine.sLat[i]]);
    const sx = sp.x * dpr, sy = sp.y * dpr;

    // 화면 밖 클리핑
    if (sx < -300 || sx > sw + 300 || sy < -300 || sy > sh + 300) continue;

    // 입자별 크기 노이즈 (0.78~1.22, 황금비 수열)
    const sNoise = 0.78 + 0.44 * ((i * 0.61803 + engine.sAge[i] * 0.01) % 1);

    if (mode === 0) {
      // ── GAS ──────────────────────────────────────────────────────────────
      if (conc < 0.006) continue;
      const dilute  = 1 - Math.min(1, conc * 1.15);
      const radiusM = (5 + dilute * 24 + z * 0.22 + growth * 7) * sNoise;
      const rPx     = Math.max(1, _metersToScreenPx(radiusM, engine.sLat[i]) * dpr);

      const aNight = _nightGasAlpha(conc, tf.gas);
      const a      = Math.min(0.82, alpha * aNight * (0.50 + conc * 0.85));
      const [r, g, b] = _dkGasRGB(conc);

      const gr = smokeCtx.createRadialGradient(sx, sy, 0, sx, sy, rPx);
      gr.addColorStop(0.00, `rgba(${r},${g},${b},${a.toFixed(3)})`);
      gr.addColorStop(0.42, `rgba(${r},${g},${b},${(a*0.55).toFixed(3)})`);
      gr.addColorStop(0.72, `rgba(${r},${g},${b},${(a*0.18).toFixed(3)})`);
      gr.addColorStop(1.00, `rgba(${r},${g},${b},0)`);
      smokeCtx.fillStyle = gr;
      smokeCtx.beginPath();
      smokeCtx.arc(sx, sy, rPx, 0, Math.PI * 2);
      smokeCtx.fill();

    } else if (z < 25) {
      // ── FLAME (가산혼합) ──────────────────────────────────────────────────
      const growF   = 0.18 + 0.82 * growth;
      const radiusM = (3 + z * 1.15 + growth * 9) * growF * sNoise;
      const rPx     = Math.max(1, _metersToScreenPx(radiusM, engine.sLat[i]) * dpr);

      const a = Math.min(0.90, alpha * tf.flame * (0.62 + (1 - z / 25) * 0.42));
      const [r, g, b] = _dkFlameRGB(z);

      smokeCtx.globalCompositeOperation = 'lighter';
      const gr = smokeCtx.createRadialGradient(sx, sy, 0, sx, sy, rPx);
      gr.addColorStop(0.00, `rgba(${r},${g},${b},${a.toFixed(3)})`);
      gr.addColorStop(0.38, `rgba(${r},${g},${b},${(a*0.60).toFixed(3)})`);
      gr.addColorStop(0.68, `rgba(${r},${g},${b},${(a*0.18).toFixed(3)})`);
      gr.addColorStop(1.00, `rgba(${r},${g},${b},0)`);
      smokeCtx.fillStyle = gr;
      smokeCtx.beginPath();
      smokeCtx.arc(sx, sy, rPx, 0, Math.PI * 2);
      smokeCtx.fill();
      smokeCtx.globalCompositeOperation = 'source-over';

    } else {
      // ── SMOKE (연기 기둥) ─────────────────────────────────────────────────
      const smokeT  = Math.min(1, (z - 25) / 110);
      const radiusM = (16 + (z - 25) * 0.7 + growth * 20) * sNoise;
      const rPx     = Math.max(2, _metersToScreenPx(radiusM, engine.sLat[i]) * dpr);

      const a = Math.min(0.75, alpha * tf.smoke * (0.88 - smokeT * 0.38));
      if (a < 0.022) continue;
      const [r, g, b] = _dkSmokeRGB(z);

      const gr = smokeCtx.createRadialGradient(sx, sy, 0, sx, sy, rPx);
      gr.addColorStop(0.00, `rgba(${r},${g},${b},${a.toFixed(3)})`);
      gr.addColorStop(0.32, `rgba(${r},${g},${b},${(a*0.72).toFixed(3)})`);
      gr.addColorStop(0.62, `rgba(${r},${g},${b},${(a*0.30).toFixed(3)})`);
      gr.addColorStop(0.85, `rgba(${r},${g},${b},${(a*0.06).toFixed(3)})`);
      gr.addColorStop(1.00, `rgba(${r},${g},${b},0)`);
      smokeCtx.fillStyle = gr;
      smokeCtx.beginPath();
      smokeCtx.arc(sx, sy, rPx, 0, Math.PI * 2);
      smokeCtx.fill();
    }
  }

  // ── 지면 글로우 (화재 발원지 주변 — 가산혼합 큰 원) ─────────────────────────
  if (engine.fireMode && engine.vents.length > 0) {
    smokeCtx.globalCompositeOperation = 'lighter';
    for (const vent of engine.vents) {
      const vp   = map.project([vent.lng, vent.lat]);
      const vx   = vp.x * dpr, vy = vp.y * dpr;
      const glRPx = Math.max(30, _metersToScreenPx(90, vent.lat) * dpr);
      const gr   = smokeCtx.createRadialGradient(vx, vy, 0, vx, vy, glRPx);
      gr.addColorStop(0.0, 'rgba(255,80,10,0.12)');
      gr.addColorStop(0.5, 'rgba(255,50,5,0.05)');
      gr.addColorStop(1.0, 'rgba(255,30,0,0)');
      smokeCtx.fillStyle = gr;
      smokeCtx.beginPath();
      smokeCtx.arc(vx, vy, glRPx, 0, Math.PI * 2);
      smokeCtx.fill();
    }
    smokeCtx.globalCompositeOperation = 'source-over';
  }

  // MapLibre 건물 반사광 보정 (발화 상태 변화 시만 실행)
  _updateFireLight();
}

// ── 애니메이션 루프 ───────────────────────────────────────────────────────────
let frameCount = 0;
function startLoop() { loop(); }
function loop() {
  requestAnimationFrame(loop);
  engine.step();
  _checkBuildingIgnition();
  renderParticles();
  renderSmoke();
  renderVentIcons();
  render();
  frameCount++;

  // 난류 실시간 애니메이션: buildLookup을 주기적으로 재실행해 컬 노이즈 패턴 변경
  // 풍속이 강할수록 더 자주 갱신 (빠른 난류), 약할수록 느리게 (잔잔한 흐름)
  if (engine.hasData) {
    const spd  = engine.maxSpeedMs;                              // 현재 최대 풍속
    const rate = Math.max(30, Math.round(180 - spd * 12));      // 3~12m/s → 180~36프레임
    if (frameCount % rate === 0) {
      engine.buildLookup(map, dpr, _autoSpeedScale * params.speedMult, params.noiseAmt);
    }
  }

  if (frameCount % 300 === 0) {
    autoInfo.elevation = engine.hasElevation ? '✓ 활성' : '⏳ 로딩';
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    console.log(`[TerrainSim] f=${frameCount} maxSpd=${engine.maxSpeedMs.toFixed(1)}m/s elev=${engine.hasElevation}`);
  }
}

// ── UI 헬퍼 ──────────────────────────────────────────────────────────────────
function _updateWindBadge(speedMs, dirDeg, is80m) {
  const dirs = ['북','북동','동','남동','남','남서','서','북서'];
  const dir  = dirs[Math.round(dirDeg / 45) % 8];
  const el   = document.getElementById('w-wind');
  if (el) el.textContent = `${dir} ${speedMs.toFixed(1)} m/s${is80m ? ' ↑80m' : ''}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 시간 시뮬레이션 슬라이더 초기화
// ══════════════════════════════════════════════════════════════════════════════
;(function _initTimeSlider() {
  const sliderEl  = document.getElementById('time-slider');
  const labelEl   = document.getElementById('time-sim-label');
  const resetBtn  = document.getElementById('time-reset-btn');
  if (!sliderEl) return;

  /** 분(0~1439) → "HH:MM" 문자열 */
  const toHHMM = m => {
    const h = Math.floor(m / 60), min = m % 60;
    return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  };

  /** 슬라이더 값(분)으로 시뮬레이션 적용 */
  function applySlider(minVal) {
    const intHour  = Math.floor(minVal / 60);   // 풍향 데이터: 정수 시간
    const fracHour = minVal / 60;               // 조명 보간: 분수 시간 (17.5 = 17:30)
    _simHour = intHour;
    labelEl.textContent = `🕐 ${toHHMM(minVal)} 시뮬레이션`;
    resetBtn.style.opacity = '1';
    resetBtn.style.pointerEvents = 'all';

    // 1. 풍향 데이터 갱신 (정수 시간, hourly 데이터)
    if (window.dailyWindGrid) {
      _applyCurrentHourWindGrid(intHour);  // 내부에서 _simHour !== null 이므로 env 갱신 안함
    }

    // 2. 조명·안개·Sky 직접 갱신 (분수 시간, 부드러운 보간)
    //    map.loaded() 체크 없이 직접 호출 — 이미 로드된 상태에서 슬라이더 사용
    try {
      _applyMapEnvironment(fracHour);
    } catch (e) {
      console.warn('[TimeSim] 환경 갱신 실패:', e.message);
    }
  }

  /** 자동 모드로 복원 */
  function resetToAuto() {
    _simHour = null;
    const now = new Date();
    sliderEl.value = String(now.getHours() * 60 + now.getMinutes());
    labelEl.textContent = '⏱ 자동 (현재 시간)';
    resetBtn.style.opacity = '0.35';
    resetBtn.style.pointerEvents = 'none';
    _applyCurrentHourWindGrid();
  }

  // 초기 슬라이더 위치 = 현재 시각
  const now = new Date();
  sliderEl.value = String(now.getHours() * 60 + now.getMinutes());

  sliderEl.addEventListener('input', () => applySlider(+sliderEl.value));
  resetBtn.addEventListener('click', resetToAuto);
})();

let _statusTimer = null;
function setStatus(msg, autoClearMs = 0) {
  const el = document.getElementById('status-label');
  if (!el) return;
  clearTimeout(_statusTimer);
  el.textContent   = msg ?? '';
  el.style.opacity = msg ? '1' : '0';
  if (msg && autoClearMs > 0) {
    _statusTimer = setTimeout(() => { el.style.opacity = '0'; }, autoClearMs);
  }
}
