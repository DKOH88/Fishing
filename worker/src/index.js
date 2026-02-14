// ==================== Tide API Proxy (Cloudflare Worker) ====================
// 공공데이터포털 API를 캐싱하여 프록시하는 Cloudflare Worker
// API 키를 서버에 숨기고, 동일 요청을 Cache API로 캐싱

const UPSTREAM_BASE = 'http://apis.data.go.kr/1192136';

const ENDPOINT_MAP = {
  'tide-hilo':  'tideFcstHghLw/GetTideFcstHghLwApiService',
  'tide-level': 'surveyTideLevel/GetSurveyTideLevelApiService',
  'current':    'crntFcstTime/GetCrntFcstTimeApiService',
};

const DEFAULT_PARAMS = {
  'tide-hilo':  { numOfRows: '20',  pageNo: '1', type: 'json' },
  'tide-level': { numOfRows: '300', pageNo: '1', type: 'json', min: '10' },
  'current':    { numOfRows: '300', pageNo: '1', type: 'json' },
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// ==================== Helpers ====================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function addCorsHeaders(response) {
  const newHeaders = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function handleOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
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
    if (endpoint === 'tide-level') {
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

function buildCacheKey(endpoint, obsCode, reqDate) {
  return new Request(`https://tide-cache.internal/${endpoint}/${obsCode}/${reqDate}`);
}

function buildUpstreamUrl(endpoint, obsCode, reqDate, apiKey) {
  const path = ENDPOINT_MAP[endpoint];
  const url = new URL(`${UPSTREAM_BASE}/${path}`);

  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('obsCode', obsCode);
  url.searchParams.set('reqDate', reqDate);

  const defaults = DEFAULT_PARAMS[endpoint];
  Object.entries(defaults).forEach(([k, v]) => url.searchParams.set(k, v));

  return url.toString();
}

// ==================== Main Handler ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    // 라우팅: GET /api/{endpoint}
    const match = url.pathname.match(/^\/api\/(tide-hilo|tide-level|current)$/);
    if (!match) {
      return jsonResponse({ error: 'Not Found', endpoints: ['/api/tide-hilo', '/api/tide-level', '/api/current'] }, 404);
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const endpoint = match[1];
    const obsCode = url.searchParams.get('obsCode');
    const reqDate = url.searchParams.get('reqDate');

    // 입력 검증
    const validationError = validateParams(obsCode, reqDate);
    if (validationError) {
      return jsonResponse({ error: validationError }, 400);
    }

    // 캐시 확인
    const cacheKey = buildCacheKey(endpoint, obsCode, reqDate);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = addCorsHeaders(cached);
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }

    // 업스트림 API 호출
    const apiKey = env.DATA_GO_KR_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'Server configuration error: API key not set' }, 500);
    }

    const upstreamUrl = buildUpstreamUrl(endpoint, obsCode, reqDate, apiKey);

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl);
    } catch (e) {
      return jsonResponse({ error: 'Upstream fetch failed', detail: e.message }, 502);
    }

    if (!upstreamResp.ok) {
      return jsonResponse({ error: `Upstream returned HTTP ${upstreamResp.status}` }, 502);
    }

    let data;
    try {
      data = await upstreamResp.json();
    } catch (e) {
      return jsonResponse({ error: 'Failed to parse upstream response' }, 502);
    }

    // API 레벨 에러 확인 → 캐싱하지 않음
    if (data.header && data.header.resultCode !== '00') {
      return jsonResponse(data, 400);
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
        ...CORS_HEADERS,
      },
    });

    // 비동기 캐시 저장
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  }
};
