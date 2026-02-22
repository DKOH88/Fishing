/**
 * 심층 분석 v3: 7가지 공식 vs 바다타임 MAE 비교
 * - ①~⑥ 기존 공식 + ⑦ dη/dt 조위 변화율 기반 (GPT 제안)
 * - 바다타임 모항항(134) + 보령(127)
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

// ⑦ 조위 변화율: 조위 예측 시계열에서 max |dη/dt| (cm/10min)
async function getMaxTideChangeRate(dateStr) {
    try {
        const data = await fetchJSON(`${API_BASE}/api/tide-time?obsCode=${TIDE_STATION}&reqDate=${dateStr}&numOfRows=200&pageNo=1`);
        const items = data?.body?.items?.item || [];
        const arr = Array.isArray(items) ? items : [items];
        const dayItems = arr.filter(i => (i.predcDt || '').replace(/[^0-9]/g, '').startsWith(dateStr));
        if (dayItems.length < 2) return null;

        let maxRate = 0;
        for (let i = 1; i < dayItems.length; i++) {
            const h1 = parseFloat(dayItems[i - 1].tdlvHgt);
            const h2 = parseFloat(dayItems[i].tdlvHgt);
            if (isNaN(h1) || isNaN(h2)) continue;
            const rate = Math.abs(h2 - h1); // cm per 10min
            if (rate > maxRate) maxRate = rate;
        }
        return maxRate > 0 ? maxRate : null;
    } catch { return null; }
}

// 바다타임 스크래핑
async function scrapeBadatime(browser, stationId) {
    const page = await browser.newPage();
    try {
        await page.goto(`https://www.badatime.com/${stationId}`, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        const data = await page.evaluate(() => {
            const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
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
        return data;
    } catch { return {}; }
    finally { await page.close(); }
}

function maxRatio(v, max) { return (v != null && max > 0) ? Math.round(Math.min(100, Math.max(0, v / max * 100))) : null; }
function minMaxNorm(v, min, max) { return (v != null && max > min) ? Math.round(Math.min(100, Math.max(0, (v - min) / (max - min) * 100))) : null; }
function percentileRank(v, arr) {
    if (v == null || !arr || arr.length === 0) return null;
    const s = [...arr].sort((a, b) => a - b);
    let below = 0;
    for (const x of s) { if (x < v) below++; }
    return Math.round(below / Math.max(1, s.length - 1) * 100);
}

async function main() {
    console.log('=== 7가지 공식 vs 바다타임 심층 분석 v3 ===');
    console.log(`조위: 보령(${TIDE_STATION}) / 조류: 천수만(${CURRENT_STATION})\n`);

    const dates = [];
    for (let i = 0; i < 30; i++) {
        const dt = new Date(2026, 1, 7 + i);
        dates.push({
            str: `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`,
            month: dt.getMonth() + 1, day: dt.getDate()
        });
    }

    console.log('1단계: API 데이터 수집 (crsp + 조차 + dη/dt)...');
    const rows = [];
    for (const d of dates) {
        const [crspMax, tidalRange, maxChangeRate] = await Promise.all([
            getDayCrspMax(d.str),
            getTidalRange(d.str),
            getMaxTideChangeRate(d.str)
        ]);
        rows.push({ ...d, crspMax, tidalRange, maxChangeRate });
        process.stdout.write('.');
    }
    console.log(' 완료!\n');

    // 윈도우 통계
    const crspArr = rows.map(r => r.crspMax).filter(v => v != null);
    const rangeArr = rows.map(r => r.tidalRange).filter(v => v != null);
    const rateArr = rows.map(r => r.maxChangeRate).filter(v => v != null);

    const crspMax = Math.max(...crspArr), crspMin = Math.min(...crspArr);
    const rMax = Math.max(...rangeArr), rMin = Math.min(...rangeArr);
    const drMax = Math.max(...rateArr), drMin = Math.min(...rateArr);

    console.log(`  crsp:  [${crspMin.toFixed(0)} ~ ${crspMax.toFixed(0)}], 최약/최강=${(crspMin/crspMax*100).toFixed(0)}%`);
    console.log(`  조차:  [${rMin.toFixed(0)} ~ ${rMax.toFixed(0)}], 최약/최강=${(rMin/rMax*100).toFixed(0)}%`);
    console.log(`  dη/dt: [${drMin.toFixed(1)} ~ ${drMax.toFixed(1)}] cm/10min, 최약/최강=${(drMin/drMax*100).toFixed(0)}%`);

    // 바다타임
    console.log('\n2단계: 바다타임 스크래핑...');
    const browser = await chromium.launch({ headless: true });
    const bada134 = await scrapeBadatime(browser, '134');
    const bada127 = await scrapeBadatime(browser, '127');
    await browser.close();
    console.log(`  모항(134): ${Object.keys(bada134).length}일, 보령(127): ${Object.keys(bada127).length}일\n`);

    for (const r of rows) {
        r.bada134 = bada134[r.day]?.pct ?? null;
        r.bada127 = bada127[r.day]?.pct ?? null;
        r.badaMul = bada134[r.day]?.mulddae || bada127[r.day]?.mulddae || '?';
    }

    // 비교 테이블
    console.log('='.repeat(160));
    console.log('날짜     | 물때 |crsp | 조차 |dη/dt | ①crsp비 | ②crspMM | ④조차비 | ⑤조차MM | ⑦dη비율 | ⑧dηMM  | 바다134 | ⑤-134 | ⑧-134');
    console.log('-'.repeat(160));

    for (const r of rows) {
        const c1 = maxRatio(r.crspMax, crspMax);
        const c2 = minMaxNorm(r.crspMax, crspMin, crspMax);
        const r1 = maxRatio(r.tidalRange, rMax);
        const r2 = minMaxNorm(r.tidalRange, rMin, rMax);
        const d1 = maxRatio(r.maxChangeRate, drMax);      // ⑦ dη/dt 비율
        const d2 = minMaxNorm(r.maxChangeRate, drMin, drMax); // ⑧ dη/dt MinMax

        const f = (v) => v != null ? String(v).padStart(3) + '%' : '  - ';
        const df = (a, b) => (a != null && b != null) ? ((a - b >= 0 ? '+' : '') + String(a - b)).padStart(4) : '   -';

        console.log(
            `${String(r.month).padStart(2)}/${String(r.day).padStart(2)} ${r.str} | ` +
            `${r.badaMul.padEnd(3)} | ` +
            `${r.crspMax != null ? r.crspMax.toFixed(0).padStart(4) : ' N/A'} | ` +
            `${r.tidalRange != null ? r.tidalRange.toFixed(0).padStart(4) : ' N/A'} | ` +
            `${r.maxChangeRate != null ? r.maxChangeRate.toFixed(1).padStart(4) : ' N/A'} | ` +
            `${f(c1)}    | ${f(c2)}    | ${f(r1)}    | ${f(r2)}    | ${f(d1)}    | ${f(d2)}   | ` +
            `${f(r.bada134)}    | ${df(r2, r.bada134)}  | ${df(d2, r.bada134)}`
        );
    }
    console.log('='.repeat(160));

    // MAE
    console.log('\n=== 바다타임(모항134) 대비 MAE 순위 ===\n');
    const methods = [
        ['① crsp 비율  (v/max)               ', (r) => maxRatio(r.crspMax, crspMax)],
        ['② crsp MinMax ((v-min)/(max-min))  ', (r) => minMaxNorm(r.crspMax, crspMin, crspMax)],
        ['③ crsp 순위                          ', (r) => percentileRank(r.crspMax, crspArr)],
        ['④ 조차 비율  (d/max)    [현재 코드]  ', (r) => maxRatio(r.tidalRange, rMax)],
        ['⑤ 조차 MinMax ((d-min)/(max-min))  ', (r) => minMaxNorm(r.tidalRange, rMin, rMax)],
        ['⑥ 조차 순위                          ', (r) => percentileRank(r.tidalRange, rangeArr)],
        ['⑦ dη/dt 비율 (rate/max)  [GPT 3A]  ', (r) => maxRatio(r.maxChangeRate, drMax)],
        ['⑧ dη/dt MinMax ((r-min)/(max-min)) ', (r) => minMaxNorm(r.maxChangeRate, drMin, drMax)],
        ['⑨ dη/dt 순위                         ', (r) => percentileRank(r.maxChangeRate, rateArr)],
    ];

    const results = [];
    for (const [name, fn] of methods) {
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
        const mae = count > 0 ? totalErr / count : Infinity;
        results.push({ name, mae, maxErr, count });
    }

    results.sort((a, b) => a.mae - b.mae);
    results.forEach((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
        const curr = r.name.includes('현재') ? ' ◀ 현재' : '';
        const gpt = r.name.includes('GPT') ? ' ◀ GPT제안' : '';
        console.log(`  ${medal} ${r.name} MAE=${r.mae.toFixed(1).padStart(5)}, MaxErr=${String(r.maxErr).padStart(2)}, n=${r.count}${curr}${gpt}`);
    });

    // 보령(127) 대비 MAE도 추가
    console.log('\n=== 바다타임(보령127) 대비 MAE 순위 ===\n');
    const results127 = [];
    for (const [name, fn] of methods) {
        let totalErr = 0, maxErr = 0, count = 0;
        for (const r of rows) {
            const bada = r.bada127;
            const calc = fn(r);
            if (bada != null && calc != null) {
                const err = Math.abs(calc - bada);
                totalErr += err;
                maxErr = Math.max(maxErr, err);
                count++;
            }
        }
        const mae = count > 0 ? totalErr / count : Infinity;
        results127.push({ name, mae, maxErr, count });
    }

    results127.sort((a, b) => a.mae - b.mae);
    results127.forEach((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
        console.log(`  ${medal} ${r.name} MAE=${r.mae.toFixed(1).padStart(5)}, MaxErr=${String(r.maxErr).padStart(2)}, n=${r.count}`);
    });
}

main().catch(e => { console.error(e); process.exit(1); });
