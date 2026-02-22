/**
 * 심층 분석: crsp 기반 vs 조차 기반 유속% 비교
 * - 30일간 데이터 수집 (Feb 7 ~ Mar 8, 2026 = 사리→조금→사리 한 주기+)
 * - 여러 정규화 공식 비교
 * - 바다타임 값 스크래핑하여 대조
 */
const { chromium } = require('playwright');

const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';
const TIDE_STATION = 'DT_0025';  // 보령
const CURRENT_STATION = '16LTC03'; // 천수만

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.json();
}

// ① crsp 윈도우 데이터 (±15일 일별 max)
async function getCrspWindow(dateStr) {
    try {
        const data = await fetchJSON(`${API_BASE}/api/current-window?obsCode=${CURRENT_STATION}&reqDate=${dateStr}`);
        return data.dailyMaxSpeeds || [];
    } catch(e) { console.warn('crsp window error:', e.message); return []; }
}

// ② 해당일 crsp 시계열에서 max 추출
async function getDayCrspMax(dateStr) {
    try {
        const data = await fetchJSON(`${API_BASE}/api/current?obsCode=${CURRENT_STATION}&reqDate=${dateStr}&numOfRows=300&pageNo=1&min=10`);
        const items = data?.body?.items?.item || [];
        const arr = Array.isArray(items) ? items : [items];
        const dayItems = arr.filter(i => {
            const dt = (i.predcDt || '').replace(/[^0-9]/g, '');
            return dt.startsWith(dateStr);
        });
        const speeds = dayItems.map(i => parseFloat(i.crsp) || 0).filter(s => s > 0);
        return speeds.length > 0 ? Math.max(...speeds) : null;
    } catch(e) { return null; }
}

// ③ 고저조 데이터에서 조차 계산
async function getTidalRange(dateStr) {
    try {
        const data = await fetchJSON(`${API_BASE}/api/tide-hilo?obsCode=${TIDE_STATION}&reqDate=${dateStr}&numOfRows=50&pageNo=1`);
        const items = data?.body?.items?.item || [];
        const arr = Array.isArray(items) ? items : [items];
        const dayItems = arr.filter(i => {
            const dt = (i.predcDt || '').replace(/[^0-9]/g, '');
            return dt.startsWith(dateStr);
        });
        // extrSe: 1=고조, 2=저조, 3=고조, 4=저조
        const highs = dayItems.filter(i => i.extrSe === '1' || i.extrSe === '3');
        const lows = dayItems.filter(i => i.extrSe === '2' || i.extrSe === '4');
        if (highs.length === 0 || lows.length === 0) return null;
        const maxHigh = Math.max(...highs.map(h => parseFloat(h.predcTdlvVl)));
        const minLow = Math.min(...lows.map(l => parseFloat(l.predcTdlvVl)));
        return maxHigh - minLow;
    } catch(e) { return null; }
}

// ④ 바다타임 유속% 스크래핑
async function getBadatimeValues(browser, dateStr) {
    const page = await browser.newPage();
    try {
        const y = dateStr.slice(0, 4), m = dateStr.slice(4, 6), d = dateStr.slice(6, 8);
        const url = `https://www.badatime.com/news-tideTime.html?tid=234&date=${y}-${m}-${d}`;
        await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);

        const result = await page.evaluate(() => {
            const text = document.body.innerText;
            // "유속 XX%" 패턴 찾기
            const pctMatch = text.match(/유속\s*(\d+)\s*%/);
            // 물때 이름 찾기
            const mulMatch = text.match(/(사리|조금|무시|\d+물)/);
            return {
                pct: pctMatch ? parseInt(pctMatch[1]) : null,
                mulddae: mulMatch ? mulMatch[1] : null
            };
        });
        return result;
    } catch(e) {
        return { pct: null, mulddae: null };
    } finally {
        await page.close();
    }
}

// 정규화 공식들
function maxRatio(val, max) {
    if (!max || max <= 0 || val == null) return null;
    return Math.round(Math.min(100, Math.max(0, (val / max) * 100)));
}

function minMaxNorm(val, min, max) {
    if (max <= min || val == null) return null;
    return Math.round(Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100)));
}

function percentileRank(val, arr) {
    if (!arr || arr.length === 0 || val == null) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    let below = 0;
    for (const v of sorted) {
        if (v < val) below++;
    }
    return Math.round((below / (sorted.length - 1)) * 100);
}

// 음력 기반 물때 계산
function getMulddaeName(dateStr) {
    const NAMES = ['8물','9물','10물','11물','12물','13물','조금','무시','1물','2물','3물','4물','5물','6물','사리'];
    const y = parseInt(dateStr.slice(0, 4));
    const m = parseInt(dateStr.slice(4, 6));
    const d = parseInt(dateStr.slice(6, 8));
    const jd = Math.floor(367 * y - Math.floor(7 * (y + Math.floor((m + 9) / 12)) / 4) + Math.floor(275 * m / 9) + d + 1721013.5);
    const lunarDay = Math.round((jd - 2451550.1) % 29.53058867);
    const idx = ((lunarDay % 15) + 15) % 15;
    return NAMES[idx] || '?';
}

async function main() {
    console.log('=== crsp vs 조차 유속% 심층 분석 ===');
    console.log(`관측소: 보령(${TIDE_STATION}) / 조류: 천수만(${CURRENT_STATION})\n`);

    // 분석 기간: 2026-02-07 ~ 2026-03-08 (30일)
    const dates = [];
    for (let i = 0; i < 30; i++) {
        const dt = new Date(2026, 1, 7 + i);
        const ds = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
        dates.push(ds);
    }

    // 1단계: crsp 윈도우 (중앙 날짜 기준)
    console.log('1단계: crsp ±15일 윈도우 수집...');
    const crspWindow = await getCrspWindow('20260222');
    const crspWindowMap = {};
    const crspDailyMaxArr = [];
    for (const entry of crspWindow) {
        crspWindowMap[entry.date] = entry.maxCrsp;
        crspDailyMaxArr.push(entry.maxCrsp);
    }
    if (crspDailyMaxArr.length > 0) {
        console.log(`  윈도우: ${crspWindow.length}일, [${Math.min(...crspDailyMaxArr).toFixed(1)} ~ ${Math.max(...crspDailyMaxArr).toFixed(1)}]`);
    }

    // 2단계: 일별 데이터 수집
    console.log('\n2단계: 일별 crsp max + 조차 수집 (30일)...');
    const rows = [];
    for (const dateStr of dates) {
        const [crspMax, tidalRange] = await Promise.all([
            getDayCrspMax(dateStr),
            getTidalRange(dateStr)
        ]);
        const mulddae = getMulddaeName(dateStr);
        rows.push({ dateStr, mulddae, crspMax, tidalRange });
        const cm = crspMax != null ? crspMax.toFixed(1) : 'N/A';
        const tr = tidalRange != null ? tidalRange.toFixed(0) : 'N/A';
        process.stdout.write(`  ${dateStr} ${mulddae.padEnd(3)}: crsp=${cm.padStart(6)}, 조차=${tr.padStart(4)}\n`);
    }

    // 윈도우 통계
    const crspMaxes = rows.map(r => r.crspMax).filter(v => v != null);
    const rangeValues = rows.map(r => r.tidalRange).filter(v => v != null);
    const crspWMax = crspMaxes.length > 0 ? Math.max(...crspMaxes) : 0;
    const crspWMin = crspMaxes.length > 0 ? Math.min(...crspMaxes) : 0;
    const rangeMax = rangeValues.length > 0 ? Math.max(...rangeValues) : 0;
    const rangeMin = rangeValues.length > 0 ? Math.min(...rangeValues) : 0;

    console.log(`\n  crsp 30일: [${crspWMin.toFixed(1)} ~ ${crspWMax.toFixed(1)}], ratio min/max = ${(crspWMin/crspWMax*100).toFixed(0)}%`);
    console.log(`  조차 30일: [${rangeMin.toFixed(0)} ~ ${rangeMax.toFixed(0)}], ratio min/max = ${(rangeMin/rangeMax*100).toFixed(0)}%`);

    // 3단계: 바다타임 스크래핑
    console.log('\n3단계: 바다타임 유속% 스크래핑...');
    const browser = await chromium.launch({ headless: true });
    const badatimeMap = {};
    for (const dateStr of dates) {
        const result = await getBadatimeValues(browser, dateStr);
        badatimeMap[dateStr] = result.pct;
        if (result.pct != null) {
            process.stdout.write(`  ${dateStr}: ${result.pct}% (${result.mulddae || '?'})\n`);
        } else {
            process.stdout.write(`  ${dateStr}: N/A\n`);
        }
    }
    await browser.close();

    // ======= 비교 테이블 =======
    console.log('\n' + '='.repeat(140));
    console.log('날짜     | 물때 | crspMax | 조차  | ① crsp비율 | ② crspMM | ③ crsp순위 | ④ 조차비율 | ⑤ 조차MM | ⑥ 조차순위 | 바다타임 | ④-바다 | ①-바다');
    console.log('-'.repeat(140));

    for (const r of rows) {
        const c1 = maxRatio(r.crspMax, crspWMax);
        const c2 = minMaxNorm(r.crspMax, crspWMin, crspWMax);
        const c3 = percentileRank(r.crspMax, crspMaxes);
        const r1 = maxRatio(r.tidalRange, rangeMax);
        const r2 = minMaxNorm(r.tidalRange, rangeMin, rangeMax);
        const r3 = percentileRank(r.tidalRange, rangeValues);
        const bada = badatimeMap[r.dateStr];

        const fmt = (v) => v != null ? String(v).padStart(3) + '%' : '  - ';
        const diff = (a, b) => (a != null && b != null) ? ((a - b >= 0 ? '+' : '') + (a - b)).padStart(4) : '   -';
        const d = r.dateStr.slice(4, 6) + '/' + r.dateStr.slice(6, 8);

        console.log(
            `${d} ${r.dateStr} | ${(r.mulddae).padEnd(3)} | ` +
            `${r.crspMax != null ? r.crspMax.toFixed(1).padStart(6) : '   N/A'} | ` +
            `${r.tidalRange != null ? r.tidalRange.toFixed(0).padStart(4) : ' N/A'} | ` +
            `${fmt(c1)}       | ${fmt(c2)}     | ${fmt(c3)}       | ` +
            `${fmt(r1)}       | ${fmt(r2)}     | ${fmt(r3)}       | ` +
            `${fmt(bada)}     | ${diff(r1, bada)}   | ${diff(c1, bada)}`
        );
    }
    console.log('='.repeat(140));

    // ======= MAE 분석 =======
    console.log('\n=== 바다타임 대비 평균 절대 오차 (MAE) ===');
    const methods = {
        '① crsp비율 (todayMax/wMax)     ': (r) => maxRatio(r.crspMax, crspWMax),
        '② crsp MinMax                  ': (r) => minMaxNorm(r.crspMax, crspWMin, crspWMax),
        '③ crsp 순위 (percentile)        ': (r) => percentileRank(r.crspMax, crspMaxes),
        '④ 조차비율 (diff/maxDiff)        ': (r) => maxRatio(r.tidalRange, rangeMax),
        '⑤ 조차 MinMax                   ': (r) => minMaxNorm(r.tidalRange, rangeMin, rangeMax),
        '⑥ 조차 순위 (percentile)         ': (r) => percentileRank(r.tidalRange, rangeValues),
    };

    for (const [name, fn] of Object.entries(methods)) {
        let totalErr = 0, maxErr = 0, count = 0;
        const errors = [];
        for (const r of rows) {
            const bada = badatimeMap[r.dateStr];
            const calc = fn(r);
            if (bada != null && calc != null) {
                const err = Math.abs(calc - bada);
                totalErr += err;
                maxErr = Math.max(maxErr, err);
                count++;
                errors.push(err);
            }
        }
        const mae = count > 0 ? (totalErr / count).toFixed(1) : 'N/A';
        const me = count > 0 ? maxErr : 'N/A';
        console.log(`  ${name} MAE=${mae}, MaxErr=${me}, n=${count}`);
    }

    // 동적 범위 비교
    console.log('\n=== 동적 범위 분석 ===');
    console.log(`  crsp: min=${crspWMin.toFixed(1)}, max=${crspWMax.toFixed(1)}, 비율=${(crspWMin/crspWMax*100).toFixed(0)}% (최약일도 최강일의 ${(crspWMin/crspWMax*100).toFixed(0)}%)`);
    console.log(`  조차: min=${rangeMin.toFixed(0)}, max=${rangeMax.toFixed(0)}, 비율=${(rangeMin/rangeMax*100).toFixed(0)}% (최약일도 최강일의 ${(rangeMin/rangeMax*100).toFixed(0)}%)`);
    console.log(`\n  → crsp는 사리/조금 간 변동폭이 ${(100 - crspWMin/crspWMax*100).toFixed(0)}%p`);
    console.log(`  → 조차는 사리/조금 간 변동폭이 ${(100 - rangeMin/rangeMax*100).toFixed(0)}%p`);
}

main().catch(e => { console.error(e); process.exit(1); });
