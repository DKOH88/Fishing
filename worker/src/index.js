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
  'deviation':  'deviationCal/GetDeviationCalApiService',
  'ls-term-tide-obs': 'lsTermTideObs/GetLsTermTideObsApiService',
  'tidebed':    'tidebed/GetTideBedPreApiService',
  'current-fld-ebb': 'crntFcstFldEbb/GetCrntFcstFldEbbApiService',
};

const DEFAULT_PARAMS = {
  'tide-hilo':  { numOfRows: '20',  pageNo: '1', type: 'json' },
  'tide-level': { numOfRows: '300', pageNo: '1', type: 'json', min: '10' },
  'current':    { numOfRows: '300', pageNo: '1', type: 'json' },
  'tide-time':  { numOfRows: '300', pageNo: '1', type: 'json', min: '10' },
  'deviation':  { numOfRows: '50', pageNo: '1', type: 'json' },
  'ls-term-tide-obs': { numOfRows: '24', pageNo: '1', type: 'json' },
  'tidebed':    { numOfRows: '1500', pageNo: '1', type: 'json' },
  'current-fld-ebb': { numOfRows: '20', pageNo: '1', type: 'json' },
};

const FISHING_ENDPOINT_PATH = 'fcstFishingv2/GetFcstFishingApiServicev2';

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
  'numOfRows', 'pageNo', 'min', 'hour', 'minute', 'placeName', 'gubun', 'include', 'exclude'
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
  Object.entries(passthroughParams || {}).forEach(([k, v]) => url.searchParams.set(k, v));

  return url.toString();
}

function extractApiLevelResultCode(data) {
  return data?.header?.resultCode || data?.response?.header?.resultCode || null;
}

function extractApiLevelResultMsg(data) {
  return data?.header?.resultMsg || data?.response?.header?.resultMsg || null;
}

function buildFishingUpstreamUrl(apiKey, params = {}) {
  const url = new URL(`${UPSTREAM_BASE}/${FISHING_ENDPOINT_PATH}`);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('type', 'json');
  Object.entries(params).forEach(([k, v]) => {
    if (v == null || v === '') return;
    url.searchParams.set(k, String(v));
  });
  return url.toString();
}

function validateFishingParams(reqDate, gubun, pageNo, numOfRows) {
  if (reqDate && !/^\d{8}$/.test(reqDate)) return 'Invalid reqDate (expected YYYYMMDD)';
  if (!gubun || String(gubun).trim() === '') return 'Invalid gubun (required)';
  if (pageNo != null && pageNo !== '' && !/^\d+$/.test(String(pageNo))) return 'Invalid pageNo';
  if (numOfRows != null && numOfRows !== '' && !/^\d+$/.test(String(numOfRows))) return 'Invalid numOfRows';
  return null;
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
  if (scale != null && scale !== '' && !/^\d+$/.test(String(scale))) return 'Invalid scale';
  return null;
}

function validateKhoaTideHarmonicsObsCode(obsCode) {
  if (!obsCode || !/^[A-Za-z0-9_-]{2,20}$/.test(obsCode)) {
    return 'Invalid obsCode';
  }
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

function buildKhoaTideHarmonicsUrl(obsCode, serviceKey) {
  const url = new URL(`${KHOA_BASE}/DataType/search.do`);
  url.searchParams.set('ServiceKey', serviceKey);
  url.searchParams.set('DataType', 'tideObsHar');
  url.searchParams.set('ObsCode', obsCode);
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
      upstreamResp = await fetch(upstreamUrl);
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
      upstreamResp = await fetch(upstreamUrl);
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
  } else if (khoaEndpoint === 'tide-harmonics') {
    const obsCode = url.searchParams.get('obsCode');
    const err = validateKhoaTideHarmonicsObsCode(obsCode);
    if (err) return jsonResponse({ error: err }, 400, request);

    const cacheKey = buildKhoaCacheKey('tide-harmonics', obsCode);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = addCorsHeaders(cached, request);
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }

    const upstreamUrl = buildKhoaTideHarmonicsUrl(obsCode, khoaKey);
    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl);
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

    const rows = data?.result?.data;
    if (!rows || (Array.isArray(rows) && rows.length === 0)) {
      return jsonResponse({ error: 'KHOA API returned no data', raw: data }, 400, request);
    }

    // 조화상수는 자주 변하지 않으므로 장기 캐시
    const ttl = 30 * 24 * 60 * 60;
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

    // 음양력 변환 API: GET /api/lunar?solYear=2026&solMonth=09&solDay=01
    if (url.pathname === '/api/lunar') {
      return handleLunarRequest(url, env, ctx, request);
    }

    // 바다낚시지수 API: GET /api/fishing-index?reqDate=YYYYMMDD&gubun=선상&placeName=오천
    if (url.pathname === '/api/fishing-index') {
      const reqDate = url.searchParams.get('reqDate') || getTodayStr();
      const gubun = url.searchParams.get('gubun') || '선상';
      const placeName = url.searchParams.get('placeName') || '';
      const include = url.searchParams.get('include') || '';
      const exclude = url.searchParams.get('exclude') || '';
      const pageNo = url.searchParams.get('pageNo') || '1';
      const numOfRows = url.searchParams.get('numOfRows') || '20';

      const err = validateFishingParams(reqDate, gubun, pageNo, numOfRows);
      if (err) return jsonResponse({ error: err }, 400, request);

      const cacheSig = makeParamSignature({ reqDate, gubun, placeName, include, exclude, pageNo, numOfRows });
      const cacheKey = new Request(`https://tide-cache.internal/fishing-index/${cacheSig}`);
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) {
        const resp = addCorsHeaders(cached, request);
        resp.headers.set('X-Cache', 'HIT');
        return resp;
      }

      const apiKey = env.FISHING_API_KEY || env.DATA_GO_KR_API_KEY;
      if (!apiKey) {
        return jsonResponse({ error: 'Server configuration error: FISHING_API_KEY not set' }, 500, request);
      }

      const upstreamUrl = buildFishingUpstreamUrl(apiKey, {
        reqDate, gubun, placeName, include, exclude, pageNo, numOfRows
      });

      let upstreamResp;
      try {
        upstreamResp = await fetch(upstreamUrl);
      } catch (e) {
        return jsonResponse({ error: 'Fishing API fetch failed', detail: e.message }, 502, request);
      }

      if (!upstreamResp.ok) {
        return jsonResponse({ error: `Fishing API returned HTTP ${upstreamResp.status}` }, 502, request);
      }

      let data;
      try {
        data = await upstreamResp.json();
      } catch (e) {
        return jsonResponse({ error: 'Failed to parse fishing API response' }, 502, request);
      }

      const resultCode = extractApiLevelResultCode(data);
      if (resultCode && resultCode !== '00') {
        return jsonResponse({
          error: extractApiLevelResultMsg(data) || 'Fishing API error',
          raw: data
        }, 400, request);
      }

      const ttl = computeCacheTTL('fishing-index', reqDate);
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

    // KHOA 좌표 기반 API 라우팅: GET /api/khoa/{endpoint}
    const khoaMatch = url.pathname.match(/^\/api\/khoa\/(current-point|current-area|tide-harmonics)$/);
    if (khoaMatch) {
      return handleKhoaRequest(khoaMatch[1], url, env, ctx, request);
    }

    // 기존 공공데이터포털 API 라우팅: GET /api/{endpoint}
    const match = url.pathname.match(/^\/api\/(tide-hilo|tide-level|current|tide-time|deviation|ls-term-tide-obs|tidebed|current-fld-ebb)$/);
    if (!match) {
      return jsonResponse({
        error: 'Not Found',
        endpoints: [
          '/api/tide-hilo', '/api/tide-level', '/api/current',
          '/api/tide-time', '/api/deviation', '/api/ls-term-tide-obs', '/api/tidebed', '/api/current-fld-ebb',
          '/api/fishing-index',
          '/api/khoa/current-point', '/api/khoa/current-area', '/api/khoa/tide-harmonics',
          '/api/lunar'
        ]
      }, 404, request);
    }

    const endpoint = match[1];
    const obsCode = url.searchParams.get('obsCode');
    const reqDate = url.searchParams.get('reqDate');
    const passthroughParams = extractPassthroughParams(url);
    const paramSig = makeParamSignature(passthroughParams);

    // 입력 검증
    const validationError = validateParams(obsCode, reqDate);
    if (validationError) {
      return jsonResponse({ error: validationError }, 400, request);
    }

    // 캐시 확인
    const cacheKey = buildCacheKey(endpoint, obsCode, reqDate, paramSig);
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
  }
};
