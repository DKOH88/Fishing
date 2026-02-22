/**
 * 교차검증 v5: 대산(DT_0017) + 모항항(DT_0031) 두 관측소에서
 * 동시에 잘 작동하는 유속% 공식 찾기
 */
const { chromium } = require('playwright');
const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';

// ─── 대산 데이터 (사용자 제공, 2025.10~11) ───
const DAESAN_DATA = [
    { date: '20251013', mulddae: '13물', badaPct: 53, diff: 486 },
    { date: '20251014', mulddae: '조금', badaPct: 34, diff: 352 },
    { date: '20251015', mulddae: '무시', badaPct: 24, diff: 265 },
    { date: '20251016', mulddae: '1물',  badaPct: 26, diff: 249 },
    { date: '20251017', mulddae: '2물',  badaPct: 36, diff: 366 },
    { date: '20251028', mulddae: '조금', badaPct: 43, diff: 427 },
    { date: '20251029', mulddae: '무시', badaPct: 29, diff: 336 },
    { date: '20251031', mulddae: '2물',  badaPct: 18, diff: 241 },
    { date: '20251103', mulddae: '5물',  badaPct: 47, diff: 585 },
];

// ─── 관측소 설정 ───
const STATIONS = {
    daesan: { code: 'DT_0017', name: '대산', badatimeId: '145', fixedMax: 750, fixedMin: 150 },
    mohang: { code: 'DT_0031', name: '모항항', badatimeId: '134', fixedMax: 250, fixedMin: 55 },
};

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

// 조차 가져오기
async function getTidalRange(stationCode, dateStr) {
    try {
        const data = await fetchJSON(`${API_BASE}/api/tide-hilo?obsCode=${stationCode}&reqDate=${dateStr}&numOfRows=50&pageNo=1`);
        const items = data?.body?.items?.item || [];
        const arr = Array.isArray(items) ? items : [items];
        const dayItems = arr.filter(i => (i.predcDt || '').replace(/[^0-9]/g, '').startsWith(dateStr));
        const highs = dayItems.filter(i => i.extrSe === '1' || i.extrSe === '3');
        const lows = dayItems.filter(i => i.extrSe === '2' || i.extrSe === '4');
        if (highs.length === 0 || lows.length === 0) return null;
        const maxH = Math.max(...highs.map(h => parseFloat(h.predcTdlvVl)));
        const minL = Math.min(...lows.map(l => parseFloat(l.predcTdlvVl)));
        return Math.round(maxH - minL);
    } catch { return null; }
}

// ±N일 윈도우 조차 수집
async function fetchWindowDiffs(stationCode, dateStr, windowDays = 15) {
    const center = new Date(dateStr.slice(0, 4), parseInt(dateStr.slice(4, 6)) - 1, parseInt(dateStr.slice(6, 8)));
    const diffs = [];
    for (let d = -windowDays; d <= windowDays; d++) {
        const dt = new Date(center);
        dt.setDate(dt.getDate() + d);
        const ds = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
        const diff = await getTidalRange(stationCode, ds);
        if (diff != null) diffs.push(diff);
    }
    return diffs;
}

// 바다타임 스크래핑
async function scrapeBadatime(browser, stationId, yearMonth) {
    const page = await browser.newPage();
    try {
        const url = `https://www.badatime.com/${stationId}/${yearMonth}`;
        console.log(`  → ${url}`);
        await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(4000);
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
    } catch (e) {
        console.log(`  ✗ 스크래핑 실패: ${e.message}`);
        return {};
    } finally { await page.close(); }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function minMaxNorm(diff, min, max) {
    if (max <= min) return null;
    return Math.round(clamp(((diff - min) / (max - min)) * 100, 0, 100));
}

function calcMAE(predicted, actual) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < predicted.length; i++) {
        if (predicted[i] != null && actual[i] != null) {
            sum += Math.abs(predicted[i] - actual[i]);
            cnt++;
        }
    }
    return cnt > 0 ? +(sum / cnt).toFixed(1) : null;
}

async function main() {
    console.log('══════════════════════════════════════════');
    console.log('  교차검증 v5: 대산 + 모항항 유속% 최적화');
    console.log('══════════════════════════════════════════\n');

    const browser = await chromium.launch({ headless: true });

    // ═══════ 1. 모항항 바다타임 데이터 수집 ═══════
    console.log('▶ 모항항(134) 바다타임 2월 데이터 스크래핑...');
    const badaMohang = await scrapeBadatime(browser, '134', '2026-02');
    const mohangDays = Object.entries(badaMohang).sort((a, b) => a[0] - b[0]);
    console.log(`  ${mohangDays.length}일 수집\n`);

    // 모항항 API 조차 수집 (2026-02)
    console.log('▶ 모항항 API 조차 수집...');
    const mohangData = [];
    for (const [day, info] of mohangDays) {
        const dateStr = `202602${String(day).padStart(2, '0')}`;
        const diff = await getTidalRange('DT_0031', dateStr);
        if (diff != null && info.pct != null) {
            mohangData.push({ date: dateStr, mulddae: info.mulddae, badaPct: info.pct, diff });
        }
        process.stdout.write('.');
    }
    console.log(` ${mohangData.length}일 완료\n`);

    // ═══════ 2. 동적 윈도우 수집 ═══════
    console.log('▶ 동적 윈도우(±15일) 범위 확인...');

    // 대산 대표일
    const daesanWindow = await fetchWindowDiffs('DT_0017', '20251020', 15);
    const daesanWMin = Math.min(...daesanWindow);
    const daesanWMax = Math.max(...daesanWindow);
    console.log(`  대산: [${daesanWMin}~${daesanWMax}] (${daesanWindow.length}일)`);

    // 모항항 대표일
    const mohangWindow = await fetchWindowDiffs('DT_0031', '20260215', 15);
    const mohangWMin = Math.min(...mohangWindow);
    const mohangWMax = Math.max(...mohangWindow);
    console.log(`  모항항: [${mohangWMin}~${mohangWMax}] (${mohangWindow.length}일)\n`);

    // ═══════ 3. 공식별 MAE 계산 ═══════
    const formulas = [];

    // A) 현재: 동적 MinMax
    formulas.push({
        name: '① 동적 MinMax (현재)',
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, daesanWMin, daesanWMax)),
        mohang: mohangData.map(d => minMaxNorm(d.diff, mohangWMin, mohangWMax)),
    });

    // B) 고정 테이블 MinMax (현재값)
    formulas.push({
        name: '② 고정 MinMax (현재 테이블)',
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, 150, 750)),
        mohang: mohangData.map(d => minMaxNorm(d.diff, 55, 250)),
    });

    // C) 동적 윈도우인데 min을 확장: expanded_min = wMin - (wMax-wMin)*0.3
    const daesanExpMin = Math.round(daesanWMin - (daesanWMax - daesanWMin) * 0.5);
    const daesanExpMax = Math.round(daesanWMax + (daesanWMax - daesanWMin) * 0.1);
    const mohangExpMin = Math.round(mohangWMin - (mohangWMax - mohangWMin) * 0.5);
    const mohangExpMax = Math.round(mohangWMax + (mohangWMax - mohangWMin) * 0.1);
    formulas.push({
        name: `③ 동적 확장 (min-50%R, max+10%R)`,
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, daesanExpMin, daesanExpMax)),
        mohang: mohangData.map(d => minMaxNorm(d.diff, mohangExpMin, mohangExpMax)),
    });

    // D) 동적 min*0.3 / max*1.1
    formulas.push({
        name: '④ 동적 (min×0.3, max×1.1)',
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, Math.round(daesanWMin * 0.3), Math.round(daesanWMax * 1.1))),
        mohang: mohangData.map(d => minMaxNorm(d.diff, Math.round(mohangWMin * 0.3), Math.round(mohangWMax * 1.1))),
    });

    // E) 동적 min*0, max 그대로 (= MaxRatio with dynamic max)
    formulas.push({
        name: '⑤ 동적 MaxRatio (diff/wMax)',
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, 0, daesanWMax)),
        mohang: mohangData.map(d => minMaxNorm(d.diff, 0, mohangWMax)),
    });

    // F) 고정 min=0 + 고정 max (= MaxRatio with fixed max)
    formulas.push({
        name: '⑥ 고정 MaxRatio (diff/fixedMax)',
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, 0, 750)),
        mohang: mohangData.map(d => minMaxNorm(d.diff, 0, 250)),
    });

    // G) 하이브리드: min = min(fixedMin, wMin), max = max(fixedMax, wMax)
    formulas.push({
        name: '⑦ 하이브리드 min(고정,동적)',
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, Math.min(150, daesanWMin), Math.max(750, daesanWMax))),
        mohang: mohangData.map(d => minMaxNorm(d.diff, Math.min(55, mohangWMin), Math.max(250, mohangWMax))),
    });

    // H) 대산 최적 (60, 920) / 모항항도 최적 탐색
    let mohangBestMAE = 999, mohangBestMin = 0, mohangBestMax = 0;
    for (let mn = 0; mn <= 100; mn += 5) {
        for (let mx = 150; mx <= 500; mx += 5) {
            const pcts = mohangData.map(d => minMaxNorm(d.diff, mn, mx));
            const mae = calcMAE(pcts, mohangData.map(d => d.badaPct));
            if (mae != null && mae < mohangBestMAE) {
                mohangBestMAE = mae;
                mohangBestMin = mn;
                mohangBestMax = mx;
            }
        }
    }
    console.log(`  모항항 최적: min=${mohangBestMin}, max=${mohangBestMax}, MAE=${mohangBestMAE}`);
    formulas.push({
        name: `⑧ 관측소별 최적 (대산 60/920, 모항 ${mohangBestMin}/${mohangBestMax})`,
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, 60, 920)),
        mohang: mohangData.map(d => minMaxNorm(d.diff, mohangBestMin, mohangBestMax)),
    });

    // I) 동적 윈도우 + 고정 min 보정: min = fixedMin * 0.4
    formulas.push({
        name: '⑨ 동적max + 낮은고정min (fixedMin×0.4)',
        daesan: DAESAN_DATA.map(d => minMaxNorm(d.diff, Math.round(150 * 0.4), daesanWMax)),
        mohang: mohangData.map(d => minMaxNorm(d.diff, Math.round(55 * 0.4), mohangWMax)),
    });

    // ═══════ 4. 결과 테이블 ═══════
    const daesanBT = DAESAN_DATA.map(d => d.badaPct);
    const mohangBT = mohangData.map(d => d.badaPct);

    console.log('\n' + '═'.repeat(72));
    console.log(' 공식                                   │ 대산 MAE │ 모항 MAE │ 평균 MAE');
    console.log('─'.repeat(72));

    const results = [];
    for (const f of formulas) {
        const daesanMAE = calcMAE(f.daesan, daesanBT);
        const mohangMAE = calcMAE(f.mohang, mohangBT);
        const avg = daesanMAE != null && mohangMAE != null ? +((daesanMAE + mohangMAE) / 2).toFixed(1) : null;
        results.push({ name: f.name, daesanMAE, mohangMAE, avg });
        const d = daesanMAE != null ? String(daesanMAE).padStart(5) : '  N/A';
        const m = mohangMAE != null ? String(mohangMAE).padStart(5) : '  N/A';
        const a = avg != null ? String(avg).padStart(5) : '  N/A';
        console.log(` ${f.name.padEnd(40)}│ ${d}   │ ${m}   │ ${a}`);
    }
    console.log('═'.repeat(72));

    // 최적 찾기
    const sorted = results.filter(r => r.avg != null).sort((a, b) => a.avg - b.avg);
    console.log(`\n🥇 ${sorted[0].name} (평균 MAE=${sorted[0].avg})`);
    if (sorted[1]) console.log(`🥈 ${sorted[1].name} (평균 MAE=${sorted[1].avg})`);
    if (sorted[2]) console.log(`🥉 ${sorted[2].name} (평균 MAE=${sorted[2].avg})`);

    // ═══════ 5. 상세 비교 (1위 공식) ═══════
    const bestIdx = formulas.indexOf(formulas.find(f => f.name === sorted[0].name));
    if (bestIdx >= 0) {
        const best = formulas[bestIdx];
        console.log(`\n── 1위 공식 상세: ${best.name} ──`);
        console.log('\n[대산]');
        console.log('날짜     물때  조차  바다타임  공식값  오차');
        for (let i = 0; i < DAESAN_DATA.length; i++) {
            const d = DAESAN_DATA[i];
            const v = best.daesan[i];
            const err = v != null ? v - d.badaPct : '?';
            const errStr = err > 0 ? `+${err}` : `${err}`;
            console.log(`${d.date.slice(4,6)}.${d.date.slice(6,8)}  ${d.mulddae.padEnd(4)} ${String(d.diff).padStart(4)}   ${String(d.badaPct).padStart(3)}%    ${String(v).padStart(3)}%   ${errStr}`);
        }

        console.log('\n[모항항] (상위 10일)');
        console.log('날짜     물때  조차  바다타임  공식값  오차');
        for (let i = 0; i < Math.min(10, mohangData.length); i++) {
            const d = mohangData[i];
            const v = best.mohang[i];
            const err = v != null ? v - d.badaPct : '?';
            const errStr = err > 0 ? `+${err}` : `${err}`;
            console.log(`${d.date.slice(4,6)}.${d.date.slice(6,8)}  ${(d.mulddae||'?').padEnd(4)} ${String(d.diff).padStart(4)}   ${String(d.badaPct).padStart(3)}%    ${String(v).padStart(3)}%   ${errStr}`);
        }
    }

    await browser.close();
}

main().catch(e => console.error(e));
