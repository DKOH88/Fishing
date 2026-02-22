/**
 * 심층 분석 v2: 6가지 공식 vs 바다타임 MAE 비교
 * 바다타임 URL: /134 (모항항 = 보령 인근)
 */
const { chromium } = require('playwright');

const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';
const TIDE_STATION = 'DT_0025';
const CURRENT_STATION = '16LTC03';

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

async function getDayCrspMax(dateStr) {
    try {
        const data = await fetchJSON(`${API_BASE}/api/current?obsCode=${CURRENT_STATION}&reqDate=${dateStr}&numOfRows=300&pageNo=1&min=10`);
        const items = data?.body?.items?.item || [];
        const arr = Array.isArray(items) ? items : [items];
        const dayItems = arr.filter(i => (i.predcDt || '').replace(/[^0-9]/g, '').startsWith(dateStr));
        const speeds = dayItems.map(i => parseFloat(i.crsp) || 0).filter(s => s > 0);
        return speeds.length > 0 ? Math.max(...speeds) : null;
    } catch { return null; }
}

async function getTidalRange(dateStr) {
    try {
        const data = await fetchJSON(`${API_BASE}/api/tide-hilo?obsCode=${TIDE_STATION}&reqDate=${dateStr}&numOfRows=50&pageNo=1`);
        const items = data?.body?.items?.item || [];
        const arr = Array.isArray(items) ? items : [items];
        const dayItems = arr.filter(i => (i.predcDt || '').replace(/[^0-9]/g, '').startsWith(dateStr));
        const highs = dayItems.filter(i => i.extrSe === '1' || i.extrSe === '3');
        const lows = dayItems.filter(i => i.extrSe === '2' || i.extrSe === '4');
        if (highs.length === 0 || lows.length === 0) return null;
        const maxH = Math.max(...highs.map(h => parseFloat(h.predcTdlvVl)));
        const minL = Math.min(...lows.map(l => parseFloat(l.predcTdlvVl)));
        return maxH - minL;
    } catch { return null; }
}

// 바다타임 전체 월간 데이터 스크래핑
async function scrapeBadatime(browser, stationId) {
    const page = await browser.newPage();
    try {
        await page.goto(`https://www.badatime.com/${stationId}`, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        // 테이블 행에서 날짜별 물때, % 추출
        const data = await page.evaluate(() => {
            const rows = document.querySelectorAll('tr, .tide-row, [class*="row"]');
            const results = {};
            const text = document.body.innerText;

            // 날짜별 블록 파싱: "22(일)\n4.5\n13 물\n76%\n" 패턴
            // 더 정확한 접근: 모든 텍스트를 줄 단위로 파싱
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);

            for (let i = 0; i < lines.length; i++) {
                // 날짜 패턴: "22(일)" 또는 숫자만
                const dateMatch = lines[i].match(/^(\d{1,2})\s*\([월화수목금토일]\)/);
                if (dateMatch) {
                    const day = parseInt(dateMatch[1]);
                    // 이후 줄에서 물때와 % 찾기
                    let mulddae = null, pct = null;
                    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
                        const mulMatch = lines[j].match(/^(사리|조금|무시|\d{1,2}\s*물)$/);
                        if (mulMatch) mulddae = mulMatch[1].replace(/\s/g, '');
                        const pctMatch = lines[j].match(/^(\d{1,3})%$/);
                        if (pctMatch) pct = parseInt(pctMatch[1]);
                    }
                    if (pct != null) {
                        results[day] = { mulddae, pct };
                    }
                }
            }
            return results;
        });
        return data;
    } catch(e) {
        console.error('바다타임 스크래핑 실패:', e.message);
        return {};
    } finally {
        await page.close();
    }
}

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
    for (const v of sorted) { if (v < val) below++; }
    return Math.round((below / Math.max(1, sorted.length - 1)) * 100);
}

async function main() {
    console.log('=== crsp vs 조차 유속% 심층 분석 v2 ===');
    console.log(`관측소: 보령(${TIDE_STATION}) / 조류: 천수만(${CURRENT_STATION})\n`);

    // 2026-02-07 ~ 2026-03-08 (30일)
    const dates = [];
    for (let i = 0; i < 30; i++) {
        const dt = new Date(2026, 1, 7 + i);
        dates.push({
            str: `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`,
            month: dt.getMonth() + 1,
            day: dt.getDate()
        });
    }

    // 1) 일별 데이터
    console.log('1단계: API 데이터 수집...');
    const rows = [];
    for (const d of dates) {
        const [crspMax, tidalRange] = await Promise.all([getDayCrspMax(d.str), getTidalRange(d.str)]);
        rows.push({ ...d, crspMax, tidalRange });
        process.stdout.write('.');
    }
    console.log(' 완료!\n');

    // 윈도우 통계
    const crspMaxes = rows.map(r => r.crspMax).filter(v => v != null);
    const rangeValues = rows.map(r => r.tidalRange).filter(v => v != null);
    const crspWMax = Math.max(...crspMaxes), crspWMin = Math.min(...crspMaxes);
    const rangeMax = Math.max(...rangeValues), rangeMin = Math.min(...rangeValues);

    // 2) 바다타임 스크래핑
    console.log('2단계: 바다타임 스크래핑...');
    const browser = await chromium.launch({ headless: true });

    // 134 = 모항항(보령 인근), 127 = 보령
    const badatime134 = await scrapeBadatime(browser, '134');
    const badatime127 = await scrapeBadatime(browser, '127');
    await browser.close();

    console.log(`  모항항(134): ${Object.keys(badatime134).length}일`);
    console.log(`  보령(127): ${Object.keys(badatime127).length}일\n`);

    // 바다타임 값 매핑 (날짜 → pct)
    for (const r of rows) {
        const b134 = badatime134[r.day];
        const b127 = badatime127[r.day];
        r.bada134 = b134 ? b134.pct : null;
        r.bada127 = b127 ? b127.pct : null;
        r.badaMul = b134 ? b134.mulddae : (b127 ? b127.mulddae : null);
    }

    // 3) 비교 테이블
    const fmt = (v) => v != null ? String(v).padStart(3) + '%' : '  - ';
    const diff = (a, b) => (a != null && b != null) ? ((a - b >= 0 ? '+' : '') + String(a - b)).padStart(4) : '   -';

    console.log('='.repeat(150));
    console.log('날짜     | 물때  | crsp  | 조차  | ①crsp비율 | ②crspMM | ③crsp순위 | ④조차비율 | ⑤조차MM | ⑥조차순위 | 바다134 | 바다127 | ⑤-134 | ①-134');
    console.log('-'.repeat(150));

    for (const r of rows) {
        const c1 = maxRatio(r.crspMax, crspWMax);
        const c2 = minMaxNorm(r.crspMax, crspWMin, crspWMax);
        const c3 = percentileRank(r.crspMax, crspMaxes);
        const r1 = maxRatio(r.tidalRange, rangeMax);
        const r2 = minMaxNorm(r.tidalRange, rangeMin, rangeMax);
        const r3 = percentileRank(r.tidalRange, rangeValues);

        console.log(
            `${String(r.month).padStart(2)}/${String(r.day).padStart(2)} ${r.str} | ` +
            `${(r.badaMul || '?').padEnd(4)} | ` +
            `${r.crspMax != null ? r.crspMax.toFixed(0).padStart(4) : ' N/A'} | ` +
            `${r.tidalRange != null ? r.tidalRange.toFixed(0).padStart(4) : ' N/A'} | ` +
            `${fmt(c1)}      | ${fmt(c2)}    | ${fmt(c3)}      | ` +
            `${fmt(r1)}      | ${fmt(r2)}    | ${fmt(r3)}      | ` +
            `${fmt(r.bada134)}    | ${fmt(r.bada127)}    | ` +
            `${diff(r2, r.bada134)}  | ${diff(c1, r.bada134)}`
        );
    }
    console.log('='.repeat(150));

    // 4) MAE 분석
    console.log('\n=== 바다타임(모항134) 대비 평균 절대 오차 (MAE) ===\n');

    const methods = {
        '① crsp 비율  (todayMax/wMax)         ': (r) => maxRatio(r.crspMax, crspWMax),
        '② crsp MinMax ((v-min)/(max-min))    ': (r) => minMaxNorm(r.crspMax, crspWMin, crspWMax),
        '③ crsp 순위   (percentile rank)       ': (r) => percentileRank(r.crspMax, crspMaxes),
        '④ 조차 비율   (diff/maxDiff)  [현재공식]': (r) => maxRatio(r.tidalRange, rangeMax),
        '⑤ 조차 MinMax ((d-min)/(max-min))    ': (r) => minMaxNorm(r.tidalRange, rangeMin, rangeMax),
        '⑥ 조차 순위   (percentile rank)       ': (r) => percentileRank(r.tidalRange, rangeValues),
    };

    for (const [name, fn] of Object.entries(methods)) {
        let totalErr = 0, maxErr = 0, count = 0;
        for (const r of rows) {
            const bada = r.bada134;
            const calc = fn(r);
            if (bada != null && calc != null) {
                const err = Math.abs(calc - bada);
                totalErr += err;
                maxErr = Math.max(maxErr, err);
                count++;
            }
        }
        const mae = count > 0 ? (totalErr / count).toFixed(1) : 'N/A';
        const marker = name.includes('현재공식') ? ' ◀ 현재' : '';
        const best = mae !== 'N/A' && parseFloat(mae) < 5 ? ' ★ BEST' : '';
        console.log(`  ${name} MAE=${String(mae).padStart(5)}, MaxErr=${String(maxErr).padStart(2)}, n=${count}${marker}${best}`);
    }

    // 5) 동적 범위
    console.log('\n=== 동적 범위 비교 ===');
    console.log(`  crsp: [${crspWMin.toFixed(0)} ~ ${crspWMax.toFixed(0)}], 최약/최강 = ${(crspWMin/crspWMax*100).toFixed(0)}%, 변동폭 = ${(100 - crspWMin/crspWMax*100).toFixed(0)}%p`);
    console.log(`  조차: [${rangeMin.toFixed(0)} ~ ${rangeMax.toFixed(0)}], 최약/최강 = ${(rangeMin/rangeMax*100).toFixed(0)}%, 변동폭 = ${(100 - rangeMin/rangeMax*100).toFixed(0)}%p`);
}

main().catch(e => { console.error(e); process.exit(1); });
