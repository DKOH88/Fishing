// ==================== Tide API Proxy (Cloudflare Worker) ====================
// 공공데이터포털 + KHOA 좌표 기반 API를 캐싱하여 프록시하는 Cloudflare Worker
// API 키를 서버에 숨기고, 동일 요청을 Cache API로 캐싱

const UPSTREAM_BASE = 'https://apis.data.go.kr/1192136';

// ==================== KHOA 좌표 기반 API ====================
const KHOA_BASE = 'https://www.khoa.go.kr/api/oceangrid';

const ENDPOINT_MAP = {
  'tide-hilo':  'tideFcstHghLw/GetTideFcstHghLwApiService',
  'tide-level': 'surveyTideLevel/GetSurveyTideLevelApiService',
  'current':    'crntFcstTime/GetCrntFcstTimeApiService',
  'tide-time':  'tideFcstTime/GetTideFcstTimeApiService',
  'current-fld-ebb': 'crntFcstFldEbb/GetCrntFcstFldEbbApiService',
};

const DEFAULT_PARAMS = {
  'tide-hilo':  { numOfRows: '20',  pageNo: '1', type: 'json' },
  'tide-level': { numOfRows: '300', pageNo: '1', type: 'json', min: '10' },
  'current':    { numOfRows: '300', pageNo: '1', type: 'json' },
  'tide-time':  { numOfRows: '300', pageNo: '1', type: 'json', min: '10' },
  'current-fld-ebb': { numOfRows: '20', pageNo: '1', type: 'json' },
};


// ==================== 사전 캐싱 대상 포인트 (Cron Trigger) ====================
const PRECACHE_PORTS = [
  { name: '오천항',   obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.4393', lon: '126.5196' },
  { name: '안흥항',   obsCode: 'DT_0067', currentCode: '07TA05',  lat: '36.6791', lon: '126.1531' },
  { name: '영흥도',   obsCode: 'DT_0043', currentCode: '20LTC04', lat: '37.25', lon: '126.47' },
  { name: '삼길포항', obsCode: 'DT_0017', currentCode: '07DS02',  lat: '37.0035', lon: '126.4528' },
  { name: '대천항',   obsCode: 'DT_0025', currentCode: '07KS01',  lat: '36.3276', lon: '126.5123' },
  { name: '마검포항', obsCode: 'DT_0025', currentCode: '23GA01',  lat: '36.6224', lon: '126.2852' },
  { name: '무창포항', obsCode: 'DT_0025', currentCode: '07KS01',  lat: '36.2489', lon: '126.5370' },
  { name: '영목항',   obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.3997', lon: '126.4276' },
  { name: '인천',     obsCode: 'DT_0001', currentCode: '17LTC01', lat: '37.4543', lon: '126.5985' },
  { name: '평택',     obsCode: 'DT_0002', currentCode: '13PT01',  lat: '36.9613', lon: '126.8411' },
  { name: '구매항',   obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.4249', lon: '126.4331' },
  { name: '남당항',   obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.5369', lon: '126.4689' },
  { name: '대야도',   obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.4673', lon: '126.4160' },
  { name: '백사장항', obsCode: 'DT_0067', currentCode: '23GA01',  lat: '36.5864', lon: '126.3181' },
  { name: '여수',     obsCode: 'DT_0016', currentCode: '18LTC06', lat: '34.7386', lon: '127.7329' },
  { name: '녹동항',   obsCode: 'DT_0026', currentCode: '06YS09',  lat: '34.5231', lon: '127.1436' },
  { name: '전곡항',   obsCode: 'DT_0008', currentCode: '19LTC01', lat: '37.1876', lon: '126.6504' },
  { name: '홍원항',   obsCode: 'DT_0051', currentCode: '12JB11',  lat: '36.1563', lon: '126.5017' },
  { name: '군산',     obsCode: 'DT_0018', currentCode: '12JB14',  lat: '35.97', lon: '126.62' },
];

// ==================== Badatime Weekly Incremental Validation (Worker Cron) ====================
const BADATIME_BASE = 'https://www.badatime.com';
const BADATIME_WEEKLY_DAYS = 14;
const BADATIME_WEEKLY_CRON_A = '0 0 * * 1';   // Monday 09:00 KST
const BADATIME_WEEKLY_CRON_B = '10 0 * * 1';  // Monday 09:10 KST
const BADATIME_WEEKLY_REPORT_TTL = 60 * 60 * 24 * 45; // 45 days

// User-selected major ports. Some ports share the same badatime station id.
const BADATIME_WEEKLY_PORTS = [
  { port: 'ochunhang', sid: '355' },
  { port: 'anhung_sinjinhang', sid: '132' },
  { port: 'yeongheungdo', sid: '151' },
  { port: 'samgilpohang', sid: '144' },
  { port: 'daecheonhang', sid: '126' },
  { port: 'makgeompohang', sid: '1400' }, // mapped to 마검포방파제
  { port: 'muchangpohang', sid: '236' },
  { port: 'yeongmokhang', sid: '354' },
  { port: 'incheon', sid: '158' },
  { port: 'gumaehang', sid: '1385' },
  { port: 'namdanghang', sid: '356' },
  { port: 'daeyado', sid: '462' },
  { port: 'baeksajanghang', sid: '175' },
  { port: 'yeosu', sid: '41' },
  { port: 'nokdonghang', sid: '219' },
  { port: 'pyeongtaekhang', sid: '149' },
  { port: 'jeongokhang', sid: '618' },
  { port: 'hongwonhang', sid: '523' },
];

const ALLOWED_ORIGINS = new Set([
  'https://fishing-info.pages.dev',
]);

// localhost/127.0.0.1 with any port (dev only)
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

function isOriginAllowed(origin) {
  return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN_RE.test(origin);
}

function getCorsHeaders(request) {
  const origin = (request && request.headers && request.headers.get('Origin')) || '';
  if (!isOriginAllowed(origin)) {
    return { 'Vary': 'Origin' };
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ==================== 위경도 → 기상청 격자 변환 ====================
function latLonToGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0;
  const OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD, olat = OLAT * DEGRAD;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

// ==================== Helpers ====================

function jsonResponse(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
  });
}

function addCorsHeaders(response, request) {
  const newHeaders = new Headers(response.headers);
  Object.entries(getCorsHeaders(request)).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function handleOptions(request) {
  return new Response(null, { status: 204, headers: getCorsHeaders(request) });
}

function validateParams(obsCode, reqDate) {
  if (!obsCode || !/^[A-Za-z0-9_-]{2,20}$/.test(obsCode)) {
    return 'Invalid obsCode';
  }
  if (!reqDate || !/^\d{8}$/.test(reqDate)) {
    return 'Invalid reqDate (expected YYYYMMDD)';
  }
  return null;
}

/** KST(UTC+9) Date 객체 반환 — Date 산술(end-of-day 등)이 필요할 때만 사용 */
function getKoreaNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

/** Intl 기반 KST 날짜/시간 파츠 반환 (date 미지정 시 현재 시각) */
function _kstParts(date) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date || new Date()).forEach(({ type, value }) => { p[type] = value; });
  return p;
}

/** KST 오늘 날짜 'YYYYMMDD' (캐시 키, 비교용) */
function getTodayStr() {
  const p = _kstParts();
  return `${p.year}${p.month}${p.day}`;
}

/** KST 현재 시각을 ISO 8601 형식(+09:00 오프셋)으로 반환 */
function kstNowISO() {
  const p = _kstParts();
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+09:00`;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRecentKstDateList(daysBack = BADATIME_WEEKLY_DAYS, includeToday = false) {
  const p = _kstParts();
  const baseKstMidnight = new Date(`${p.year}-${p.month}-${p.day}T00:00:00+09:00`);
  const startOffset = includeToday ? 0 : 1;
  const dates = [];

  for (let i = 0; i < daysBack; i++) {
    const d = new Date(baseKstMidnight.getTime() - (i + startOffset) * 24 * 60 * 60 * 1000);
    const dp = _kstParts(d);
    dates.push(`${dp.year}-${dp.month}-${dp.day}`);
  }

  return dates.sort();
}

function parseBadatimeDailyRows(html, ym) {
  const rowMatches = [...html.matchAll(/<tr[^>]*class="day-row"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = new Map();

  for (const rowMatch of rowMatches) {
    const rowHtml = rowMatch[1];
    const dayCellHtml = (rowHtml.match(/class="day-cell"[\s\S]*?>([\s\S]*?)<\/td>/i) || [])[1] || '';
    const day = parseInt((dayCellHtml.match(/(\d{1,2})\s*\(/) || [])[1], 10);
    if (!Number.isFinite(day)) continue;

    const flow = parseInt((rowHtml.match(/class="progress-bar"[^>]*data-value="(\d{1,3})"/i) || [])[1], 10);
    if (!Number.isFinite(flow)) continue;

    const date = `${ym}-${String(day).padStart(2, '0')}`;
    if (!out.has(date)) out.set(date, flow);
  }

  return out;
}

async function fetchBadatimeHtml(url, retries = 4) {
  let lastErr = null;

  for (let i = 1; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,*/*',
        },
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      return await resp.text();
    } catch (e) {
      lastErr = e;
      await waitMs(500 * i);
    }
  }

  throw lastErr || new Error('badatime fetch failed');
}

function countByField(list, key) {
  const out = {};
  for (const item of list) {
    const k = String(item?.[key] || '');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

async function runBadatimeWeeklyIncrementalValidation(env, cronStr, partition = 0) {
  if (!env.VISITOR_STORE) {
    console.error('[badatime:weekly] VISITOR_STORE not configured');
    return;
  }

  const partitionPorts = BADATIME_WEEKLY_PORTS.filter((_, idx) => idx % 2 === partition);
  const targetDates = buildRecentKstDateList(BADATIME_WEEKLY_DAYS, false);
  const targetMonths = [...new Set(targetDates.map((d) => d.slice(0, 7)))].sort();

  const sidToPorts = new Map();
  for (const entry of partitionPorts) {
    if (!sidToPorts.has(entry.sid)) sidToPorts.set(entry.sid, []);
    sidToPorts.get(entry.sid).push(entry.port);
  }

  const mismatches = [];
  const failedJobs = [];
  const skippedNoKv = [];
  let checkedRows = 0;
  let matchedRows = 0;
  let liveRowsParsed = 0;

  const sidList = [...sidToPorts.keys()].sort((a, b) => Number(a) - Number(b));
  console.log(
    `[badatime:weekly] start cron=${cronStr}, partition=${partition}, ports=${partitionPorts.length}, stations=${sidList.length}, dates=${targetDates[0]}..${targetDates[targetDates.length - 1]}`
  );

  for (const sid of sidList) {
    const ports = sidToPorts.get(sid);
    const kvKey = `bt:${sid}`;
    const urlBase = `${BADATIME_BASE}/${sid}/daily`;

    let stationData = null;
    try {
      const raw = await env.VISITOR_STORE.get(kvKey);
      if (!raw) {
        skippedNoKv.push({
          station_id: sid,
          ports,
          reason: 'station not found in KV',
        });
        continue;
      }
      stationData = JSON.parse(raw);
    } catch (e) {
      failedJobs.push({
        station_id: sid,
        ports,
        ym: '*',
        url: `${urlBase}/YYYY-MM`,
        error: `KV read error: ${e?.message || String(e)}`,
      });
      continue;
    }

    const liveByDate = new Map();
    const failedMonths = new Set();
    for (const ym of targetMonths) {
      const pageUrl = `${urlBase}/${ym}`;
      try {
        const html = await fetchBadatimeHtml(pageUrl, 4);
        const parsed = parseBadatimeDailyRows(html, ym);
        liveRowsParsed += parsed.size;
        for (const [date, pct] of parsed.entries()) {
          liveByDate.set(date, pct);
        }
      } catch (e) {
        failedMonths.add(ym);
        failedJobs.push({
          station_id: sid,
          ports,
          ym,
          url: pageUrl,
          error: e?.message || String(e),
        });
      }
      await waitMs(120);
    }

    for (const date of targetDates) {
      if (failedMonths.has(date.slice(0, 7))) continue;

      const storedRaw = stationData?.[date];
      const storedPct = Number(storedRaw);
      checkedRows++;

      if (!Number.isFinite(storedPct)) {
        mismatches.push({
          type: 'missing_in_kv',
          station_id: sid,
          ports,
          date,
          ym: date.slice(0, 7),
          stored_flow_pct: '',
          live_flow_pct: liveByDate.has(date) ? liveByDate.get(date) : '',
        });
        continue;
      }

      const livePct = liveByDate.get(date);
      if (!Number.isFinite(livePct)) {
        mismatches.push({
          type: 'missing_on_live',
          station_id: sid,
          ports,
          date,
          ym: date.slice(0, 7),
          stored_flow_pct: Math.round(storedPct),
          live_flow_pct: '',
        });
        continue;
      }

      if (Math.round(storedPct) !== livePct) {
        mismatches.push({
          type: 'flow_changed',
          station_id: sid,
          ports,
          date,
          ym: date.slice(0, 7),
          stored_flow_pct: Math.round(storedPct),
          live_flow_pct: livePct,
        });
        continue;
      }

      matchedRows++;
    }
  }

  const summary = {
    status: mismatches.length === 0 && failedJobs.length === 0 ? 'PASS' : 'FAIL',
    generated_at: new Date().toISOString(),
    mode: 'weekly_incremental_major_ports',
    cron: cronStr,
    partition,
    ports_in_partition: partitionPorts,
    checked_station_count: sidList.length,
    checked_expected_rows: checkedRows,
    matched_rows: matchedRows,
    live_rows_parsed: liveRowsParsed,
    mismatches_count: mismatches.length,
    failed_jobs_count: failedJobs.length,
    skipped_no_kv_count: skippedNoKv.length,
    mismatch_by_type: countByField(mismatches, 'type'),
    window: {
      from: targetDates[0],
      to: targetDates[targetDates.length - 1],
      days: targetDates.length,
    },
  };

  const report = { summary, mismatches, failed_jobs: failedJobs, skipped_no_kv: skippedNoKv };
  const keyLabel = partition === 0 ? 'a' : 'b';
  const reportKey = `badatime_validation:weekly:${keyLabel}:latest`;
  const reportHistoryKey = `badatime_validation:weekly:${keyLabel}:${summary.generated_at.slice(0, 10)}`;

  try {
    await env.VISITOR_STORE.put(reportKey, JSON.stringify(report), { expirationTtl: BADATIME_WEEKLY_REPORT_TTL });
    await env.VISITOR_STORE.put(reportHistoryKey, JSON.stringify(report), { expirationTtl: BADATIME_WEEKLY_REPORT_TTL });
  } catch (e) {
    console.error('[badatime:weekly] failed to write report KV:', e?.message || String(e));
  }

  console.log(
    `[badatime:weekly] done status=${summary.status}, mismatches=${summary.mismatches_count}, failed=${summary.failed_jobs_count}, checkedRows=${checkedRows}, matched=${matchedRows}`
  );
}

async function hashIP(ip) {
  const data = new TextEncoder().encode(ip);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function computeCacheTTL(endpoint, reqDate) {
  const todayStr = getTodayStr();

  if (reqDate < todayStr) {
    // 과거: 데이터 불변 → 7일
    return 7 * 24 * 60 * 60;
  }

  if (reqDate === todayStr) {
    if (endpoint === 'tide-level' || endpoint === 'tide-time') {
      // 오늘 실측 조위: 10분마다 갱신
      return 10 * 60;
    }
    // 오늘 예보(고저조/조류): 하루 끝까지
    const kst = getKoreaNow();
    const endOfDay = new Date(kst);
    endOfDay.setUTCHours(23, 59, 59, 999);
    const remaining = Math.floor((endOfDay - kst) / 1000);
    return Math.max(remaining, 60);
  }

  // 미래: 예보 갱신 가능 → 6시간
  return 6 * 60 * 60;
}

const PASSTHROUGH_QUERY_KEYS = new Set([
  'numOfRows', 'pageNo', 'min', 'hour', 'minute', 'placeName', 'gubun', 'include', 'exclude', 'lat', 'lon'
]);

function extractPassthroughParams(url) {
  const params = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === 'obsCode' || k === 'reqDate') continue;
    if (!PASSTHROUGH_QUERY_KEYS.has(k)) continue;
    if (v == null || v === '') continue;
    params[k] = v;
  }
  return params;
}

function makeParamSignature(params) {
  const keys = Object.keys(params || {}).sort();
  if (keys.length === 0) return 'default';
  return keys.map((k) => `${k}=${encodeURIComponent(String(params[k]))}`).join('&');
}

function buildCacheKey(endpoint, obsCode, reqDate, extraSig = 'default') {
  return new Request(`https://tide-cache.internal/${endpoint}/${obsCode}/${reqDate}/${extraSig}`);
}

function buildUpstreamUrl(endpoint, obsCode, reqDate, apiKey, passthroughParams = {}) {
  const path = ENDPOINT_MAP[endpoint];
  const url = new URL(`${UPSTREAM_BASE}/${path}`);

  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('obsCode', obsCode);
  url.searchParams.set('reqDate', reqDate);

  const defaults = DEFAULT_PARAMS[endpoint];
  Object.entries(defaults).forEach(([k, v]) => url.searchParams.set(k, v));

  Object.entries(passthroughParams || {}).forEach(([k, v]) => {
    url.searchParams.set(k, v);
  });

  return url.toString();
}

function extractApiLevelResultCode(data) {
  return data?.header?.resultCode || data?.response?.header?.resultCode || null;
}

function extractApiLevelResultMsg(data) {
  return data?.header?.resultMsg || data?.response?.header?.resultMsg || null;
}

function buildFishingIndexUrl(apiKey) {
  const url = new URL(`${UPSTREAM_BASE}/fcstFishingv2/GetFcstFishingApiServicev2`);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('type', 'json');
  url.searchParams.set('gubun', '선상');
  url.searchParams.set('numOfRows', '300');
  url.searchParams.set('pageNo', '1');
  return url.toString();
}

// ==================== KHOA Helpers ====================

const COORD_RE = /^-?\d+(\.\d+)?$/;

function validateKhoaCurrentPointParams(latRaw, lonRaw, date) {
  if (!latRaw || !COORD_RE.test(latRaw)) return 'Invalid lat (expected numeric)';
  if (!lonRaw || !COORD_RE.test(lonRaw)) return 'Invalid lon (expected numeric)';
  const lat = parseFloat(latRaw);
  const lon = parseFloat(lonRaw);
  if (lat < 32 || lat > 39) return 'Invalid lat (expected 32~39)';
  if (lon < 124 || lon > 132) return 'Invalid lon (expected 124~132)';
  if (!date || !/^\d{8}$/.test(date)) return 'Invalid date (expected YYYYMMDD)';
  return null;
}

function validateKhoaCurrentAreaParams(date, hour, minute, minX, maxX, minY, maxY, scale) {
  if (!date || !/^\d{8}$/.test(date)) {
    return 'Invalid date (expected YYYYMMDD)';
  }
  if (!hour || !/^\d{1,2}$/.test(hour)) return 'Invalid hour';
  if (!minute || !/^\d{1,2}$/.test(minute)) return 'Invalid minute';
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (h < 0 || h > 23) return 'Invalid hour (0~23)';
  if (m < 0 || m > 59) return 'Invalid minute (0~59)';
  const coordRegex = /^-?\d+(\.\d+)?$/;
  for (const [name, val] of [['minX', minX], ['maxX', maxX], ['minY', minY], ['maxY', maxY]]) {
    if (!val || !coordRegex.test(val)) return `Invalid ${name}`;
  }
  // 한국 해역 범위 제한 (경도 120~135, 위도 30~42)
  const fMinX = parseFloat(minX), fMaxX = parseFloat(maxX);
  const fMinY = parseFloat(minY), fMaxY = parseFloat(maxY);
  if (fMinX < 120 || fMaxX > 135) return 'Invalid X range (expected 120~135)';
  if (fMinY < 30 || fMaxY > 42) return 'Invalid Y range (expected 30~42)';
  if (fMinX >= fMaxX || fMinY >= fMaxY) return 'Invalid range (min must be < max)';
  if ((fMaxX - fMinX) > 10 || (fMaxY - fMinY) > 10) return 'Area too large (max 10 degree span)';
  if (scale != null && scale !== '' && !/^\d+$/.test(String(scale))) return 'Invalid scale';
  return null;
}

function buildKhoaCacheKey(endpoint, paramsStr) {
  return new Request(`https://tide-cache.internal/khoa/${endpoint}/${paramsStr}`);
}

function buildKhoaCurrentPointUrl(lat, lon, date, serviceKey) {
  const url = new URL(`${KHOA_BASE}/tidalCurrentPoint/search.do`);
  url.searchParams.set('ServiceKey', serviceKey);
  url.searchParams.set('Sdate', date);
  url.searchParams.set('SHour', '00');
  url.searchParams.set('SMinute', '00');
  url.searchParams.set('Edate', date);
  url.searchParams.set('EHour', '23');
  url.searchParams.set('EMinute', '59');
  url.searchParams.set('lon', lon);
  url.searchParams.set('lat', lat);
  url.searchParams.set('ResultType', 'json');
  return url.toString();
}

function buildKhoaCurrentAreaUrl(date, hour, minute, minX, maxX, minY, maxY, scale, serviceKey) {
  const url = new URL(`${KHOA_BASE}/tidalCurrentArea/search.do`);
  url.searchParams.set('ServiceKey', serviceKey);
  url.searchParams.set('Date', date);
  url.searchParams.set('Hour', hour);
  url.searchParams.set('Minute', minute);
  url.searchParams.set('MinX', minX);
  url.searchParams.set('MaxX', maxX);
  url.searchParams.set('MinY', minY);
  url.searchParams.set('MaxY', maxY);
  if (scale != null && String(scale) !== '') {
    url.searchParams.set('Scale', String(scale));
  }
  url.searchParams.set('ResultType', 'json');
  return url.toString();
}

// ==================== KHOA 공통 fetch-cache-respond 헬퍼 ====================

const KHOA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchAndCacheKhoa({ cacheLabel, cacheParamsStr, upstreamUrl, date, request, ctx }) {
  const cacheKey = buildKhoaCacheKey(cacheLabel, cacheParamsStr);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const resp = addCorsHeaders(cached, request);
    resp.headers.set('X-Cache', 'HIT');
    return resp;
  }

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, { headers: { 'User-Agent': KHOA_UA } });
  } catch (e) {
    return jsonResponse({ error: 'KHOA fetch failed', detail: e.message }, 502, request);
  }

  if (!upstreamResp.ok) {
    return jsonResponse({ error: `KHOA returned HTTP ${upstreamResp.status}` }, 502, request);
  }

  let data;
  try {
    data = await upstreamResp.json();
  } catch (e) {
    return jsonResponse({ error: 'Failed to parse KHOA response' }, 502, request);
  }

  if (!data.result || !data.result.data) {
    return jsonResponse({ error: 'KHOA API returned no data' }, 400, request);
  }

  const ttl = computeCacheTTL(cacheLabel, date);
  const response = new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Cache': 'MISS',
      'X-Cache-TTL': `${ttl}s`,
      ...getCorsHeaders(request),
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ==================== KHOA Request Handler ====================

async function handleKhoaRequest(khoaEndpoint, url, env, ctx, request) {
  const khoaKey = env.KHOA_SERVICE_KEY;
  if (!khoaKey) {
    return jsonResponse({ error: 'Server configuration error: KHOA API key not set' }, 500, request);
  }

  if (khoaEndpoint === 'current-point') {
    const lat = url.searchParams.get('lat');
    const lon = url.searchParams.get('lon');
    const date = url.searchParams.get('date');
    const err = validateKhoaCurrentPointParams(lat, lon, date);
    if (err) return jsonResponse({ error: err }, 400, request);

    return fetchAndCacheKhoa({
      cacheLabel: 'khoa-current-point',
      cacheParamsStr: `${lat}_${lon}_${date}`,
      upstreamUrl: buildKhoaCurrentPointUrl(lat, lon, date, khoaKey),
      date, request, ctx,
    });

  } else if (khoaEndpoint === 'current-area') {
    const date = url.searchParams.get('date');
    const hour = url.searchParams.get('hour');
    const minute = url.searchParams.get('minute');
    const minX = url.searchParams.get('minX');
    const maxX = url.searchParams.get('maxX');
    const minY = url.searchParams.get('minY');
    const maxY = url.searchParams.get('maxY');
    const scale = url.searchParams.get('scale') || '4000000';
    const err = validateKhoaCurrentAreaParams(date, hour, minute, minX, maxX, minY, maxY, scale);
    if (err) return jsonResponse({ error: err }, 400, request);

    return fetchAndCacheKhoa({
      cacheLabel: 'khoa-current-area',
      cacheParamsStr: `${date}_${hour}_${minute}_${minX}_${maxX}_${minY}_${maxY}_${scale}`,
      upstreamUrl: buildKhoaCurrentAreaUrl(date, hour, minute, minX, maxX, minY, maxY, scale, khoaKey),
      date, request, ctx,
    });
  }

  return jsonResponse({ error: 'Unknown KHOA endpoint' }, 404, request);
}

// ==================== 방문자 카운터 ====================

async function handleVisitorRequest(request, env, ipHash) {
  const KV = env.VISITOR_STORE;
  if (!KV) {
    return jsonResponse({ error: 'Visitor store not configured' }, 500, request);
  }

  const todayStr = getTodayStr();
  const dailyIpKey = `ip:${todayStr}:${ipHash}`;
  const totalIpKey = `ip_total:${ipHash}`;
  const dailyCountKey = `today:${todayStr}`;
  const totalCountKey = 'total';

  // NOTE: KV는 원자적 증가를 지원하지 않아 동시 요청 시 카운트 유실 가능.
  // 정확한 집계가 필요하면 Durable Objects 또는 D1으로 전환 권장.
  const [existsToday, existsTotal] = await Promise.all([
    KV.get(dailyIpKey),
    KV.get(totalIpKey),
  ]);

  const DAY_TTL = 48 * 60 * 60;
  const needDailyInc = !existsToday;
  const needTotalInc = !existsTotal;

  // IP 마킹을 먼저 수행하여 중복 요청 창을 최소화
  const markPromises = [];
  if (needDailyInc) markPromises.push(KV.put(dailyIpKey, '1', { expirationTtl: DAY_TTL }));
  if (needTotalInc) markPromises.push(KV.put(totalIpKey, '1'));
  if (markPromises.length > 0) await Promise.all(markPromises);

  // 카운트 읽기 → 증가 → 쓰기 (간격 최소화)
  let [dailyCount, totalCount] = await Promise.all([
    KV.get(dailyCountKey),
    KV.get(totalCountKey),
  ]);
  dailyCount = parseInt(dailyCount || '0', 10);
  totalCount = parseInt(totalCount || '0', 10);

  if (needDailyInc) {
    dailyCount += 1;
    await KV.put(dailyCountKey, String(dailyCount), { expirationTtl: DAY_TTL });
  }

  if (needTotalInc) {
    totalCount += 1;
    await KV.put(totalCountKey, String(totalCount));
  }

  return jsonResponse({ today: dailyCount, total: totalCount }, 200, request);
}

// ==================== 음양력 변환 (KASI 공공데이터포털) ====================

const LUNAR_API_BASE = 'https://apis.data.go.kr/B090041/openapi/service/LrsrCldInfoService/getLunCalInfo';

async function handleLunarRequest(url, env, ctx, request) {
  const solYear = url.searchParams.get('solYear');
  const solMonth = url.searchParams.get('solMonth');
  const solDay = url.searchParams.get('solDay');

  // 입력 검증
  if (!solYear || !/^\d{4}$/.test(solYear)) return jsonResponse({ error: 'Invalid solYear' }, 400, request);
  if (!solMonth || !/^\d{2}$/.test(solMonth)) return jsonResponse({ error: 'Invalid solMonth' }, 400, request);
  if (!solDay || !/^\d{2}$/.test(solDay)) return jsonResponse({ error: 'Invalid solDay' }, 400, request);

  // 캐시 확인 (음력 데이터는 불변 → 30일 캐시)
  const cacheKey = new Request(`https://tide-cache.internal/lunar/${solYear}${solMonth}${solDay}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const resp = addCorsHeaders(cached, request);
    resp.headers.set('X-Cache', 'HIT');
    return resp;
  }

  const apiKey = env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'Server configuration error: API key not set' }, 500, request);
  }

  const upstreamUrl = new URL(LUNAR_API_BASE);
  upstreamUrl.searchParams.set('serviceKey', apiKey);
  upstreamUrl.searchParams.set('solYear', solYear);
  upstreamUrl.searchParams.set('solMonth', solMonth);
  upstreamUrl.searchParams.set('solDay', solDay);
  upstreamUrl.searchParams.set('_type', 'json');

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl.toString());
  } catch (e) {
    return jsonResponse({ error: 'Lunar API fetch failed', detail: e.message }, 502, request);
  }

  if (!upstreamResp.ok) {
    return jsonResponse({ error: `Lunar API returned HTTP ${upstreamResp.status}` }, 502, request);
  }

  let data;
  try {
    data = await upstreamResp.json();
  } catch (e) {
    return jsonResponse({ error: 'Failed to parse lunar API response' }, 502, request);
  }

  // 응답에서 음력 데이터 추출
  const item = data?.response?.body?.items?.item;
  if (!item) {
    return jsonResponse({ error: 'No lunar data found' }, 400, request);
  }

  // 간결한 응답으로 가공
  const result = {
    solYear: item.solYear,
    solMonth: item.solMonth,
    solDay: item.solDay,
    lunYear: item.lunYear,
    lunMonth: item.lunMonth,
    lunDay: item.lunDay,
    lunLeapmonth: item.lunLeapmonth, // 평(평달)/윤(윤달)
    solWeek: item.solWeek,
  };

  const ttl = 30 * 24 * 60 * 60; // 30일 (음력 데이터 불변)
  const response = new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Cache': 'MISS',
      'X-Cache-TTL': `${ttl}s`,
      ...getCorsHeaders(request),
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ==================== Rate Limiting (Dual-Window) ====================
// 10초 마이크로 윈도우 + 60초 분 윈도우로 burst 공격 완화
// NOTE: KV는 원자적 증가를 지원하지 않아 동시 요청 시 카운트 누락 가능.
// 10초 버킷으로 blast radius를 최소화한다.

const RATE_LIMIT_MICRO_WINDOW = 10;   // 10초 마이크로 윈도우
const RATE_LIMIT_MICRO_MAX = 25;      // 10초당 최대 25건
const RATE_LIMIT_MINUTE_WINDOW = 60;  // 60초 분 윈도우
const RATE_LIMIT_MINUTE_MAX = 120;    // 분당 최대 120건

async function checkRateLimit(ipHash, env, isVisitor = false) {
  const KV = env.VISITOR_STORE;
  if (!KV) return null;

  const now = Math.floor(Date.now() / 1000);

  // visitor 엔드포인트는 더 엄격한 제한 적용
  const microMax = isVisitor ? 3 : RATE_LIMIT_MICRO_MAX;
  const minuteMax = isVisitor ? 10 : RATE_LIMIT_MINUTE_MAX;

  // 고정 버킷 키 (동시 쓰기 충돌 최소화)
  const microBucket = Math.floor(now / RATE_LIMIT_MICRO_WINDOW);
  const minuteBucket = Math.floor(now / RATE_LIMIT_MINUTE_WINDOW);
  const microKey = `rl_m:${ipHash}:${microBucket}`;
  const minuteKey = `rl_M:${ipHash}:${minuteBucket}`;

  // 두 윈도우 동시 조회
  const [microStored, minuteStored] = await Promise.all([
    KV.get(microKey),
    KV.get(minuteKey),
  ]);

  const microCount = parseInt(microStored || '0', 10);
  const minuteCount = parseInt(minuteStored || '0', 10);

  // 제한 초과 확인 (증가 전 비관적 검사)
  if (microCount >= microMax) {
    return RATE_LIMIT_MICRO_WINDOW - (now % RATE_LIMIT_MICRO_WINDOW);
  }
  if (minuteCount >= minuteMax) {
    return RATE_LIMIT_MINUTE_WINDOW - (now % RATE_LIMIT_MINUTE_WINDOW);
  }

  // 두 카운터 동시 증가
  await Promise.all([
    KV.put(microKey, String(microCount + 1), { expirationTtl: 60 }),
    KV.put(minuteKey, String(minuteCount + 1), { expirationTtl: RATE_LIMIT_MINUTE_WINDOW * 2 }),
  ]);

  return null;
}

// ==================== Pre-cache Functions (Cron Trigger) ====================

/**
 * 중복 제거된 사전 캐싱 태스크 목록 생성
 * 같은 obsCode/currentCode/좌표는 한 번만 호출
 */
function buildPrecacheTasks(ports, dates) {
  const seen = new Set();
  const tasks = [];

  for (const port of ports) {
    for (const date of dates) {
      // tide-hilo (obsCode 기준)
      const hiloKey = `tide-hilo|${port.obsCode}|${date}`;
      if (!seen.has(hiloKey)) {
        seen.add(hiloKey);
        tasks.push({
          endpoint: 'tide-hilo',
          obsCode: port.obsCode,
          reqDate: date,
          passthrough: { numOfRows: '20', pageNo: '1' },
        });
      }

      // tide-time (obsCode 기준)
      const timeKey = `tide-time|${port.obsCode}|${date}`;
      if (!seen.has(timeKey)) {
        seen.add(timeKey);
        tasks.push({
          endpoint: 'tide-time',
          obsCode: port.obsCode,
          reqDate: date,
          passthrough: { min: '10', numOfRows: '300', pageNo: '1' },
        });
      }

      // current (currentCode 기준, 1페이지는 min 없이 호출)
      if (port.currentCode) {
        const curKey = `current|${port.currentCode}|${date}`;
        if (!seen.has(curKey)) {
          seen.add(curKey);
          tasks.push({
            endpoint: 'current',
            obsCode: port.currentCode,
            reqDate: date,
            passthrough: { numOfRows: '300', pageNo: '1' },
          });
        }

        // current-fld-ebb (currentCode 기준)
        const fldKey = `current-fld-ebb|${port.currentCode}|${date}`;
        if (!seen.has(fldKey)) {
          seen.add(fldKey);
          tasks.push({
            endpoint: 'current-fld-ebb',
            obsCode: port.currentCode,
            reqDate: date,
            passthrough: { numOfRows: '20', pageNo: '1' },
          });
        }
      }
    }
  }

  return tasks;
}

/**
 * 단일 태스크 사전 캐싱: upstream 호출 → Cache API 저장
 */
async function precacheOneTask(task, apiKey, cache) {
  // 캐시 키 생성 (fetch 핸들러와 동일한 방식)
  const cacheId = task.obsCode;

  const paramSig = makeParamSignature(task.passthrough);
  const cacheKey = buildCacheKey(task.endpoint, cacheId, task.reqDate, paramSig);

  // 이미 캐시에 있으면 skip
  const existing = await cache.match(cacheKey);
  if (existing) return 'hit';

  // upstream API 호출
  const upstreamUrl = buildUpstreamUrl(
    task.endpoint,
    task.obsCode,
    task.reqDate,
    apiKey,
    task.passthrough
  );

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl);
  } catch (e) {
    return 'fetch_error';
  }

  if (!upstreamResp.ok) return 'http_error';

  let data;
  try {
    data = await upstreamResp.json();
  } catch (e) {
    return 'parse_error';
  }

  // API 레벨 에러면 캐싱하지 않음
  const resultCode = extractApiLevelResultCode(data);
  if (resultCode && resultCode !== '00') return 'api_error';

  // 성공 → 캐시 저장
  const ttl = computeCacheTTL(task.endpoint, task.reqDate);
  const response = new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Cache': 'PRECACHE',
      'X-Cache-TTL': `${ttl}s`,
    },
  });

  await cache.put(cacheKey, response);
  return 'cached';
}

/**
 * 배치 실행: concurrency개씩 동시 요청, 배치 간 delayMs 대기
 */
async function runPrecacheBatches(tasks, apiKey, cache, concurrency = 10, delayMs = 200) {
  const results = { cached: 0, hit: 0, error: 0, total: tasks.length };

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(t => precacheOneTask(t, apiKey, cache))
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        if (r.value === 'cached') results.cached++;
        else if (r.value === 'hit') results.hit++;
        else results.error++;
      } else {
        results.error++;
      }
    }

    // 배치 간 딜레이 (마지막 배치 제외)
    if (i + concurrency < tasks.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

// ==================== 날씨 API (기상청 단기예보) ====================

// ==================== AWS 관측소 좌표 테이블 (전체 739개, 기상청 API허브 stn_inf.php 기준) ====================
const AWS_STATIONS = [
  // [stn, lat, lon]  —  전국 자동기상관측장비
  [90,38.251,128.565],[92,38.059,128.663],[93,37.947,127.754],[95,38.148,127.304],[96,37.24,131.87],[98,37.902,127.061],[99,37.886,126.766],[100,37.677,128.718],[101,37.903,127.736],[102,37.974,124.712],
  [104,37.805,128.855],[105,37.751,128.891],[106,37.507,129.124],[108,37.571,126.966],[110,37.559,126.795],[112,37.478,126.625],[113,37.462,126.441],[114,37.337,127.947],[115,37.481,130.899],[116,37.445,126.964],
  [119,37.257,126.983],[121,37.181,128.457],[127,36.97,127.952],[128,36.717,127.5],[129,36.777,126.494],[130,36.992,129.413],[131,36.639,127.441],[133,36.372,127.372],[135,36.22,127.995],[136,36.573,128.707],
  [137,36.408,128.157],[138,36.032,129.38],[139,35.983,129.417],[140,36.005,126.761],[142,35.891,128.661],[143,35.878,128.653],[146,35.841,127.117],[151,35.593,129.352],[152,35.582,129.335],[153,35.169,128.934],
  [155,35.17,128.573],[156,35.173,126.892],[158,35.125,126.812],[159,35.105,129.032],[160,35.119,129],[161,35.083,128.067],[162,34.845,128.436],[163,34.991,126.383],[165,34.817,126.382],[167,34.847,127.612],
  [168,34.739,127.741],[169,34.687,125.451],[170,34.396,126.702],[172,35.348,126.599],[174,35.02,127.369],[175,34.472,126.324],[177,36.658,126.688],[181,36.64,127.385],[182,33.517,126.5],[184,33.514,126.53],
  [185,33.294,126.163],[188,33.387,126.88],[189,33.246,126.565],[192,35.164,128.04],[201,37.707,126.446],[202,37.489,127.494],[203,37.264,127.484],[211,38.06,128.168],[212,37.684,127.88],[216,37.17,128.989],
  [217,37.381,128.673],[221,37.159,128.194],[226,36.488,127.734],[229,36.625,125.56],[230,37.264,126.103],[232,36.762,127.293],[235,36.327,126.557],[236,36.272,126.921],[238,36.106,127.482],[239,36.485,127.244],
  [243,35.73,126.717],[244,35.612,127.286],[245,35.563,126.839],[247,35.421,127.397],[248,35.657,127.52],[251,35.427,126.697],[252,35.284,126.478],[253,35.23,128.891],[254,35.371,127.129],[255,35.227,128.673],
  [257,35.307,129.02],[258,34.763,127.212],[259,34.645,126.784],[260,34.689,126.92],[261,34.554,126.569],[262,34.618,127.276],[263,35.323,128.288],[264,35.511,127.745],[266,34.943,127.691],[268,34.473,126.258],
  [269,35.347,126.03],[271,36.944,128.914],[272,36.872,128.517],[273,36.627,128.149],[276,36.435,129.04],[277,36.533,129.409],[278,36.356,128.689],[279,36.131,128.321],[281,35.977,128.951],[283,35.817,129.201],
  [284,35.667,127.91],[285,35.565,128.17],[288,35.491,128.744],[289,35.413,127.879],[294,34.888,128.605],[295,34.817,127.926],[296,35.218,128.96],[300,35.858,126.315],[301,35.095,126.116],[302,34.643,126.183],
  [303,34.073,125.097],[304,34.318,126.848],[305,33.986,126.92],[306,34.432,127.801],[308,34.687,126.073],[309,37.946,126.687],[310,37.325,129.265],[311,35.789,128.087],[312,36.393,129.141],[313,34.882,128.741],
  [314,35.866,127.743],[315,35.307,127.511],[316,35.114,126.997],[317,35.73,127.114],[318,37.653,128.682],[319,37.538,130.872],[320,38.331,128.314],[321,38.115,128.196],[322,38.201,127.663],[323,38.273,127.526],
  [324,36.91,128.074],[325,37.144,128.025],[326,37.546,127.611],[327,36.626,127.513],[328,33.25,126.398],[329,33.447,126.565],[330,33.501,126.649],[331,33.296,126.421],[332,37.443,129.122],[333,37.581,129.083],
  [334,38.207,128.592],[335,37.36,128.126],[336,37.561,128.11],[337,37.46,128.063],[338,37.506,128.211],[339,37.489,127.882],[340,37.528,127.98],[341,35.828,127.053],[343,38.022,127.11],[344,36.788,127.847],
  [345,37.375,127.946],[346,37.712,128.897],[347,37.228,127.857],[348,38.026,128.717],[349,37.6,127.843],[350,37.995,128.496],[351,37.898,126.977],[352,37.716,126.944],[355,37.114,127.036],[356,37.048,127.018],
  [358,36.967,126.921],[359,37.854,127.159],[360,37.786,127.228],[361,38.005,127.245],[364,37.383,127.119],[365,37.409,126.895],[366,37.394,127.008],[367,37.406,126.785],[368,37.599,127.15],[369,37.364,126.917],
  [370,37.116,127.222],[371,37.28,127.115],[372,37.872,127.027],[373,37.771,127.046],[374,37.047,126.971],[375,37.792,126.988],[376,37.447,126.859],[377,37.395,126.892],[378,36.304,127.363],[379,35.54,127.546],
  [400,37.498,127.082],[401,37.485,127.026],[402,37.556,127.145],[403,37.474,127.125],[404,37.574,126.83],[405,37.528,126.879],[406,37.666,127.03],[407,37.622,127.092],[408,37.585,127.06],[409,37.586,127.087],
  [410,37.493,126.917],[411,37.552,126.929],[412,37.57,126.941],[413,37.533,127.086],[414,37.611,127],[415,37.52,126.976],[416,37.646,126.943],[417,37.466,126.9],[418,37.525,126.939],[419,37.552,126.987],
  [421,37.547,127.039],[423,37.493,126.826],[424,37.638,127.01],[425,37.463,126.982],[426,37.966,124.63],[427,37.669,126.647],[428,37.551,127.213],[429,37.501,126.764],[430,37.275,127.01],[431,37.749,127.072],
  [432,37.131,126.921],[433,37.501,126.764],[434,37.394,126.957],[435,37.327,126.834],[436,37.234,127.188],[437,37.479,126.865],[438,37.361,126.935],[439,37.209,127.036],[440,37.278,127.441],[441,37.608,126.762],
  [442,37.433,127.286],[443,37.033,127.306],[444,37.538,127.214],[445,37.345,126.969],[446,37.14,127.064],[447,37.33,127.677],[448,37.402,127.464],[449,37.51,127.448],[450,37.598,126.849],[451,37.699,127.205],
  [452,37.934,127.226],[453,37.442,126.896],[454,37.974,127.067],[455,37.846,127.501],[456,38.096,127.076],[457,37.522,127.194],[458,37.475,127.306],[459,37.345,127.197],[460,37.369,127.405],[461,37.249,127.358],
  [462,37.172,127.48],[463,37.332,127.548],[464,37.204,127.661],[465,37.204,127.549],[466,37.39,127.534],[467,37.094,127.216],[468,36.943,127.259],[469,37.141,127.434],[470,37.081,127.27],[471,37.066,127.065],
  [472,36.984,126.855],[473,37.849,127.186],[474,38.089,127.276],[475,38.158,127.251],[476,37.901,127.288],[477,37.906,127.044],[478,38.059,127.013],[479,37.982,126.884],[480,38.047,126.993],[481,37.802,126.716],
  [482,37.776,126.851],[483,37.925,126.789],[484,37.647,127.316],[485,37.676,127.495],[486,37.735,127.414],[487,37.645,126.552],[488,37.218,126.73],[489,37.167,126.709],[491,38.082,127.021],[492,37.416,126.851],
  [493,36.736,127.008],[494,36.531,127.24],[495,36.981,127.163],[496,36.459,127.269],[497,37.575,128.851],[498,37.879,128.514],[500,37.666,126.47],[501,37.659,125.698],[502,37.789,126.292],[503,37.908,126.712],
  [504,37.87,127.181],[505,37.824,127.345],[506,37.748,126.777],[507,38.025,127.144],[508,37.466,126.361],[509,37.453,126.95],[510,37.527,126.907],[511,37.568,126.635],[512,37.397,126.662],[513,37.066,126.014],
  [514,37.238,126.579],[515,37.085,126.774],[516,37.004,127.25],[517,38.385,128.475],[518,38.27,128.121],[519,38.075,127.519],[520,38.167,128.518],[522,37.787,127.984],[523,37.898,128.821],[524,37.786,128.894],
  [525,37.621,128.359],[526,37.377,128.395],[527,37.211,128.641],[529,37.142,129.286],[530,37.515,130.812],[531,37.898,127.552],[532,37.735,127.073],[533,37.328,127.481],[534,37.121,127.611],[535,37.717,128.183],
  [536,37.488,127.972],[537,37.483,128.846],[538,38.173,127.103],[539,38.024,127.368],[540,37.637,126.892],[541,37.634,127.151],[542,37.684,127.38],[543,37.499,126.55],[544,37.186,126.654],[545,37.281,126.838],
  [546,37.435,127.259],[547,37.416,127.755],[548,37.269,127.64],[549,37.27,127.222],[550,37.169,127.053],[551,36.988,127.109],[552,38.232,127.389],[553,38.457,128.418],[554,38.214,128.437],[555,38.084,127.691],
  [556,38.098,127.985],[557,37.954,128.314],[558,37.686,127.701],[559,37.778,128.397],[560,37.648,128.564],[561,37.582,128.153],[563,37.464,128.683],[565,37.392,126.778],[566,37.852,128.819],[567,37.953,126.932],
  [568,37.959,127.313],[569,37.582,127.157],[570,37.623,126.642],[571,37.195,126.821],[572,37.421,127.125],[573,37.558,127.714],[574,37.369,127.587],[575,37.106,127.188],[576,37.13,127.366],[577,37.533,126.337],
  [578,36.301,126.266],[579,37.367,128.913],[580,37.613,129.029],[581,37.117,128.774],[582,37.231,128.08],[583,37.465,128.155],[585,37.96,128.074],[586,38.032,127.877],[587,38.226,127.953],[588,37.791,127.643],
  [589,37.702,126.79],[590,37.44,127.002],[591,37.416,128.05],[592,37.232,127.749],[593,38.007,128.541],[594,38.253,128.21],[595,38.264,128.374],[596,38.077,128.493],[597,37.545,128.441],[598,37.831,126.99],
  [599,37.762,127.17],[600,36.974,127.59],[601,37.002,128.347],[602,36.863,127.462],[603,36.816,127.778],[604,36.3,127.597],[605,36.16,127.755],[606,37.011,126.388],[607,36.673,126.135],[609,36.338,126.356],
  [610,36.52,126.442],[611,36.567,127.281],[612,36.483,127.136],[614,36.062,126.704],[615,36.212,127.108],[616,36.889,126.617],[617,36.891,127.146],[618,36.424,126.779],[619,36.923,127.702],[620,37.074,127.904],
  [621,36.973,128.214],[622,36.839,128.008],[623,36.796,127.562],[624,36.624,127.657],[625,36.516,127.816],[626,36.353,127.822],[627,36.754,126.33],[628,36.739,126.82],[629,36.691,127.2],[630,37.046,127.8],
  [631,37.348,126.615],[632,36.541,126.947],[633,36.551,127.094],[634,36.846,126.865],[635,36.132,126.86],[636,36.313,127.241],[637,36.879,126.824],[638,37.078,128.494],[639,36.904,128.146],[640,36.671,127.865],
  [641,36.546,127.524],[642,36.291,127.396],[643,36.34,127.494],[644,36.137,127.09],[645,36.579,126.511],[646,36.174,126.528],[647,36.125,127.685],[648,36.413,127.438],[649,37.472,126.751],[650,38.251,127.271],
  [651,38.277,127.206],[652,37.99,127.073],[654,37.254,126.308],[655,37.76,124.729],[656,37.687,126.193],[657,36.324,126.502],[658,36.768,126.121],[659,36.343,127.206],[660,37.562,128.378],[661,38.543,128.402],
  [662,37.171,126.297],[663,36.929,125.787],[664,37.225,126.458],[665,37.39,126.425],[666,36.959,126.168],[667,36.648,126.009],[669,36.229,126.076],[670,38.089,128.63],[671,38.192,128.576],[672,35.442,126.488],
  [673,35.282,128.718],[674,37.22,128.821],[675,37.79,127.528],[676,36.991,127.43],[677,37.517,129.021],[678,37.725,128.779],[679,37.61,128.773],[680,38.213,127.845],[681,38.051,127.791],[682,38.283,127.863],
  [687,35.126,127.253],[688,35.269,126.939],[689,35.101,126.899],[690,35.336,127.139],[691,36.386,126.957],[692,38.04,126.924],[694,36.704,126.609],[695,38.116,127.432],[696,37.347,129.086],[697,34.251,125.918],
  [698,35.094,126.285],[699,34.984,126.461],[700,36.125,125.968],[701,36.002,127.668],[702,35.938,126.993],[703,35.76,127.437],[704,35.621,126.478],[706,35.31,126.973],[707,35.058,126.208],[708,35.129,126.745],
  [709,35.208,127.494],[710,35.025,126.744],[711,34.897,126.99],[712,34.904,127.519],[713,34.975,127.583],[714,34.879,126.029],[716,34.631,126.032],[717,34.427,126.31],[718,34.333,126.036],[719,35.809,126.398],
  [720,34.162,126.555],[721,34.339,127.028],[722,35.137,126.929],[723,34.028,127.309],[724,33.958,126.302],[725,33.523,126.954],[726,33.122,126.268],[727,33.41,126.393],[730,35.279,126.761],[731,34.817,126.686],
  [732,34.762,127.092],[733,36.046,126.892],[734,35.986,127.246],[735,35.894,127.773],[736,35.847,126.784],[737,35.809,126.878],[738,35.579,126.674],[739,35.523,126.547],[741,35.057,126.985],[742,34.939,126.331],
  [743,34.773,125.947],[744,34.673,126.436],[745,34.685,126.726],[746,34.382,126.516],[747,34.183,126.858],[748,34.837,127.363],[749,34.535,127.127],[750,34.628,127.636],[751,33.479,126.694],[752,33.305,126.306],
  [753,33.393,126.496],[754,35.06,126.527],[755,35.16,127.085],[756,35.602,126.282],[757,35.974,127.436],[758,35.835,127.571],[759,35.372,127.578],[760,35.427,126.933],[761,35.651,126.935],[762,35.552,127.187],
  [763,36.059,127.062],[764,35.674,127.141],[765,34.892,127.134],[766,34.849,127.715],[767,34.589,127.397],[768,35.289,127.285],[769,35.199,126.383],[770,34.929,126.82],[771,34.727,126.145],[772,34.532,126.24],
  [773,34.708,126.636],[774,34.817,126.466],[775,35.178,126.639],[776,34.46,126.557],[777,34.556,126.935],[778,34.796,126.822],[779,33.393,126.258],[780,33.277,126.704],[781,33.52,126.878],[782,33.385,126.619],
  [783,35.23,126.841],[784,34.877,126.613],[785,34.464,126.676],[786,34.638,127.774],[787,34.507,127.317],[788,35.132,126.881],[789,34.876,126.293],[790,34.533,127.467],[791,35.266,127.584],[792,33.363,126.818],
  [793,33.241,126.226],[794,35.101,127.427],[795,35.275,127.139],[796,34.238,127.245],[797,34.395,125.3],[798,34.686,125.192],[799,35.202,126.135],[800,36.726,129.444],[801,36.625,129.088],[802,36.757,129.34],
  [803,36.395,128.811],[804,36.191,129.339],[805,36.179,129.094],[806,36.233,128.29],[807,36.18,128.693],[808,36.076,129.567],[809,35.935,127.979],[810,35.926,128.298],[811,35.863,129.209],[812,35.696,128.282],
  [813,35.654,128.732],[814,36.979,128.661],[815,36.66,128.465],[816,35.983,129.548],[817,36.783,129.221],[818,36.708,128.148],[819,36.659,128.886],[820,36.548,128.527],[821,36.282,128.074],[822,36.12,128.155],
  [823,36.249,128.556],[824,36.096,128.5],[825,36.04,128.381],[826,36.047,128.79],[827,35.824,128.743],[828,35.69,128.424],[829,35.712,129.318],[830,36.069,129.2],[831,37.04,128.997],[832,36.391,128.429],
  [833,36.538,128.042],[834,36.441,127.944],[835,36.893,128.716],[836,36.279,128.896],[837,36.827,128.643],[838,36.791,128.27],[839,36.458,128.895],[840,35.913,128.814],[841,36.085,128.911],[842,35.758,129.011],
  [843,36.936,129.25],[844,36.436,129.359],[845,35.908,128.591],[846,35.865,128.531],[847,36.276,128.466],[848,35.679,128.895],[849,36.547,128.387],[850,35.785,129.491],[851,37.051,129.352],[852,37.061,129.426],
  [853,36.018,128.621],[854,35.495,129.134],[855,33.173,126.268],[856,35.102,127.598],[857,34.3,126.717],[858,34.43,126.17],[859,35.755,129.369],[860,35.885,128.619],[861,33.556,126.773],[862,33.471,126.779],
  [863,33.477,126.432],[864,35.821,127.155],[865,33.458,126.522],[867,33.377,126.53],[868,33.376,126.498],[869,33.348,126.496],[870,33.37,126.556],[871,33.362,126.518],[872,35.319,127.756],[874,38.142,127.22],
  [875,38.121,128.461],[876,37.45,129.162],[877,37.313,127.805],[878,37.224,129.096],[881,35.729,126.529],[882,35.253,126.605],[883,33.362,126.36],[885,33.331,126.678],[886,35.95,126.591],[888,36.463,127.491],
  [889,37.5,126.977],[890,33.385,126.734],[892,33.45,126.851],[893,33.466,126.327],[896,37.361,126.935],[897,37.345,126.969],[898,35.505,129.386],[899,35.224,128.582],[900,35.62,129.144],[901,35.487,129.435],
  [902,35.242,127.819],[903,35.404,128.515],[904,35.169,128.975],[905,35.441,129.043],[906,35.232,127.643],[907,34.932,128.063],[908,35.112,128.754],[909,34.788,128.738],[910,35.066,129.074],[911,34.649,128.577],
  [912,35.526,127.778],[913,34.724,127.982],[914,35.638,127.716],[915,35.414,128.102],[916,35.311,127.967],[917,35.037,128.068],[918,34.991,128.331],[919,35.551,128.477],[920,35.296,128.399],[921,34.993,128.831],
  [922,35.486,128.929],[923,35.275,129.251],[924,35.359,129.36],[925,35.374,128.823],[926,35.126,128.475],[927,35.582,128.884],[929,35.114,128.307],[930,34.81,128.238],[931,34.622,128.274],[932,35.061,127.767],
  [933,34.997,127.832],[934,35.221,127.928],[935,35.57,128.341],[936,35.333,128.202],[937,35.177,129.161],[938,35.159,129.019],[939,35.293,129.103],[940,35.209,129.09],[941,35.213,129.003],[942,35.119,129.088],
  [943,35.667,129.375],[944,35.385,128.57],[945,35.535,127.99],[946,35.78,127.818],[947,34.722,128.591],[948,35.311,127.834],[949,35.638,129.441],[950,35.09,128.984],[951,35.509,126.907],[953,34.998,128.68],
  [954,35.431,129.36],[955,37.325,126.393],[956,36.77,125.977],[957,35.987,126.225],[958,35.613,126.245],[959,34.263,126.027],[960,33.223,126.654],[961,34.285,127.858],[963,35.567,129.475],[964,34.459,126.816],
  [965,33.352,126.533],[966,37.116,126.386],[967,37.119,126.613],[970,38.202,127.25],[972,36.55,128.683],[973,35.023,126.95],[974,35.244,128.156],[977,36.725,127.467],[978,37.955,127.776],[980,33.26,126.489],
  [984,35.091,129.127],[989,33.258,126.33],[990,33.318,126.23],[991,35.803,128.446],[992,35.906,128.446],[993,33.342,126.31],[994,35.854,126.642],[995,35.929,129.382],[996,36.372,127.895],
];

/** lat/lon으로 가장 가까운 AWS 관측소 번호 반환 */
function findNearestAws(lat, lon) {
  let best = null, bestDist = Infinity;
  for (const [stn, sLat, sLon] of AWS_STATIONS) {
    const d = (lat - sLat) ** 2 + (lon - sLon) ** 2;
    if (d < bestDist) { bestDist = d; best = stn; }
  }
  return best;
}

// ==================== 수온 (Water Temperature) ====================
async function fetchWaterTempForDate(apiKey, obsCode, dateStr) {
  const apiUrl = new URL('https://apis.data.go.kr/1192136/surveyWaterTemp/GetSurveyWaterTempApiService');
  apiUrl.searchParams.set('serviceKey', apiKey);
  apiUrl.searchParams.set('type', 'json');
  apiUrl.searchParams.set('obsCode', obsCode);
  apiUrl.searchParams.set('reqDate', dateStr);
  apiUrl.searchParams.set('min', '60');
  apiUrl.searchParams.set('numOfRows', '300');
  const resp = await fetch(apiUrl.toString());
  if (!resp.ok) return null;
  const data = await resp.json();
  const code = data?.header?.resultCode;
  if (code === '03' || !data?.body?.items?.item) return null;
  const items = data.body.items.item;
  return items[items.length - 1]; // 가장 최근 관측값
}

async function handleWaterTemp(env, request, url, ctx) {
  const obsCode = url.searchParams.get('obsCode');
  if (!obsCode || !/^[A-Za-z0-9_-]{2,20}$/.test(obsCode)) {
    return jsonResponse({ error: 'Invalid obsCode' }, 400, request);
  }

  const kst = new Date(Date.now() + 9 * 3600000);
  const today = kst.toISOString().slice(0, 10).replace(/-/g, '');

  // 캐시 키: 1시간 단위
  const hh = String(kst.getHours()).padStart(2, '0');
  const cacheKey = new Request(`https://tide-cache.internal/water-temp-v2/${obsCode}/${today}/${hh}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return addCorsHeaders(cached, request);

  const apiKey = env.DATA_GO_KR_API_KEY;
  if (!apiKey) return jsonResponse({ error: 'Missing API key' }, 500, request);

  try {
    // 오늘 데이터 시도 → 없으면 어제로 fallback
    let latest = await fetchWaterTempForDate(apiKey, obsCode, today);
    if (!latest) {
      const yesterday = new Date(kst.getTime() - 86400000);
      const yStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
      latest = await fetchWaterTempForDate(apiKey, obsCode, yStr);
    }

    if (!latest) {
      const nodata = jsonResponse({ wtem: null, obsCode, message: 'NODATA' }, 200, request);
      const nr = new Response(nodata.body, nodata);
      nr.headers.set('Cache-Control', 'public, max-age=1800');
      ctx.waitUntil(cache.put(cacheKey, nr.clone()));
      return addCorsHeaders(nr, request);
    }

    const result = {
      wtem: latest.wtem,
      obsCode,
      obsvtrNm: latest.obsvtrNm,
      obsrvnDt: latest.obsrvnDt,
      fetchedAt: kst.toISOString().replace('Z', '+09:00'),
    };

    const response = jsonResponse(result, 200, request);
    const cr = new Response(response.body, response);
    cr.headers.set('Cache-Control', 'public, max-age=3600');
    ctx.waitUntil(cache.put(cacheKey, cr.clone()));
    return addCorsHeaders(cr, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// ==================== 풍향/풍속 (Wind) ====================
async function fetchWindForDate(apiKey, obsCode, dateStr) {
  const apiUrl = new URL('https://apis.data.go.kr/1192136/surveyWind/GetSurveyWindApiService');
  apiUrl.searchParams.set('serviceKey', apiKey);
  apiUrl.searchParams.set('type', 'json');
  apiUrl.searchParams.set('obsCode', obsCode);
  apiUrl.searchParams.set('reqDate', dateStr);
  apiUrl.searchParams.set('min', '60');
  apiUrl.searchParams.set('numOfRows', '300');
  const resp = await fetch(apiUrl.toString());
  if (!resp.ok) return null;
  const data = await resp.json();
  const code = data?.header?.resultCode;
  if (code === '03' || !data?.body?.items?.item) return null;
  const items = data.body.items.item;
  return items[items.length - 1]; // 가장 최근 관측값
}

async function handleWind(env, request, url, ctx) {
  const obsCode = url.searchParams.get('obsCode');
  if (!obsCode || !/^[A-Za-z0-9_-]{2,20}$/.test(obsCode)) {
    return jsonResponse({ error: 'Invalid obsCode' }, 400, request);
  }

  const kst = new Date(Date.now() + 9 * 3600000);
  const today = kst.toISOString().slice(0, 10).replace(/-/g, '');

  const hh = String(kst.getHours()).padStart(2, '0');
  const cacheKey = new Request(`https://tide-cache.internal/wind-v1/${obsCode}/${today}/${hh}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return addCorsHeaders(cached, request);

  const apiKey = env.DATA_GO_KR_API_KEY;
  if (!apiKey) return jsonResponse({ error: 'Missing API key' }, 500, request);

  try {
    let latest = await fetchWindForDate(apiKey, obsCode, today);
    if (!latest) {
      const yesterday = new Date(kst.getTime() - 86400000);
      const yStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
      latest = await fetchWindForDate(apiKey, obsCode, yStr);
    }

    if (!latest) {
      const nodata = jsonResponse({ wspd: null, wndrct: null, obsCode, message: 'NODATA' }, 200, request);
      const nr = new Response(nodata.body, nodata);
      nr.headers.set('Cache-Control', 'public, max-age=1800');
      ctx.waitUntil(cache.put(cacheKey, nr.clone()));
      return addCorsHeaders(nr, request);
    }

    const result = {
      wspd: latest.wspd,
      wndrct: latest.wndrct,
      obsCode,
      obsvtrNm: latest.obsvtrNm,
      obsrvnDt: latest.obsrvnDt,
      fetchedAt: kst.toISOString().replace('Z', '+09:00'),
    };

    const response = jsonResponse(result, 200, request);
    const cr = new Response(response.body, response);
    cr.headers.set('Cache-Control', 'public, max-age=3600');
    ctx.waitUntil(cache.put(cacheKey, cr.clone()));
    return addCorsHeaders(cr, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// ==================== 자외선 지수 (UV Index) ====================
// KMA 자외선 관측 네트워크 좌표 (관측소 수 매우 적음 — stn=0 전체 조회 후 가장 가까운 선택)
const UV_STATIONS = {
  13: [37.75, 128.89],    // 강릉 인근
  108: [37.57, 126.97],   // 서울
  131: [36.64, 127.44],   // 청주
  132: [37.68, 128.72],   // 대관령
  133: [35.89, 128.72],   // 대구
  138: [36.03, 129.38],   // 포항
  143: [36.37, 127.37],   // 대전
  146: [35.82, 127.15],   // 전주
  152: [35.56, 129.32],   // 울산
  156: [35.17, 126.89],   // 광주
  159: [35.10, 129.03],   // 부산
  184: [33.51, 126.53],   // 제주
  185: [33.29, 126.16],   // 고산(제주)
  192: [35.16, 128.57],   // 진주
  201: [37.34, 127.95],   // 강원 인근
};

/** UV 관측소 중 가장 가까운 관측소 번호 반환 */
function findNearestUVStation(lat, lon, availableStns) {
  let best = null, bestDist = Infinity;
  for (const stn of availableStns) {
    const coords = UV_STATIONS[stn];
    if (!coords) continue;
    const d = (lat - coords[0]) ** 2 + (lon - coords[1]) ** 2;
    if (d < bestDist) { bestDist = d; best = stn; }
  }
  return best;
}

async function handleUVIndex(env, request, url, ctx) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if (isNaN(lat) || isNaN(lon)) {
    return jsonResponse({ error: 'lat, lon required' }, 400, request);
  }

  const kst = new Date(Date.now() + 9 * 3600000);
  const hh = kst.getHours();

  // 야간(18:00~06:00 KST) → API 호출 건너뛰기
  if (hh < 6 || hh >= 18) {
    const nightResp = jsonResponse({ uvIndex: null, message: 'NIGHTTIME' }, 200, request);
    return addCorsHeaders(nightResp, request);
  }

  const today = kst.toISOString().slice(0, 10).replace(/-/g, '');
  const hhStr = String(hh).padStart(2, '0');
  const cacheKey = new Request(`https://tide-cache.internal/uv-index-v1/${lat.toFixed(2)}-${lon.toFixed(2)}/${today}/${hhStr}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return addCorsHeaders(cached, request);

  const apihubKey = env.KMA_APIHUB_KEY;
  if (!apihubKey) return jsonResponse({ error: 'Missing KMA_APIHUB_KEY' }, 500, request);

  // 디버그 모드: 원본 텍스트 반환 (파서 검증용)
  const debug = url.searchParams.get('debug');
  if (debug) {
    try {
      const tm = `${today}${hhStr}00`;
      const uvUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_sfctm_uv.php?tm=${tm}&stn=0&help=${debug === '1' ? '1' : '0'}&authKey=${apihubKey}`;
      const resp = await fetch(uvUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideInfoBot/1.0)' },
      });
      const text = await resp.text();
      return new Response(JSON.stringify({ url: uvUrl.replace(apihubKey, '***'), raw: text }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (e) {
      return jsonResponse({ error: 'debug fetch failed: ' + e.message }, 500, request);
    }
  }

  try {
    // 현재 시각부터 2시간 전까지 재시도 (관측 지연 대비)
    for (let back = 0; back <= 2; back++) {
      const targetHour = hh - back;
      if (targetHour < 6) break; // 야간 진입 방지
      const tm = `${today}${String(targetHour).padStart(2, '0')}00`;

      // stn=0: 전체 UV 관측소 데이터 조회
      const uvUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_sfctm_uv.php?tm=${tm}&stn=0&help=0&authKey=${apihubKey}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(uvUrl, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideInfoBot/1.0)' },
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const text = await resp.text();

      // 텍스트 파싱: '#' 주석 제외, 데이터 라인 추출
      // 컬럼: TM(0), STN(1), UVB(2), UVA(3), EUV(4), UV-B(5), UV-A(6), TEMP1(7), TEMP2(8)
      const lines = text.trim().split('\n').filter(l => !l.startsWith('#') && l.trim().length > 0);
      if (lines.length === 0) continue;

      // 각 관측소 데이터 파싱
      const stations = [];
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 6) continue;
        const stnId = parseInt(cols[1]);
        const euv = parseFloat(cols[4]);   // UV 지수 (-999 = null)
        const uvb = parseFloat(cols[5]);   // UV-B 복사량
        if (isNaN(stnId)) continue;

        // EUV가 유효하면 사용, 아니면 UV-B를 대용 지표로 사용
        const uvValue = (euv > 0 && euv < 900) ? euv : (uvb >= 0 ? uvb : null);
        if (uvValue === null) continue;

        stations.push({ stn: stnId, uvIndex: uvValue, obsTime: cols[0], isEUV: euv > 0 && euv < 900 });
      }
      if (stations.length === 0) continue;

      // 가장 가까운 UV 관측소 선택
      const availableStns = stations.map(s => s.stn);
      const nearestStn = findNearestUVStation(lat, lon, availableStns);
      // 매칭 실패 시 첫 번째 관측소 사용
      const picked = nearestStn
        ? stations.find(s => s.stn === nearestStn)
        : stations[0];

      const result = {
        uvIndex: Math.round(picked.uvIndex * 10) / 10,
        stn: picked.stn,
        obsTime: picked.obsTime,
        source: picked.isEUV ? 'EUV' : 'UV-B',
        fetchedAt: kst.toISOString().replace('Z', '+09:00'),
      };

      const response = jsonResponse(result, 200, request);
      const cr = new Response(response.body, response);
      cr.headers.set('Cache-Control', 'public, max-age=3600');
      ctx.waitUntil(cache.put(cacheKey, cr.clone()));
      return addCorsHeaders(cr, request);
    }

    // 데이터 없음
    const nodata = jsonResponse({ uvIndex: null, message: 'NODATA' }, 200, request);
    const nr = new Response(nodata.body, nodata);
    nr.headers.set('Cache-Control', 'public, max-age=1800');
    ctx.waitUntil(cache.put(cacheKey, nr.clone()));
    return addCorsHeaders(nr, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleWeather(env, request, url, ctx) {
  const nx = url.searchParams.get('nx');
  const ny = url.searchParams.get('ny');
  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');
  if (!nx || !ny || !/^\d{1,4}$/.test(nx) || !/^\d{1,4}$/.test(ny)) {
    return jsonResponse({ error: 'nx, ny must be 1-4 digit numbers' }, 400, request);
  }

  // 캐시 확인 (5분 단위 — AWS 매분 데이터를 반영하기 위해 짧게)
  const cache = caches.default;
  const _nowForKey = new Date(Date.now() + 9 * 3600 * 1000);
  const _dateKey = _nowForKey.toISOString().slice(0, 10).replace(/-/g, '');
  const _hhKey = _nowForKey.getUTCHours();
  const _mmKey = Math.floor(_nowForKey.getUTCMinutes() / 5); // 5분 단위
  const cacheKey = new Request(`https://cache.internal/weather-v7-${nx}-${ny}-${_dateKey}-${_hhKey}-${_mmKey}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
    });
  }

  const apiKey = env.KMA_API_KEY || env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'KMA_API_KEY not set' }, 500, request);
  }
  const apihubKey = env.KMA_APIHUB_KEY; // 기상청 API허브 인증키

  // KST 현재 시각
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hh = now.getUTCHours();
  const mm = now.getUTCMinutes();

  // 초단기예보 base_time (SKY용): HH30 형식
  let fcstBaseDate = yyyymmdd;
  let fcstBaseHour = hh;
  if (mm < 45) {
    fcstBaseHour = hh - 1;
    if (fcstBaseHour < 0) {
      fcstBaseHour = 23;
      const yesterday = new Date(now.getTime() - 86400000);
      fcstBaseDate = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
    }
  }
  const fcstBaseTime = String(fcstBaseHour).padStart(2, '0') + '30';

  try {
    // ── 3-way 병렬: AWS기온 / 초단기실황 / 초단기예보(SKY) 동시 시작 ──
    let tmp = null, pty = null, wsd = null, vec = null, fcstTime = null, awsStn = null;

    // 초단기실황 base 시간 계산 (실황/AWS 양쪽에서 공유)
    let ncstBaseDate = yyyymmdd;
    let ncstBaseHour = hh;
    if (mm < 15) {
      ncstBaseHour = hh - 1;
      if (ncstBaseHour < 0) { ncstBaseHour = 23; const y = new Date(now.getTime() - 86400000); ncstBaseDate = y.toISOString().slice(0, 10).replace(/-/g, ''); }
    }
    const ncstBaseTime = String(ncstBaseHour).padStart(2, '0') + '00';

    // A) AWS 실관측 기온 — 2초 타임아웃, 실패해도 OK (실황이 커버)
    let awsResult = null;
    const awsPromise = (async () => {
      if (!(apihubKey && lat && lon)) return;
      const fLat = parseFloat(lat), fLon = parseFloat(lon);
      if (isNaN(fLat) || isNaN(fLon)) return;
      awsStn = findNearestAws(fLat, fLon);
      if (!awsStn) return;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        const awsNow = new Date(Date.now() + 9 * 3600 * 1000);
        const tm2 = awsNow.toISOString().slice(0, 16).replace(/[-T:]/g, '').slice(0, 12);
        const awsUrl = `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min`
          + `?tm2=${tm2}&stn=${awsStn}&disp=1&help=2&authKey=${apihubKey}`;
        const resp = await fetch(awsUrl, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideInfoBot/1.0)' },
        });
        clearTimeout(timer);
        if (!resp.ok) return;
        const text = await resp.text();
        const lines = text.trim().split('\n').filter(l => l.match(/^\d{12},/));
        if (lines.length === 0) return;
        const cols = lines[lines.length - 1].split(',');
        if (cols.length < 9) return;
        const ta = parseFloat(cols[8]);
        if (ta <= -50) return;
        const re = parseFloat(cols[9]);
        awsResult = { ta: String(ta), re: re > 0 ? '1' : '0', obsTime: cols[0], stn: parseInt(cols[1]) };
      } catch (e) { /* 타임아웃 또는 네트워크 에러 — 무시 */ }
    })();

    // B) 초단기실황 (T1H, PTY, WSD, VEC) — AWS와 동시 시작, 캐시 우선
    let ncstResult = null;
    const ncstPromise = (async () => {
      const ncstCacheKey = new Request(`https://cache.internal/ncst-v1-${nx}-${ny}-${ncstBaseDate}-${ncstBaseTime}`);
      const ncstCached = await cache.match(ncstCacheKey);
      if (ncstCached) {
        ncstResult = await ncstCached.json();
        return;
      }
      const ncstUrl = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst`
        + `?serviceKey=${apiKey}&numOfRows=10&pageNo=1&dataType=JSON`
        + `&base_date=${ncstBaseDate}&base_time=${ncstBaseTime}&nx=${nx}&ny=${ny}`;
      try {
        const ncstResp = await fetch(ncstUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideInfoBot/1.0)' } });
        if (ncstResp.ok) {
          const ncstData = await ncstResp.json();
          const items = ncstData?.response?.body?.items?.item;
          if (items && Array.isArray(items)) {
            ncstResult = items;
            const ncstCacheResp = new Response(JSON.stringify(items), {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
            });
            ctx.waitUntil(cache.put(ncstCacheKey, ncstCacheResp));
          }
        }
      } catch (e) { /* 실황 실패 */ }
    })();

    // B) 초단기예보 (SKY 하늘상태) — 독립적이므로 A와 동시 시작, 30분 캐시
    let sky = null;
    let fcstFallback = {};  // tmp/pty/wsd/vec fallback 값 임시 저장
    const skyPromise = (async () => {
      const fcstCacheKey = new Request(`https://cache.internal/fcst-v1-${nx}-${ny}-${fcstBaseDate}-${fcstBaseTime}`);
      const fcstCached = await cache.match(fcstCacheKey);
      if (fcstCached) {
        const cached = await fcstCached.json();
        sky = cached.sky;
        fcstFallback = cached.fallback || {};
      } else {
        const fcstUrl = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtFcst`
          + `?serviceKey=${apiKey}&numOfRows=60&pageNo=1&dataType=JSON`
          + `&base_date=${fcstBaseDate}&base_time=${fcstBaseTime}&nx=${nx}&ny=${ny}`;
        try {
          const fcstResp = await fetch(fcstUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideInfoBot/1.0)' } });
          if (fcstResp.ok) {
            const fcstData = await fcstResp.json();
            const fcstItems = fcstData?.response?.body?.items?.item;
            if (fcstItems && Array.isArray(fcstItems)) {
              const targetHour = String(hh).padStart(2, '0') + '00';
              for (const item of fcstItems) {
                if (item.fcstTime === targetHour) {
                  if (item.category === 'SKY') sky = item.fcstValue;
                  if (item.category === 'T1H') fcstFallback.tmp = item.fcstValue;
                  if (item.category === 'PTY') fcstFallback.pty = item.fcstValue;
                  if (item.category === 'WSD') fcstFallback.wsd = item.fcstValue;
                  if (item.category === 'VEC') fcstFallback.vec = item.fcstValue;
                }
              }
              if (sky === null) {
                const first = fcstItems.find(i => i.category === 'SKY');
                if (first) sky = first.fcstValue;
              }
              // 30분 캐시 저장
              const fcstCacheResp = new Response(JSON.stringify({ sky, fallback: fcstFallback }), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
              });
              ctx.waitUntil(cache.put(fcstCacheKey, fcstCacheResp));
            }
          }
        } catch (e) { /* 예보 실패 */ }
      }
    })();

    // 3개 모두 완료 대기
    await Promise.allSettled([awsPromise, ncstPromise, skyPromise]);

    // 결과 병합: AWS 우선 → 초단기실황 → 초단기예보 fallback
    if (awsResult) {
      tmp = awsResult.ta;
      if (awsResult.re === '1') pty = '1';
      fcstTime = awsResult.obsTime ? awsResult.obsTime.slice(8, 12) : null;
    }
    if (ncstResult && Array.isArray(ncstResult)) {
      for (const item of ncstResult) {
        if (item.category === 'T1H' && tmp === null) tmp = item.obsrValue;
        if (item.category === 'PTY' && pty === null) pty = item.obsrValue;
        if (item.category === 'WSD' && wsd === null) wsd = item.obsrValue;
        if (item.category === 'VEC' && vec === null) vec = item.obsrValue;
      }
      if (fcstTime === null) fcstTime = ncstBaseTime;
    }
    // 초단기예보 fallback (AWS/실황 모두 없는 값만)
    if (tmp === null && fcstFallback.tmp) tmp = fcstFallback.tmp;
    if (pty === null && fcstFallback.pty) pty = fcstFallback.pty;
    if (wsd === null && fcstFallback.wsd) wsd = fcstFallback.wsd;
    if (vec === null && fcstFallback.vec) vec = fcstFallback.vec;

    const result = {
      sky, pty, tmp, wsd, vec, fcstTime,
      baseDate: yyyymmdd, baseTime: String(hh).padStart(2, '0') + '00',
      nx: parseInt(nx), ny: parseInt(ny),
      awsStn: awsStn || null,
      fetchedAt: kstNowISO(),
    };

    const jsonBody = JSON.stringify(result);
    const cacheResp = new Response(jsonBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }, // 5분 캐시
    });
    ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));

    return new Response(jsonBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
    });
  } catch (err) {
    return jsonResponse({ error: `Weather fetch failed: ${err.message}` }, 500, request);
  }
}

// ==================== 방류/급수 알림 크롤링 (discharge-notice) ====================

// ==================== 바다타임 유속% 조회 ====================
// KV 키: bt:{station_id} → {"2025-01-01":78,"2025-01-02":80,...}
async function handleBadatime(url, env, request, ctx) {
  const sid = url.searchParams.get('sid');
  const date = url.searchParams.get('date');

  if (!sid || !/^\d{1,4}$/.test(sid)) {
    return jsonResponse({ error: 'Invalid sid (badatime station_id)' }, 400, request);
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: 'Invalid date (expected YYYY-MM-DD)' }, 400, request);
  }

  // Cache API로 응답 캐싱 (정적 데이터이므로 30일)
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/badatime/${sid}/${date}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const resp = addCorsHeaders(cached, request);
    resp.headers.set('X-Cache', 'HIT');
    return resp;
  }

  // KV에서 해당 station 데이터 읽기
  const kvKey = `bt:${sid}`;
  const raw = await env.VISITOR_STORE.get(kvKey);
  if (!raw) {
    return jsonResponse({ flow_pct: null, source: 'badatime', error: 'station not found' }, 200, request);
  }

  let stationData;
  try {
    stationData = JSON.parse(raw);
  } catch {
    return jsonResponse({ flow_pct: null, source: 'badatime', error: 'parse error' }, 200, request);
  }

  const flowPct = stationData[date] ?? null;

  const ttl = 30 * 24 * 60 * 60; // 30일 (정적 데이터)
  const response = new Response(JSON.stringify({ flow_pct: flowPct, source: 'badatime' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
      'X-Cache': 'MISS',
      ...getCorsHeaders(request),
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleDischargeNotice(ctx, request, env) {
  // 30분 캐시
  const cache = caches.default;
  const cacheKey = new Request('https://cache.internal/discharge-notice-v7', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    // 캐시된 응답에 현재 요청의 CORS 헤더 적용
    const body = await cached.text();
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
    });
  }

  try {
    // 최대 5페이지까지 크롤링하여 '방류' 글 수집
    const MAX_PAGES = 5;
    const rows = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const rimsUrl = 'https://rims.ekr.or.kr/awminfo/WsNoticeList.do';
      const formBody = `pageIndex=${page}`;
      const resp = await fetch(rimsUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TideInfoBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody,
      });
      if (!resp.ok) break;

      const html = await resp.text();

      // 테이블 행 파싱: <tr> 내부의 <td> 추출
      const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch;
      while ((trMatch = trRe.exec(html)) !== null) {
        const trHtml = trMatch[1];
        const tds = [];
        const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let tdMatch;
        while ((tdMatch = tdRe.exec(trHtml)) !== null) {
          tds.push(tdMatch[1].trim());
        }
        if (tds.length >= 5) {
          const titleHtml = tds[1];
          const titleTextMatch = titleHtml.match(/>([^<]+)<\/a>/);
          const seqMatch = titleHtml.match(/searchNoticeDetail\((\d+)\)/);
          const title = titleTextMatch ? titleTextMatch[1].trim() : titleHtml.replace(/<[^>]+>/g, '').trim();
          const seq = seqMatch ? seqMatch[1] : null;

          // '방류'가 제목에 포함된 글만 수집
          if (!title || !title.includes('방류')) continue;

          const no = tds[0].replace(/<[^>]+>/g, '').trim();
          if (!/^\d+$/.test(no)) continue;

          rows.push({
            no: parseInt(no, 10),
            title,
            region: tds[3].replace(/<[^>]+>/g, '').trim(),
            date: tds[4].replace(/<[^>]+>/g, '').trim(),
            seq,
            link: seq ? `https://rims.ekr.or.kr/awminfo/WsNoticeListSub.do?seq=${seq}` : null,
          });
        }
      }
    }

    // 각 방류 글의 상세 내용 크롤링 (동시 5개 제한)
    const DETAIL_CONCURRENCY = 5;
    const seqRows = rows.filter(r => r.seq);
    for (let i = 0; i < seqRows.length; i += DETAIL_CONCURRENCY) {
      const batch = seqRows.slice(i, i + DETAIL_CONCURRENCY);
      await Promise.all(batch.map(async (row) => {
        try {
          const detailResp = await fetch(
            `https://rims.ekr.or.kr/awminfo/WsNoticeListSub.do?seq=${row.seq}`,
            { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideInfoBot/1.0)', 'Accept': 'text/html' } }
          );
          if (!detailResp.ok) return;
          const detailHtml = await detailResp.text();
          // "내용" 셀 추출: <th>내용</th> 다음 <td>...</td>
          const contentMatch = detailHtml.match(/<th[^>]*>\s*내용\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
          if (contentMatch) {
            // HTML → 텍스트 변환: &nbsp; → 공백, <br> → 줄바꿈, 태그 제거
            row.content = contentMatch[1]
              .replace(/&nbsp;/g, ' ')
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<[^>]+>/g, '')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
          }
        } catch (_) { /* 상세 실패 시 content 없이 진행 */ }
      }));
    }

    // KV에서 이전에 알려진 글 번호 목록 조회 → 새 글 감지
    let newCount = 0;
    let newNos = [];
    try {
      const KV = env.VISITOR_STORE;
      const knownRaw = await KV.get('discharge-known-nos');
      const currentNos = rows.map(r => r.no);
      if (knownRaw !== null) {
        const knownSet = new Set(JSON.parse(knownRaw));
        newNos = currentNos.filter(n => !knownSet.has(n));
        newCount = newNos.length;
      }
      // KV 업데이트 (비동기, 응답 블로킹 안 함)
      ctx.waitUntil(KV.put('discharge-known-nos', JSON.stringify(currentNos)));
    } catch (_) { /* KV 실패 시 newCount=0으로 진행 */ }

    const result = { notices: rows, newCount, newNos, fetchedAt: kstNowISO() };
    const jsonBody = JSON.stringify(result);

    // 30분 캐시 저장 (방류 공지는 자주 변하지 않음)
    const cacheResp = new Response(jsonBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1800',
      },
    });
    ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));

    return new Response(jsonBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to fetch discharge notices', detail: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
    });
  }
}

// ==================== 유속 윈도우 (current-window) ====================

async function handleCurrentWindowRequest(url, env, ctx, request) {
  const obsCode = url.searchParams.get('obsCode');
  const reqDate = url.searchParams.get('reqDate');

  // 입력 검증
  if (!obsCode || !/^[A-Za-z0-9_-]{2,20}$/.test(obsCode)) {
    return jsonResponse({ error: 'Invalid obsCode' }, 400, request);
  }
  if (!reqDate || !/^\d{8}$/.test(reqDate)) {
    return jsonResponse({ error: 'Invalid reqDate (expected YYYYMMDD)' }, 400, request);
  }

  // 캐시 확인
  const cacheKey = buildCacheKey('current-window', obsCode, reqDate, 'default');
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const resp = addCorsHeaders(cached, request);
    resp.headers.set('X-Cache', 'HIT');
    return resp;
  }

  const apiKey = env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'Server configuration error: API key not set' }, 500, request);
  }

  // 1단계: 첫 페이지 fetch → totalCount + 데이터 시작일 확인
  const countUrl = buildUpstreamUrl('current-fld-ebb', obsCode, reqDate, apiKey, { numOfRows: '10', pageNo: '1' });
  let countResp;
  try {
    countResp = await fetch(countUrl);
  } catch (e) {
    return jsonResponse({ error: 'Upstream fetch failed (count)', detail: e.message }, 502, request);
  }
  let countData;
  try {
    countData = await countResp.json();
  } catch (e) {
    return jsonResponse({ error: 'Failed to parse count response' }, 502, request);
  }
  const resultCode = extractApiLevelResultCode(countData);
  if (resultCode && resultCode !== '00') {
    return jsonResponse({ error: `API error: ${extractApiLevelResultMsg(countData)}`, resultCode }, 400, request);
  }
  const totalCount = countData?.body?.totalCount;
  if (!totalCount || totalCount < 10) {
    return jsonResponse({ error: 'No fldEbb data for this station' }, 400, request);
  }

  // 첫 페이지의 시작일 추출하여 정확한 itemsPerDay 계산
  const firstItems = countData?.body?.items?.item;
  const firstItemArr = Array.isArray(firstItems) ? firstItems : (firstItems ? [firstItems] : []);
  let dataStartDate = null;
  if (firstItemArr.length > 0 && firstItemArr[0].predcDt) {
    const fd = firstItemArr[0].predcDt.substring(0, 10);
    const [fy, fm, fdd] = fd.split('-').map(Number);
    dataStartDate = new Date(fy, fm - 1, fdd);
  }

  // 2단계: pageNo 추정
  const y = parseInt(reqDate.substring(0, 4));
  const m = parseInt(reqDate.substring(4, 6)) - 1;
  const d = parseInt(reqDate.substring(6, 8));
  const targetDate = new Date(y, m, d);

  // 데이터 시작일로부터의 일수로 정확한 itemsPerDay 계산
  const startRef = dataStartDate || new Date(y, 0, 1);
  const totalDays = Math.max(1, totalCount / 7.6); // 경험적 평균 7.6건/일
  const daysSinceStart = Math.max(0, Math.floor((targetDate - startRef) / 86400000));

  // 대상일 -20일 지점의 offset 추정 (여유 확보)
  const targetDayOffset = Math.max(0, daysSinceStart - 20);
  const itemOffset = Math.floor(targetDayOffset * (totalCount / totalDays));
  let targetPage = Math.max(1, Math.floor(itemOffset / 300) + 1);

  // 3단계: 데이터 fetch (최대 2회 시도)
  let allItems = [];
  const fetchPage = async (pageNo) => {
    const pageUrl = buildUpstreamUrl('current-fld-ebb', obsCode, reqDate, apiKey, { numOfRows: '300', pageNo: String(pageNo) });
    const resp = await fetch(pageUrl);
    const data = await resp.json();
    const rc = extractApiLevelResultCode(data);
    if (rc && rc !== '00') return [];
    const items = data?.body?.items?.item;
    return Array.isArray(items) ? items : (items ? [items] : []);
  };

  try {
    allItems = await fetchPage(targetPage);
  } catch (e) {
    return jsonResponse({ error: 'Upstream fetch failed', detail: e.message }, 502, request);
  }

  // 대상일이 결과에 있는지 확인
  const targetDateStr = `${reqDate.substring(0, 4)}-${reqDate.substring(4, 6)}-${reqDate.substring(6, 8)}`;
  const hasTarget = allItems.some(it => (it.predcDt || '').startsWith(targetDateStr));

  if (!hasTarget && allItems.length > 0) {
    // 결과의 마지막 날짜와 비교하여 방향 결정
    const lastDate = allItems[allItems.length - 1]?.predcDt?.substring(0, 10) || '';
    const firstDate = allItems[0]?.predcDt?.substring(0, 10) || '';
    const adjustDir = targetDateStr > lastDate ? 1 : (targetDateStr < firstDate ? -1 : 0);
    if (adjustDir !== 0) {
      const nextPage = targetPage + adjustDir;
      if (nextPage >= 1) {
        try {
          const extraItems = await fetchPage(nextPage);
          allItems = allItems.concat(extraItems);
        } catch (e) {
          // 재시도 실패 — 기존 데이터로 진행
        }
      }
    }
  }

  if (allItems.length === 0) {
    return jsonResponse({ error: 'No data found for the requested date range' }, 400, request);
  }

  // 4단계: 일별 max crsp 추출 (05~18시, crsp > 0)
  const byDate = {};
  for (const item of allItems) {
    if (!item.predcDt) continue;
    const dateKey = item.predcDt.substring(0, 10).replace(/-/g, '');
    const time = item.predcDt.substring(11, 16);
    const crsp = parseFloat(item.crsp);
    if (isNaN(crsp) || crsp <= 0) continue;
    // 05~18시 필터
    if (time < '05:00' || time > '18:00') continue;
    if (!byDate[dateKey]) byDate[dateKey] = 0;
    if (crsp > byDate[dateKey]) byDate[dateKey] = crsp;
  }

  // 05~18시에 데이터가 없는 날은 전체시간 fallback
  for (const item of allItems) {
    if (!item.predcDt) continue;
    const dateKey = item.predcDt.substring(0, 10).replace(/-/g, '');
    if (byDate[dateKey]) continue; // 이미 05~18시 데이터 있음
    const crsp = parseFloat(item.crsp);
    if (isNaN(crsp) || crsp <= 0) continue;
    if (!byDate[dateKey]) byDate[dateKey] = 0;
    if (crsp > byDate[dateKey]) byDate[dateKey] = crsp;
  }

  // 5단계: ±15일 범위 필터
  const centerMs = targetDate.getTime();
  const windowMs = 15 * 86400000;
  const dailyMaxSpeeds = [];
  for (const [dk, maxCrsp] of Object.entries(byDate)) {
    const dy = parseInt(dk.substring(0, 4));
    const dm = parseInt(dk.substring(4, 6)) - 1;
    const dd = parseInt(dk.substring(6, 8));
    const dMs = new Date(dy, dm, dd).getTime();
    if (Math.abs(dMs - centerMs) <= windowMs) {
      dailyMaxSpeeds.push({ date: dk, maxCrsp: Math.round(maxCrsp * 10) / 10 });
    }
  }
  dailyMaxSpeeds.sort((a, b) => a.date.localeCompare(b.date));

  // 6단계: 응답 + 캐싱 (빈 결과는 캐싱하지 않음)
  const ttl = computeCacheTTL('current-fld-ebb', reqDate);
  const responseBody = { dailyMaxSpeeds, obsCode, reqDate };
  const response = new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': dailyMaxSpeeds.length > 0 ? `public, max-age=${ttl}` : 'no-store',
      'X-Cache': 'MISS',
      'X-Cache-TTL': `${ttl}s`,
      ...getCorsHeaders(request),
    },
  });

  if (dailyMaxSpeeds.length > 0) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

// ==================== Main Handler ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, request);
    }

    // IP 해시를 1회 계산하여 rate limiter + visitor 카운터에서 재사용
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const ipHash = await hashIP(ip);

    // Rate limiting (visitor는 엄격한 제한)
    const isVisitorEndpoint = url.pathname === '/api/visitor';
    {
      const retryAfter = await checkRateLimit(ipHash, env, isVisitorEndpoint);
      if (retryAfter !== null) {
        return new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
            ...getCorsHeaders(request),
          },
        });
      }
    }

    // 방문자 카운터 API: GET /api/visitor
    if (isVisitorEndpoint) {
      return handleVisitorRequest(request, env, ipHash);
    }

    // 음양력 변환 API: GET /api/lunar?solYear=2026&solMonth=09&solDay=01
    if (url.pathname === '/api/lunar') {
      return handleLunarRequest(url, env, ctx, request);
    }

    // 바다낚시지수 API (선상): GET /api/fishing-index
    if (url.pathname === '/api/fishing-index') {
      const apiKey = env.DATA_GO_KR_API_KEY;
      if (!apiKey) {
        return jsonResponse({ error: 'Server configuration error: API key not set' }, 500, request);
      }

      const cacheKey = buildKhoaCacheKey('fishing-index', `sunsang_${getTodayStr()}`);
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) {
        const resp = addCorsHeaders(cached, request);
        resp.headers.set('X-Cache', 'HIT');
        return resp;
      }

      const upstreamUrl = buildFishingIndexUrl(apiKey);
      let upstreamResp;
      try {
        upstreamResp = await fetch(upstreamUrl);
      } catch (e) {
        return jsonResponse({ error: 'Fishing index fetch failed', detail: e.message }, 502, request);
      }

      if (!upstreamResp.ok) {
        return jsonResponse({ error: `Upstream returned HTTP ${upstreamResp.status}` }, 502, request);
      }

      let data;
      try {
        data = await upstreamResp.json();
      } catch (e) {
        return jsonResponse({ error: 'Failed to parse fishing index response' }, 502, request);
      }

      const resultCode = extractApiLevelResultCode(data);
      if (resultCode && resultCode !== '00') {
        const resultMsg = extractApiLevelResultMsg(data) || 'Unknown error';
        return jsonResponse({ error: `API error: ${resultMsg}`, resultCode }, 400, request);
      }

      const items = data?.body?.items?.item;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return jsonResponse({ error: 'Fishing index returned no data' }, 400, request);
      }

      // 3시간 캐싱 (예보 데이터, 하루 몇 번 갱신)
      const ttl = 3 * 60 * 60;
      const response = new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${ttl}`,
          'X-Cache': 'MISS',
          'X-Cache-TTL': `${ttl}s`,
          ...getCorsHeaders(request),
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // 유속 윈도우 API: GET /api/current-window?obsCode=07DS02&reqDate=20251001
    // crntFcstFldEbb 데이터에서 ±15일 일별 max crsp 반환
    if (url.pathname === '/api/current-window') {
      return handleCurrentWindowRequest(url, env, ctx, request);
    }

    // 날씨 API: GET /api/weather?nx=63&ny=89
    if (url.pathname === '/api/weather') {
      return handleWeather(env, request, url, ctx);
    }

    // 수온 API: GET /api/water-temp?obsCode=DT_0025
    if (url.pathname === '/api/water-temp') {
      return handleWaterTemp(env, request, url, ctx);
    }

    // 풍향/풍속 API: GET /api/wind?obsCode=DT_0025
    if (url.pathname === '/api/wind') {
      return handleWind(env, request, url, ctx);
    }

    // 자외선 지수 API: GET /api/uv-index?lat=36.38&lon=126.47
    if (url.pathname === '/api/uv-index') {
      return handleUVIndex(env, request, url, ctx);
    }

    // 바다타임 유속% 조회: GET /api/badatime?sid={station_id}&date={YYYY-MM-DD}
    if (url.pathname === '/api/badatime') {
      return handleBadatime(url, env, request, ctx);
    }

    // 방류/급수 알림 크롤링: GET /api/discharge-notice
    if (url.pathname === '/api/discharge-notice') {
      return handleDischargeNotice(ctx, request, env);
    }

    // KHOA 좌표 기반 API 라우팅: GET /api/khoa/{endpoint}
    const khoaMatch = url.pathname.match(/^\/api\/khoa\/(current-point|current-area)$/);
    if (khoaMatch) {
      return handleKhoaRequest(khoaMatch[1], url, env, ctx, request);
    }

    // 배치 조위 API: 고저조 + 실측 + 시계열 예측을 1회 요청으로 묶음
    if (url.pathname === '/api/batch-tide') {
      const obsCode = url.searchParams.get('obsCode');
      const reqDate = url.searchParams.get('reqDate');
      const validationError = validateParams(obsCode, reqDate);
      if (validationError) {
        return jsonResponse({ error: validationError }, 400, request);
      }

      const apiKey = env.DATA_GO_KR_API_KEY;
      if (!apiKey) {
        return jsonResponse({ error: 'Server configuration error: API key not set' }, 500, request);
      }

      const cache = caches.default;
      const batchEndpoints = ['tide-hilo', 'tide-level', 'tide-time'];
      const defaultPassthrough = {
        'tide-hilo':  { numOfRows: '20', pageNo: '1' },
        'tide-level': { numOfRows: '300', pageNo: '1', min: '10' },
        'tide-time':  { numOfRows: '300', pageNo: '1', min: '10' },
      };
      const resultKeys = { 'tide-hilo': 'hilo', 'tide-level': 'survey', 'tide-time': 'tideTime' };

      const results = await Promise.allSettled(batchEndpoints.map(async (ep) => {
        const pt = defaultPassthrough[ep];
        const paramSig = makeParamSignature(pt);
        const cacheKey = buildCacheKey(ep, obsCode, reqDate, paramSig);

        // 캐시 확인
        const cached = await cache.match(cacheKey);
        if (cached) {
          const data = await cached.json();
          return { key: resultKeys[ep], data, cache: 'HIT' };
        }

        // 업스트림 호출
        const upstreamUrl = buildUpstreamUrl(ep, obsCode, reqDate, apiKey, pt);
        const resp = await fetch(upstreamUrl);
        if (!resp.ok) throw new Error(`Upstream HTTP ${resp.status}`);
        const data = await resp.json();

        const resultCode = extractApiLevelResultCode(data);
        if (resultCode && resultCode !== '00') {
          return { key: resultKeys[ep], data: null, cache: 'ERROR' };
        }

        // 캐시 저장
        const ttl = computeCacheTTL(ep, reqDate);
        const cacheResp = new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
        });
        ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));

        return { key: resultKeys[ep], data, cache: 'MISS' };
      }));

      const batchResult = {};
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          batchResult[r.value.key] = r.value.data;
        } else {
          batchResult[resultKeys[batchEndpoints[idx]]] = null;
        }
      });

      return jsonResponse(batchResult, 200, request);
    }

    // 기존 공공데이터포털 API 라우팅: GET /api/{endpoint}
    const match = url.pathname.match(/^\/api\/(tide-hilo|tide-level|current|tide-time|current-fld-ebb)$/);
    if (!match) {
      return jsonResponse({
        error: 'Not Found',
        endpoints: [
          '/api/tide-hilo', '/api/tide-level', '/api/current',
          '/api/tide-time', '/api/current-fld-ebb',
          '/api/batch-tide', '/api/badatime',
          '/api/current-window',
          '/api/fishing-index',
          '/api/khoa/current-point', '/api/khoa/current-area',
          '/api/discharge-notice',
          '/api/weather',
          '/api/water-temp',
          '/api/uv-index',
          '/api/lunar',
          '/api/visitor'
        ]
      }, 404, request);
    }

    const endpoint = match[1];
    const obsCode = url.searchParams.get('obsCode');
    const reqDate = url.searchParams.get('reqDate');
    const passthroughParams = extractPassthroughParams(url);
    const paramSig = makeParamSignature(passthroughParams);

    const validationError = validateParams(obsCode, reqDate);
    if (validationError) {
      return jsonResponse({ error: validationError }, 400, request);
    }

    const cacheId = obsCode;
    const cacheKey = buildCacheKey(endpoint, cacheId, reqDate, paramSig);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = addCorsHeaders(cached, request);
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }

    // 업스트림 API 호출
    const apiKey = env.DATA_GO_KR_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'Server configuration error: API key not set' }, 500, request);
    }

    const upstreamUrl = buildUpstreamUrl(endpoint, obsCode, reqDate, apiKey, passthroughParams);

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl);
    } catch (e) {
      return jsonResponse({ error: 'Upstream fetch failed', detail: e.message }, 502, request);
    }

    if (!upstreamResp.ok) {
      return jsonResponse({ error: `Upstream returned HTTP ${upstreamResp.status}` }, 502, request);
    }

    let data;
    try {
      data = await upstreamResp.json();
    } catch (e) {
      return jsonResponse({ error: 'Failed to parse upstream response' }, 502, request);
    }

    // API 레벨 에러 확인 → 캐싱하지 않음
    const resultCode = extractApiLevelResultCode(data);
    if (resultCode && resultCode !== '00') {
      return jsonResponse(data, 400, request);
    }

    // 성공 응답 → 캐싱
    const ttl = computeCacheTTL(endpoint, reqDate);
    const response = new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttl}`,
        'X-Cache': 'MISS',
        'X-Cache-TTL': `${ttl}s`,
        ...getCorsHeaders(request),
      },
    });

    // 비동기 캐시 저장
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  },

  // ==================== Scheduled Handler (Cron Trigger) ====================
  // cron 1: "*/5 * * * *" → 5분마다 실시간 데이터 (날씨/수온/풍향) 사전 캐싱
  // cron 2: "0 17 * * *"  → 하루 1회 조위/유속 데이터 사전 캐싱 (02:00 KST)
  async scheduled(event, env, ctx) {
    const cronStr = event.cron || '';

    // weekly incremental validation for major ports (split to keep request budget small)
    if (cronStr === BADATIME_WEEKLY_CRON_A || cronStr === BADATIME_WEEKLY_CRON_B) {
      const partition = cronStr === BADATIME_WEEKLY_CRON_A ? 0 : 1;
      try {
        await runBadatimeWeeklyIncrementalValidation(env, cronStr, partition);
      } catch (e) {
        console.error('[badatime:weekly] unhandled error:', e?.message || String(e));
      }
      return;
    }

    const apiKey = env.DATA_GO_KR_API_KEY;
    if (!apiKey) {
      console.error('[precache] DATA_GO_KR_API_KEY not set');
      return;
    }
    const cache = caches.default;

    const isDailyTide = cronStr === '0 17 * * *';

    if (isDailyTide) {
      // ────── 하루 1회: 조위 + 유속 + 바다낚시지수 ──────
      const dates = [];
      for (let d = 0; d < 8; d++) {
        const target = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
        const p = _kstParts(target);
        dates.push(`${p.year}${p.month}${p.day}`);
      }

      const tasks = buildPrecacheTasks(PRECACHE_PORTS, dates);
      console.log(`[precache:tide] Starting: ${tasks.length} tasks for ${dates.length} days`);
      const results = await runPrecacheBatches(tasks, apiKey, cache, 5, 300);

      // 바다낚시지수
      try {
        const fishCacheKey = buildKhoaCacheKey('fishing-index', `sunsang_${dates[0]}`);
        const fishCached = await cache.match(fishCacheKey);
        if (!fishCached) {
          const fishUrl = buildFishingIndexUrl(apiKey);
          const fishResp = await fetch(fishUrl);
          if (fishResp.ok) {
            const fishData = await fishResp.json();
            const fishResultCode = extractApiLevelResultCode(fishData);
            if (!fishResultCode || fishResultCode === '00') {
              const items = fishData?.body?.items?.item;
              if (items && Array.isArray(items) && items.length > 0) {
                const resp = new Response(JSON.stringify(items), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10800', 'X-Cache': 'PRECACHE' },
                });
                await cache.put(fishCacheKey, resp);
                console.log('[precache:tide] fishing-index cached');
              }
            }
          }
        }
      } catch (e) { console.error('[precache:tide] fishing-index error:', e.message); }

      console.log(`[precache:tide] Done: cached=${results.cached}, hit=${results.hit}, error=${results.error}`);

      // current-window
      const seenCodes = new Set();
      const cwTasks = PRECACHE_PORTS
        .filter(p => p.currentCode && !seenCodes.has(p.currentCode) && seenCodes.add(p.currentCode))
        .map(p => ({ code: p.currentCode }));
      let cwCached = 0, cwHit = 0, cwErr = 0;
      for (const task of cwTasks) {
        for (const date of dates) {
          const ck = buildCacheKey('current-window', task.code, date, 'default');
          if (await cache.match(ck)) { cwHit++; continue; }
          try {
            const fakeUrl = new URL(`https://tide-api-proxy.odk297.workers.dev/api/current-window?obsCode=${task.code}&reqDate=${date}`);
            const fakeReq = new Request(fakeUrl.toString());
            const resp = await handleCurrentWindowRequest(fakeUrl, env, ctx, fakeReq);
            if (resp.status === 200) cwCached++; else cwErr++;
          } catch (e) { cwErr++; }
          await new Promise(r => setTimeout(r, 300));
        }
      }
      console.log(`[precache:tide] current-window: cached=${cwCached}, hit=${cwHit}, error=${cwErr}`);

    } else {
      // ────── 5분마다: 날씨 + 수온 + 풍향 실시간 사전 캐싱 ──────
      const apihubKey = env.KMA_APIHUB_KEY;

      // 고유 격자좌표 + obsCode 추출 (중복 제거)
      const gridSet = new Map(); // "nx,ny" → { nx, ny, lat, lon }
      const obsSet = new Set();
      for (const port of PRECACHE_PORTS) {
        const { nx, ny } = latLonToGrid(parseFloat(port.lat), parseFloat(port.lon));
        const key = `${nx},${ny}`;
        if (!gridSet.has(key)) gridSet.set(key, { nx, ny, lat: port.lat, lon: port.lon });
        obsSet.add(port.obsCode);
      }

      let wCached = 0, wHit = 0, wErr = 0;

      // (A) 날씨 사전 캐싱 — 각 고유 격자에 대해 handleWeather 호출
      const weatherTasks = [...gridSet.values()];
      for (let i = 0; i < weatherTasks.length; i += 5) {
        const batch = weatherTasks.slice(i, i + 5);
        const batchResults = await Promise.allSettled(batch.map(async (g) => {
          const fakeUrl = new URL(`https://tide-api-proxy.odk297.workers.dev/api/weather?nx=${g.nx}&ny=${g.ny}&lat=${g.lat}&lon=${g.lon}`);
          const fakeReq = new Request(fakeUrl.toString());
          const resp = await handleWeather(env, fakeReq, fakeUrl, ctx);
          return resp.status === 200 ? 'ok' : 'err';
        }));
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value === 'ok') wCached++; else wErr++;
        }
        if (i + 5 < weatherTasks.length) await new Promise(r => setTimeout(r, 200));
      }

      // (B) 수온 사전 캐싱 — 각 고유 obsCode
      let wtCached = 0, wtErr = 0;
      const obsList = [...obsSet];
      for (let i = 0; i < obsList.length; i += 5) {
        const batch = obsList.slice(i, i + 5);
        const batchResults = await Promise.allSettled(batch.map(async (code) => {
          const fakeUrl = new URL(`https://tide-api-proxy.odk297.workers.dev/api/water-temp?obsCode=${code}`);
          const fakeReq = new Request(fakeUrl.toString());
          const resp = await handleWaterTemp(env, fakeReq, fakeUrl, ctx);
          return resp.status === 200 ? 'ok' : 'err';
        }));
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value === 'ok') wtCached++; else wtErr++;
        }
        if (i + 5 < obsList.length) await new Promise(r => setTimeout(r, 200));
      }

      // (C) 풍향/풍속 사전 캐싱 — 각 고유 obsCode
      let wdCached = 0, wdErr = 0;
      for (let i = 0; i < obsList.length; i += 5) {
        const batch = obsList.slice(i, i + 5);
        const batchResults = await Promise.allSettled(batch.map(async (code) => {
          const fakeUrl = new URL(`https://tide-api-proxy.odk297.workers.dev/api/wind?obsCode=${code}`);
          const fakeReq = new Request(fakeUrl.toString());
          const resp = await handleWind(env, fakeReq, fakeUrl, ctx);
          return resp.status === 200 ? 'ok' : 'err';
        }));
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value === 'ok') wdCached++; else wdErr++;
        }
        if (i + 5 < obsList.length) await new Promise(r => setTimeout(r, 200));
      }

      // (D) 자외선 지수 사전 캐싱 — 각 고유 격자의 lat/lon 사용
      let uvCached = 0, uvErr = 0;
      const uvTasks = [...gridSet.values()];
      for (let i = 0; i < uvTasks.length; i += 5) {
        const batch = uvTasks.slice(i, i + 5);
        const batchResults = await Promise.allSettled(batch.map(async (g) => {
          const fakeUrl = new URL(`https://tide-api-proxy.odk297.workers.dev/api/uv-index?lat=${g.lat}&lon=${g.lon}`);
          const fakeReq = new Request(fakeUrl.toString());
          const resp = await handleUVIndex(env, fakeReq, fakeUrl, ctx);
          return resp.status === 200 ? 'ok' : 'err';
        }));
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value === 'ok') uvCached++; else uvErr++;
        }
        if (i + 5 < uvTasks.length) await new Promise(r => setTimeout(r, 200));
      }

      console.log(`[precache:realtime] weather=${wCached}ok/${wErr}err, waterTemp=${wtCached}ok/${wtErr}err, wind=${wdCached}ok/${wdErr}err, uv=${uvCached}ok/${uvErr}err`);
    }
  }
};
