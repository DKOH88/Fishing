/**
 * 심층 분석 v4: 유속% 공식 vs 바다타임 — 2025년 10~11월 대산 데이터
 * 사용자가 제공한 실제 비교 데이터를 기준으로 다양한 공식의 MAE를 측정
 */
const { chromium } = require('playwright');
const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';
const TIDE_STATION = 'DT_0017';  // 대산

// 사용자가 제공한 비교 데이터
const USER_DATA = [
    { date: '20251013', mulddae: '13물', ourPct: 38, badaPct: 53, diff: 486 },
    { date: '20251014', mulddae: '조금', ourPct: 17, badaPct: 34, diff: 352 },
    { date: '20251015', mulddae: '무시', ourPct: 4,  badaPct: 24, diff: 265 },
    { date: '20251016', mulddae: '1물',  ourPct: 1,  badaPct: 26, diff: 249 },
    { date: '20251017', mulddae: '2물',  ourPct: 20, badaPct: 36, diff: 366 },
    { date: '20251028', mulddae: '조금', ourPct: 29, badaPct: 43, diff: 427 },
    { date: '20251029', mulddae: '무시', ourPct: 15, badaPct: 29, diff: 336 },
    { date: '20251031', mulddae: '2물',  ourPct: 0,  badaPct: 18, diff: 241 },
    { date: '20251103', mulddae: '5물',  ourPct: 56, badaPct: 47, diff: 585 },
];

// 고정 테이블
const FIXED_MAX = 750, FIXED_MIN = 150;

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

// ±N일 윈도우에서 조차 데이터 가져오기
async function fetchWindowDiffs(dateStr, windowDays = 15) {
    const center = new Date(dateStr.slice(0, 4), parseInt(dateStr.slice(4, 6)) - 1, parseInt(dateStr.slice(6, 8)));
    const diffs = [];

    for (let d = -windowDays; d <= windowDays; d++) {
        const dt = new Date(center);
        dt.setDate(dt.getDate() + d);
        const ds = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
        try {
            const data = await fetchJSON(`${API_BASE}/api/tide-hilo?obsCode=${TIDE_STATION}&reqDate=${ds}&numOfRows=50&pageNo=1`);
            const items = data?.body?.items?.item || [];
            const arr = Array.isArray(items) ? items : [items];
            const dayItems = arr.filter(i => (i.predcDt || '').replace(/[^0-9]/g, '').startsWith(ds));
            const highs = dayItems.filter(i => i.extrSe === '1' || i.extrSe === '3');
            const lows = dayItems.filter(i => i.extrSe === '2' || i.extrSe === '4');
            if (highs.length > 0 && lows.length > 0) {
                const maxH = Math.max(...highs.map(h => parseFloat(h.predcTdlvVl)));
                const minL = Math.min(...lows.map(l => parseFloat(l.predcTdlvVl)));
                diffs.push({ date: ds, diff: Math.round(maxH - minL) });
            }
        } catch (e) {}
    }
    return diffs;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function minMaxNorm(diff, min, max) {
    if (max <= min) return null;
    return Math.round(clamp(((diff - min) / (max - min)) * 100, 0, 100));
}
function maxRatio(diff, max) {
    if (max <= 0) return null;
    return Math.round(clamp((diff / max) * 100, 0, 100));
}

function calcMAE(predicted, actual) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < predicted.length; i++) {
        if (predicted[i] != null && actual[i] != null) {
            sum += Math.abs(predicted[i] - actual[i]);
            cnt++;
        }
    }
    return cnt > 0 ? (sum / cnt).toFixed(1) : 'N/A';
}

async function main() {
    console.log('=== 유속% 공식 심층 분석 v4 ===');
    console.log(`관측소: 대산(${TIDE_STATION}) / 고정 max=${FIXED_MAX}, min=${FIXED_MIN}`);
    console.log(`테스트 기간: 2025.10.13 ~ 2025.11.03 (${USER_DATA.length}일)\n`);

    // 1단계: 현재 MAE 확인
    const btArr = USER_DATA.map(d => d.badaPct);
    const ourArr = USER_DATA.map(d => d.ourPct);
    console.log(`현재 공식 (동적 MinMax) MAE = ${calcMAE(ourArr, btArr)}`);

    // 2단계: 고정 테이블 MinMax
    const fixedMinMax = USER_DATA.map(d => minMaxNorm(d.diff, FIXED_MIN, FIXED_MAX));
    console.log(`고정 테이블 MinMax(${FIXED_MIN}~${FIXED_MAX}) MAE = ${calcMAE(fixedMinMax, btArr)}`);

    // 3단계: 고정 테이블 MaxRatio
    const fixedRatio = USER_DATA.map(d => maxRatio(d.diff, FIXED_MAX));
    console.log(`고정 테이블 MaxRatio(/${FIXED_MAX}) MAE = ${calcMAE(fixedRatio, btArr)}`);

    // 4단계: ±15일 동적 윈도우 데이터 수집
    console.log('\n±15일 동적 윈도우 데이터 수집 중...');
    const windowResults = {};

    // 대표 날짜 3개로 윈도우 확인 (API 호출 최적화)
    const sampleDates = ['20251013', '20251028', '20251103'];
    for (const ds of sampleDates) {
        process.stdout.write(`  ${ds}: `);
        const diffs = await fetchWindowDiffs(ds, 15);
        if (diffs.length > 0) {
            const vals = diffs.map(d => d.diff);
            const wMin = Math.min(...vals);
            const wMax = Math.max(...vals);
            windowResults[ds] = { min: wMin, max: wMax, count: diffs.length };
            console.log(`${diffs.length}일 수집, range=[${wMin}~${wMax}]`);
        } else {
            console.log('데이터 없음 (2025년 과거 데이터 API 미지원?)');
        }
    }

    // 5단계: 다양한 고정 min/max 조합 최적화
    console.log('\n=== 고정 min/max 최적화 탐색 ===');
    let bestMAE = 999, bestMin = 0, bestMax = 0;

    for (let mn = 0; mn <= 300; mn += 10) {
        for (let mx = 500; mx <= 1200; mx += 10) {
            const pcts = USER_DATA.map(d => minMaxNorm(d.diff, mn, mx));
            const mae = parseFloat(calcMAE(pcts, btArr));
            if (mae < bestMAE) {
                bestMAE = mae;
                bestMin = mn;
                bestMax = mx;
            }
        }
    }
    console.log(`  최적 MinMax: min=${bestMin}, max=${bestMax}, MAE=${bestMAE}`);
    const optMinMax = USER_DATA.map(d => minMaxNorm(d.diff, bestMin, bestMax));

    // 최적 MaxRatio
    let bestRatioMAE = 999, bestRatioMax = 0;
    for (let mx = 500; mx <= 1500; mx += 10) {
        const pcts = USER_DATA.map(d => maxRatio(d.diff, mx));
        const mae = parseFloat(calcMAE(pcts, btArr));
        if (mae < bestRatioMAE) {
            bestRatioMAE = mae;
            bestRatioMax = mx;
        }
    }
    console.log(`  최적 MaxRatio: max=${bestRatioMax}, MAE=${bestRatioMAE}`);
    const optRatio = USER_DATA.map(d => maxRatio(d.diff, bestRatioMax));

    // 6단계: 하이브리드 — MinMax + floor
    console.log('\n=== 하이브리드 공식 탐색 ===');
    // pct = floor + (1 - floor/100) * MinMax
    let bestHybMAE = 999, bestFloor = 0, bestHybMin = 0, bestHybMax = 0;
    for (let floor = 0; floor <= 30; floor += 2) {
        for (let mn = 0; mn <= 300; mn += 20) {
            for (let mx = 500; mx <= 1200; mx += 20) {
                const pcts = USER_DATA.map(d => {
                    const raw = (d.diff - mn) / (mx - mn);
                    return Math.round(clamp(floor + (100 - floor) * raw, 0, 100));
                });
                const mae = parseFloat(calcMAE(pcts, btArr));
                if (mae < bestHybMAE) {
                    bestHybMAE = mae;
                    bestFloor = floor;
                    bestHybMin = mn;
                    bestHybMax = mx;
                }
            }
        }
    }
    console.log(`  최적 하이브리드: floor=${bestFloor}%, min=${bestHybMin}, max=${bestHybMax}, MAE=${bestHybMAE}`);
    const optHybrid = USER_DATA.map(d => {
        const raw = (d.diff - bestHybMin) / (bestHybMax - bestHybMin);
        return Math.round(clamp(bestFloor + (100 - bestFloor) * raw, 0, 100));
    });

    // 7단계: 결과 테이블
    console.log('\n' + '═'.repeat(95));
    console.log('날짜       │ 물때  │ 조차 │ 바다타임 │ 현재공식 │ 고정MinMax │ 최적MinMax │ 최적Ratio │ 하이브리드');
    console.log('─'.repeat(95));
    for (let i = 0; i < USER_DATA.length; i++) {
        const d = USER_DATA[i];
        const ds = `${d.date.slice(4, 6)}.${d.date.slice(6, 8)}`;
        console.log(
            `${ds}  │ ${d.mulddae.padEnd(4)} │ ${String(d.diff).padStart(4)} │ ` +
            `  ${String(d.badaPct).padStart(3)}%   │  ${String(d.ourPct).padStart(3)}%    │` +
            `   ${String(fixedMinMax[i]).padStart(3)}%    │   ${String(optMinMax[i]).padStart(3)}%    │` +
            `  ${String(optRatio[i]).padStart(3)}%    │   ${String(optHybrid[i]).padStart(3)}%`
        );
    }
    console.log('─'.repeat(95));
    console.log(
        `MAE       │      │      │ 기준     │  ${calcMAE(ourArr, btArr).padStart(4)}    │` +
        `   ${calcMAE(fixedMinMax, btArr).padStart(4)}    │   ${calcMAE(optMinMax, btArr).padStart(4)}    │` +
        `  ${calcMAE(optRatio, btArr).padStart(4)}    │   ${calcMAE(optHybrid, btArr).padStart(4)}`
    );
    console.log('═'.repeat(95));

    // 8단계: 바다타임 비단조성 분석
    console.log('\n=== 바다타임 비단조성 분석 ===');
    console.log('같은 물때인데 다른 %:');
    console.log('  조금: 352→34%, 427→43% (조차↑ → %↑ ✓)');
    console.log('  무시: 265→24%, 336→29% (조차↑ → %↑ ✓)');
    console.log('  2물:  366→36%, 241→18% (조차↓ → %↓ ✓)');
    console.log('');
    console.log('다른 물때 비교:');
    console.log('  10.15 무시 265→24% vs 10.16 1물 249→26% (조차↓인데 %↑ ✗)');
    console.log('  10.13 13물 486→53% vs 11.03 5물 585→47% (조차↑인데 %↓ ✗)');
    console.log('  → 바다타임이 순수 조차만 사용하지 않거나, 사이클별 normalization이 다를 수 있음');

    // 9단계: 바다타임 실제 스크래핑 (10월 데이터)
    console.log('\n=== 바다타임 10월 실제 스크래핑 ===');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        // 바다타임 보령(127) 2025년 10월
        await page.goto('https://www.badatime.com/145/2025-10', { timeout: 15000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);

        const badaData = await page.evaluate(() => {
            const text = document.body.innerText;
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            const results = {};
            for (let i = 0; i < lines.length; i++) {
                const dateMatch = lines[i].match(/^(\d{1,2})\s*\([월화수목금토일]\)/);
                if (dateMatch) {
                    const day = parseInt(dateMatch[1]);
                    let mulddae = null, pct = null;
                    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
                        const mulMatch = lines[j].match(/^(사리|조금|무시|\d{1,2}\s*물)$/);
                        if (mulMatch) mulddae = mulMatch[1].replace(/\s/g, '');
                        const pctMatch = lines[j].match(/^(\d{1,3})%$/);
                        if (pctMatch) pct = parseInt(pctMatch[1]);
                    }
                    if (pct != null) results[day] = { mulddae, pct };
                }
            }
            return results;
        });

        console.log('바다타임 10월 전체 데이터:');
        const sorted = Object.entries(badaData).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
        for (const [day, info] of sorted) {
            console.log(`  10.${String(day).padStart(2, '0')} ${(info.mulddae || '?').padEnd(4)} ${String(info.pct).padStart(3)}%`);
        }

        // 11월도
        const page2 = await browser.newPage();
        await page2.goto('https://www.badatime.com/145/2025-11', { timeout: 15000, waitUntil: 'domcontentloaded' });
        await page2.waitForTimeout(4000);
        const badaNov = await page2.evaluate(() => {
            const text = document.body.innerText;
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            const results = {};
            for (let i = 0; i < lines.length; i++) {
                const dateMatch = lines[i].match(/^(\d{1,2})\s*\([월화수목금토일]\)/);
                if (dateMatch) {
                    const day = parseInt(dateMatch[1]);
                    let mulddae = null, pct = null;
                    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
                        const mulMatch = lines[j].match(/^(사리|조금|무시|\d{1,2}\s*물)$/);
                        if (mulMatch) mulddae = mulMatch[1].replace(/\s/g, '');
                        const pctMatch = lines[j].match(/^(\d{1,3})%$/);
                        if (pctMatch) pct = parseInt(pctMatch[1]);
                    }
                    if (pct != null) results[day] = { mulddae, pct };
                }
            }
            return results;
        });
        console.log('\n바다타임 11월 초 데이터:');
        for (const [day, info] of Object.entries(badaNov).sort((a, b) => a - b)) {
            if (parseInt(day) <= 7) {
                console.log(`  11.${String(day).padStart(2, '0')} ${(info.mulddae || '?').padEnd(4)} ${String(info.pct).padStart(3)}%`);
            }
        }
        await page2.close();
        await page.close();
    } catch (e) {
        console.log('스크래핑 오류:', e.message);
    }
    await browser.close();

    console.log('\n=== 최종 권장 ===');
    console.log(`현재(동적 MinMax): MAE=${calcMAE(ourArr, btArr)}`);
    console.log(`최적 MinMax(${bestMin}~${bestMax}): MAE=${bestMAE}`);
    console.log(`최적 MaxRatio(/${bestRatioMax}): MAE=${bestRatioMAE}`);
    console.log(`하이브리드(floor=${bestFloor}%, ${bestHybMin}~${bestHybMax}): MAE=${bestHybMAE}`);
}

main().catch(e => console.error(e));
