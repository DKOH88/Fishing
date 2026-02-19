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
  'tidebed':    'tidebed/GetTidebedApiService',
  'current-fld-ebb': 'crntFcstFldEbb/GetCrntFcstFldEbbApiService',
};

const DEFAULT_PARAMS = {
  'tide-hilo':  { numOfRows: '20',  pageNo: '1', type: 'json' },
  'tide-level': { numOfRows: '300', pageNo: '1', type: 'json', min: '10' },
  'current':    { numOfRows: '300', pageNo: '1', type: 'json' },
  'tide-time':  { numOfRows: '300', pageNo: '1', type: 'json', min: '10' },
  'tidebed':    { numOfRows: '300', pageNo: '1', type: 'json' },
  'current-fld-ebb': { numOfRows: '20', pageNo: '1', type: 'json' },
};


// ==================== 사전 캐싱 대상 포인트 (Cron Trigger) ====================
const PRECACHE_PORTS = [
  { name: '오천항',   obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.38', lon: '126.47' },
  { name: '안흥항',   obsCode: 'DT_0067', currentCode: '07TA05',  lat: '36.67', lon: '126.13' },
  { name: '영흥도',   obsCode: 'DT_0043', currentCode: '20LTC04', lat: '37.25', lon: '126.47' },
  { name: '삼길포항', obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.33', lon: '126.42' },
  { name: '대천항',   obsCode: 'DT_0025', currentCode: '07KS01',  lat: '36.32', lon: '126.51' },
  { name: '마검포항', obsCode: 'DT_0067', currentCode: '23GA01',  lat: '36.41', lon: '126.33' },
  { name: '무창포항', obsCode: 'DT_0025', currentCode: '07KS01',  lat: '36.27', lon: '126.54' },
  { name: '영목항',   obsCode: 'DT_0067', currentCode: '23GA01',  lat: '36.38', lon: '126.32' },
  { name: '인천',     obsCode: 'DT_0001', currentCode: '07GG06',  lat: '37.45', lon: '126.59' },
  { name: '평택',     obsCode: 'DT_0002', currentCode: '13PT01',  lat: '36.97', lon: '126.82' },
  { name: '구매항',   obsCode: 'DT_0067', currentCode: '23GA01',  lat: '36.50', lon: '126.27' },
  { name: '남당항',   obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.53', lon: '126.44' },
  { name: '대야도',   obsCode: 'DT_0025', currentCode: '16LTC03', lat: '36.38', lon: '126.50' },
  { name: '백사장항', obsCode: 'DT_0008', currentCode: '16DJ04',  lat: '37.24', lon: '126.58' },
  { name: '여수',     obsCode: 'DT_0016', currentCode: '15LTC10', lat: '34.75', lon: '127.77' },
  { name: '녹동항',   obsCode: 'DT_0026', currentCode: '06YS09',  lat: '34.48', lon: '127.08' },
  { name: '전곡항',   obsCode: 'DT_0008', currentCode: '19LTC01', lat: '37.15', lon: '126.66' },
  { name: '홍원항',   obsCode: 'DT_0025', currentCode: '07KS01',  lat: '36.30', lon: '126.48' },
];

const ALLOWED_ORIGINS = new Set([
  'https://fishing-tide.pages.dev',
  'https://fishing-info.pages.dev',
]);

// localhost/127.0.0.1 with any port (dev only)
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

function isOriginAllowed(origin) {
  return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN_RE.test(origin);
}

function getCorsHeaders(request) {
  const origin = (request && request.headers && request.headers.get('Origin')) || '';
  return {
    'Access-Control-Allow-Origin': isOriginAllowed(origin) ? origin : 'https://fishing-tide.pages.dev',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
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

function getKoreaNow() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

function getTodayStr() {
  const kst = getKoreaNow();
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
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
    if (endpoint === 'tide-level' || endpoint === 'tide-time' || endpoint === 'tidebed') {
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
  'numOfRows', 'pageNo', 'min', 'hour', 'minute', 'placeName', 'gubun', 'include', 'exclude', 'lat', 'lot'
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

  if (endpoint === 'tidebed') {
    // TideBED는 obsCode 대신 lat/lot 좌표 사용
    const lat = passthroughParams.lat;
    const lot = passthroughParams.lot;
    if (lat) url.searchParams.set('lat', lat);
    if (lot) url.searchParams.set('lot', lot);
  } else {
    url.searchParams.set('obsCode', obsCode);
  }

  url.searchParams.set('reqDate', reqDate);

  const defaults = DEFAULT_PARAMS[endpoint];
  Object.entries(defaults).forEach(([k, v]) => url.searchParams.set(k, v));

  // tidebed의 lat/lot은 이미 위에서 처리했으므로 제외
  Object.entries(passthroughParams || {}).forEach(([k, v]) => {
    if (endpoint === 'tidebed' && (k === 'lat' || k === 'lot')) return;
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

    // 캐시 확인
    const cacheParamsStr = `${lat}_${lon}_${date}`;
    const cacheKey = buildKhoaCacheKey('current-point', cacheParamsStr);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = addCorsHeaders(cached, request);
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }

    // KHOA API 호출
    const upstreamUrl = buildKhoaCurrentPointUrl(lat, lon, date, khoaKey);
    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
      });
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

    // KHOA 에러 체크: result.meta 없거나 data 없으면 에러
    if (!data.result || !data.result.data) {
      return jsonResponse({ error: 'KHOA API returned no data', raw: data }, 400, request);
    }

    // 캐싱
    const ttl = computeCacheTTL('khoa-current-point', date);
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

    // 캐시 확인
    const cacheParamsStr = `${date}_${hour}_${minute}_${minX}_${maxX}_${minY}_${maxY}_${scale}`;
    const cacheKey = buildKhoaCacheKey('current-area', cacheParamsStr);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = addCorsHeaders(cached, request);
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }

    // KHOA API 호출
    const upstreamUrl = buildKhoaCurrentAreaUrl(date, hour, minute, minX, maxX, minY, maxY, scale, khoaKey);
    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
      });
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
      return jsonResponse({ error: 'KHOA API returned no data', raw: data }, 400, request);
    }

    // 캐싱 (영역 조류는 특정 시각 데이터 → 같은 TTL)
    const ttl = computeCacheTTL('khoa-current-area', date);
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

  return jsonResponse({ error: 'Unknown KHOA endpoint' }, 404, request);
}

// ==================== 방문자 카운터 ====================

async function handleVisitorRequest(request, env) {
  const KV = env.VISITOR_STORE;
  if (!KV) {
    return jsonResponse({ error: 'Visitor store not configured' }, 500, request);
  }

  const todayStr = getTodayStr();
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const ipHash = await hashIP(ip);

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
    return jsonResponse({ error: 'No lunar data found', raw: data }, 400, request);
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

async function checkRateLimit(request, env, isVisitor = false) {
  const KV = env.VISITOR_STORE;
  if (!KV) return null;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await hashIP(ip);
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

      // tidebed (lat/lon 기준)
      const bedKey = `tidebed|${port.lat}|${port.lon}|${date}`;
      if (!seen.has(bedKey)) {
        seen.add(bedKey);
        tasks.push({
          endpoint: 'tidebed',
          obsCode: null,
          reqDate: date,
          passthrough: { lat: port.lat, lot: port.lon, numOfRows: '300', pageNo: '1' },
        });
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
  let cacheId;
  if (task.endpoint === 'tidebed') {
    cacheId = `${task.passthrough.lat}_${task.passthrough.lot}`;
  } else {
    cacheId = task.obsCode;
  }

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

    // Rate limiting (visitor는 엄격한 제한)
    const isVisitorEndpoint = url.pathname === '/api/visitor';
    {
      const retryAfter = await checkRateLimit(request, env, isVisitorEndpoint);
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
      return handleVisitorRequest(request, env);
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

    // KHOA 좌표 기반 API 라우팅: GET /api/khoa/{endpoint}
    const khoaMatch = url.pathname.match(/^\/api\/khoa\/(current-point|current-area)$/);
    if (khoaMatch) {
      return handleKhoaRequest(khoaMatch[1], url, env, ctx, request);
    }

    // 기존 공공데이터포털 API 라우팅: GET /api/{endpoint}
    const match = url.pathname.match(/^\/api\/(tide-hilo|tide-level|current|tide-time|tidebed|current-fld-ebb)$/);
    if (!match) {
      return jsonResponse({
        error: 'Not Found',
        endpoints: [
          '/api/tide-hilo', '/api/tide-level', '/api/current',
          '/api/tide-time', '/api/tidebed', '/api/current-fld-ebb',
          '/api/fishing-index',
          '/api/khoa/current-point', '/api/khoa/current-area',
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

    // 입력 검증 (tidebed는 obsCode 대신 lat/lot 사용)
    if (endpoint === 'tidebed') {
      const lat = passthroughParams.lat;
      const lot = passthroughParams.lot;
      if (!lat || !lot || !COORD_RE.test(lat) || !COORD_RE.test(lot)) {
        return jsonResponse({ error: 'Invalid lat/lot (required for tidebed)' }, 400, request);
      }
      if (!reqDate || !/^\d{8}$/.test(reqDate)) {
        return jsonResponse({ error: 'Invalid reqDate (expected YYYYMMDD)' }, 400, request);
      }
    } else {
      const validationError = validateParams(obsCode, reqDate);
      if (validationError) {
        return jsonResponse({ error: validationError }, 400, request);
      }
    }

    // 캐시 확인 (tidebed는 lat/lot 기반 캐시키)
    const cacheId = endpoint === 'tidebed' ? `${passthroughParams.lat}_${passthroughParams.lot}` : obsCode;
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
  async scheduled(event, env, ctx) {
    const apiKey = env.DATA_GO_KR_API_KEY;
    if (!apiKey) {
      console.error('[precache] DATA_GO_KR_API_KEY not set');
      return;
    }

    const cache = caches.default;

    // KST 기준 오늘 ~ +7일 날짜 생성
    const kstNow = getKoreaNow();
    const dates = [];
    for (let d = 0; d < 8; d++) {
      const target = new Date(kstNow.getTime() + d * 24 * 60 * 60 * 1000);
      const y = target.getUTCFullYear();
      const m = String(target.getUTCMonth() + 1).padStart(2, '0');
      const day = String(target.getUTCDate()).padStart(2, '0');
      dates.push(`${y}${m}${day}`);
    }

    // 중복 제거된 태스크 목록 생성
    const tasks = buildPrecacheTasks(PRECACHE_PORTS, dates);
    console.log(`[precache] Starting: ${tasks.length} tasks for ${dates.length} days (${dates[0]}~${dates[dates.length - 1]})`);

    // 배치 실행 (10개 동시, 200ms 간격)
    const results = await runPrecacheBatches(tasks, apiKey, cache, 10, 200);

    // 바다낚시지수 사전 캐싱
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
              const ttl = 3 * 60 * 60;
              const resp = new Response(JSON.stringify(items), {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'Cache-Control': `public, max-age=${ttl}`,
                  'X-Cache': 'PRECACHE',
                },
              });
              await cache.put(fishCacheKey, resp);
              console.log('[precache] fishing-index cached');
            }
          }
        }
      } else {
        console.log('[precache] fishing-index already cached');
      }
    } catch (e) {
      console.error('[precache] fishing-index error:', e.message);
    }

    console.log(`[precache] Done: cached=${results.cached}, hit=${results.hit}, error=${results.error}, total=${results.total}`);
  }
};
