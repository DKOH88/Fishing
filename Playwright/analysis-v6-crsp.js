/**
 * 분석 v6: crsp(조류유속) 연간max 정규화 vs 바다타임
 * 방법①: 유속% = todayMaxCrsp / 연간최강crsp × 100
 *
 * 대산항(07DS02) + 모항항(DT_0031→ nearest current station)
 */
const { chromium } = require('playwright');
const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';

// ─── 사용자 제공 대산 데이터 ───
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

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

// 특정 날짜의 최대 crsp (cm/s) 가져오기
async function getDayMaxCrsp(currentStation, dateStr) {
    try {
        const data = await fetchJSON(
            `${API_BASE}/api/current?obsCode=${currentStation}&reqDate=${dateStr}&numOfRows=300&pageNo=1&min=10`
        );
        const items = data?.body?.items?.item || [];
        const arr = Array.isArray(items) ? items : [items];
        const dayItems = arr.filter(i => (i.predcDt || '').replace(/[^0-9]/g, '').startsWith(dateStr));
        const speeds = dayItems.map(i => parseFloat(i.crsp) || 0).filter(s => s > 0);
        return speeds.length > 0 ? Math.max(...speeds) : null;
    } catch { return null; }
}

// 특정 날짜의 조차 (cm) 가져오기
async function getTidalRange(tideStation, dateStr) {
    try {
        const data = await fetchJSON(
            `${API_BASE}/api/tide-hilo?obsCode=${tideStation}&reqDate=${dateStr}&numOfRows=50&pageNo=1`
        );
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

// N일간 연속 crsp max 수집 (연간max 추정용)
async function collectCrspRange(currentStation, centerDate, rangeDays) {
    const center = new Date(centerDate.slice(0, 4), parseInt(centerDate.slice(4, 6)) - 1, parseInt(centerDate.slice(6, 8)));
    const results = [];
    for (let d = -rangeDays; d <= rangeDays; d++) {
        const dt = new Date(center);
        dt.setDate(dt.getDate() + d);
        const ds = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
        const maxCrsp = await getDayMaxCrsp(currentStation, ds);
        if (maxCrsp != null) {
            results.push({ date: ds, maxCrsp });
        }
    }
    return results;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
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

// 바다타임 스크래핑
async function scrapeBadatime(browser, stationId, yearMonth) {
    const page = await browser.newPage();
    try {
        await page.goto(`https://www.badatime.com/${stationId}/${yearMonth}`, { timeout: 15000, waitUntil: 'domcontentloaded' });
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
    } catch { return {}; }
    finally { await page.close(); }
}

async function main() {
    console.log('══════════════════════════════════════════════');
    console.log('  분석 v6: crsp 연간max 정규화 vs 바다타임');
    console.log('══════════════════════════════════════════════\n');

    // ═══════ 1단계: 대산항(07DS02) crsp 수집 ═══════
    const CURRENT_STATION = '07DS02';
    console.log(`▶ 대산항(${CURRENT_STATION}) crsp 수집...`);

    // 사용자 9일 crsp
    console.log('  9일 crsp 수집:');
    for (const d of DAESAN_DATA) {
        d.maxCrsp = await getDayMaxCrsp(CURRENT_STATION, d.date);
        const crspStr = d.maxCrsp != null ? d.maxCrsp.toFixed(1) : 'N/A';
        console.log(`    ${d.date} ${d.mulddae.padEnd(4)} crsp=${crspStr} cm/s, 조차=${d.diff}`);
    }

    // ═══════ 2단계: 연간max 추정 (±45일 사리 포함) ═══════
    console.log('\n  ±45일 윈도우에서 연간max 추정...');
    const longRange = await collectCrspRange(CURRENT_STATION, '20251020', 45);
    const allCrsps = longRange.map(r => r.maxCrsp);
    const annualMax = Math.max(...allCrsps);
    const annualMin = Math.min(...allCrsps);
    console.log(`  수집: ${longRange.length}일, crsp범위=[${annualMin.toFixed(1)}~${annualMax.toFixed(1)}] cm/s`);

    // 사리 날짜 근처 최강값 확인
    const top5 = longRange.sort((a, b) => b.maxCrsp - a.maxCrsp).slice(0, 5);
    console.log(`  Top 5 crsp:`);
    for (const t of top5) {
        console.log(`    ${t.date}: ${t.maxCrsp.toFixed(1)} cm/s`);
    }

    // ═══════ 3단계: 다양한 공식 비교 ═══════
    const btArr = DAESAN_DATA.map(d => d.badaPct);
    console.log('\n══════════════════════════════════════════════');
    console.log(' 공식 비교 (대산 9일)');
    console.log('──────────────────────────────────────────────');

    // A) crsp / annualMax (MaxRatio)
    const crspRatio = DAESAN_DATA.map(d =>
        d.maxCrsp != null ? Math.round(clamp(d.maxCrsp / annualMax * 100, 0, 100)) : null
    );
    console.log(`① crsp/연간max (MaxRatio)         MAE = ${calcMAE(crspRatio, btArr)}`);

    // B) crsp MinMax (annualMin ~ annualMax)
    const crspMinMax = DAESAN_DATA.map(d =>
        d.maxCrsp != null && annualMax > annualMin
            ? Math.round(clamp((d.maxCrsp - annualMin) / (annualMax - annualMin) * 100, 0, 100))
            : null
    );
    console.log(`② crsp MinMax (${annualMin.toFixed(0)}~${annualMax.toFixed(0)})   MAE = ${calcMAE(crspMinMax, btArr)}`);

    // C) crsp / annualMax * K (최적 K 탐색)
    let bestK = 1, bestKmae = 999;
    for (let k = 0.5; k <= 2.0; k += 0.01) {
        const pcts = DAESAN_DATA.map(d =>
            d.maxCrsp != null ? Math.round(clamp(d.maxCrsp / annualMax * k * 100, 0, 100)) : null
        );
        const mae = calcMAE(pcts, btArr);
        if (mae != null && mae < bestKmae) { bestKmae = mae; bestK = k; }
    }
    const crspOptK = DAESAN_DATA.map(d =>
        d.maxCrsp != null ? Math.round(clamp(d.maxCrsp / annualMax * bestK * 100, 0, 100)) : null
    );
    console.log(`③ crsp/연간max × ${bestK.toFixed(2)} (최적K)    MAE = ${bestKmae}`);

    // D) 조차 MinMax (현재 동적 윈도우) — 비교 기준
    // 대산 ±15일 범위: ~209~878 (v4 결과)
    const dynMin = 209, dynMax = 878;
    const rangeDynMinMax = DAESAN_DATA.map(d =>
        Math.round(clamp((d.diff - dynMin) / (dynMax - dynMin) * 100, 0, 100))
    );
    console.log(`④ 조차 동적 MinMax (현재)          MAE = ${calcMAE(rangeDynMinMax, btArr)}`);

    // E) 조차 최적 MinMax (v4 결과: 60~920)
    const rangeOptMinMax = DAESAN_DATA.map(d =>
        Math.round(clamp((d.diff - 60) / (920 - 60) * 100, 0, 100))
    );
    console.log(`⑤ 조차 최적 MinMax (60~920)        MAE = ${calcMAE(rangeOptMinMax, btArr)}`);

    // ═══════ 4단계: 상세 비교 테이블 ═══════
    console.log('\n' + '═'.repeat(100));
    console.log('날짜     │ 물때  │ crsp  │ 조차 │ 바다타임 │ ①crsp비율 │ ②crspMM │ ③crsp최적K │ ④조차동적 │ ⑤조차최적');
    console.log('─'.repeat(100));
    for (let i = 0; i < DAESAN_DATA.length; i++) {
        const d = DAESAN_DATA[i];
        const ds = `${d.date.slice(4, 6)}.${d.date.slice(6, 8)}`;
        const crsp = d.maxCrsp != null ? d.maxCrsp.toFixed(1).padStart(5) : '  N/A';
        console.log(
            `${ds}  │ ${d.mulddae.padEnd(4)} │ ${crsp} │ ${String(d.diff).padStart(4)} │  ` +
            `${String(d.badaPct).padStart(3)}%   │  ` +
            `${String(crspRatio[i] ?? 'N/A').padStart(3)}%    │  ` +
            `${String(crspMinMax[i] ?? 'N/A').padStart(3)}%  │   ` +
            `${String(crspOptK[i] ?? 'N/A').padStart(3)}%     │  ` +
            `${String(rangeDynMinMax[i]).padStart(3)}%    │  ` +
            `${String(rangeOptMinMax[i]).padStart(3)}%`
        );
    }
    console.log('─'.repeat(100));
    console.log(
        `MAE     │      │       │      │  기준   │  ` +
        `${String(calcMAE(crspRatio, btArr)).padStart(3)}     │  ` +
        `${String(calcMAE(crspMinMax, btArr)).padStart(3)}   │   ` +
        `${String(bestKmae).padStart(3)}      │  ` +
        `${String(calcMAE(rangeDynMinMax, btArr)).padStart(4)}    │  ` +
        `${String(calcMAE(rangeOptMinMax, btArr)).padStart(3)}`
    );
    console.log('═'.repeat(100));

    // ═══════ 5단계: 모항항 교차검증 ═══════
    console.log('\n▶ 모항항 교차검증...');
    const browser = await chromium.launch({ headless: true });

    // 모항항 바다타임 2월 데이터
    console.log('  바다타임(134) 2026-02 스크래핑...');
    const badaMohang = await scrapeBadatime(browser, '134', '2026-02');
    const mohangDays = Object.entries(badaMohang).sort((a, b) => a[0] - b[0]);
    console.log(`  ${mohangDays.length}일 수집`);

    // 모항항 조류 관측소 확인 (DT_0031 → 가까운 조류 예보소)
    // 모항항에는 전용 조류예보소가 없을 수 있음 → 조차 기반만 비교
    const MOHANG_TIDE = 'DT_0031';
    const MOHANG_CURRENT = '16LTC01'; // 모항항 근처 조류

    const mohangData = [];
    for (const [day, info] of mohangDays) {
        const dateStr = `202602${String(day).padStart(2, '0')}`;
        const [diff, maxCrsp] = await Promise.all([
            getTidalRange(MOHANG_TIDE, dateStr),
            getDayMaxCrsp(MOHANG_CURRENT, dateStr)
        ]);
        if (diff != null && info.pct != null) {
            mohangData.push({ date: dateStr, mulddae: info.mulddae, badaPct: info.pct, diff, maxCrsp });
        }
    }
    console.log(`  조차+crsp 수집: ${mohangData.length}일`);

    if (mohangData.length > 0) {
        // 모항항 ±15일 윈도우
        const mohangCrspRange = await collectCrspRange(MOHANG_CURRENT, '20260215', 15);
        const mohangAllCrsps = mohangCrspRange.map(r => r.maxCrsp);
        const mohangCrspMax = mohangAllCrsps.length > 0 ? Math.max(...mohangAllCrsps) : null;
        const mohangCrspMin = mohangAllCrsps.length > 0 ? Math.min(...mohangAllCrsps) : null;

        const mohangTideRange = [];
        for (const d of mohangData) { mohangTideRange.push(d.diff); }
        const mohangTideMax = Math.max(...mohangTideRange);
        const mohangTideMin = Math.min(...mohangTideRange);

        console.log(`  모항항 crsp: [${mohangCrspMin?.toFixed(1)}~${mohangCrspMax?.toFixed(1)}]`);
        console.log(`  모항항 조차: [${mohangTideMin}~${mohangTideMax}]`);

        const mohangBT = mohangData.map(d => d.badaPct);

        // 모항항 공식들
        const m_crspRatio = mohangData.map(d =>
            d.maxCrsp != null && mohangCrspMax ? Math.round(clamp(d.maxCrsp / mohangCrspMax * 100, 0, 100)) : null
        );
        const m_crspMinMax = mohangData.map(d =>
            d.maxCrsp != null && mohangCrspMax > mohangCrspMin
                ? Math.round(clamp((d.maxCrsp - mohangCrspMin) / (mohangCrspMax - mohangCrspMin) * 100, 0, 100))
                : null
        );
        const m_tideDynMinMax = mohangData.map(d =>
            Math.round(clamp((d.diff - mohangTideMin) / (mohangTideMax - mohangTideMin) * 100, 0, 100))
        );

        // 모항항 최적 조차 MinMax 탐색
        let mBestMin = 0, mBestMax = 250, mBestMAE = 999;
        for (let mn = 0; mn <= 100; mn += 5) {
            for (let mx = 150; mx <= 500; mx += 5) {
                const pcts = mohangData.map(d => Math.round(clamp((d.diff - mn) / (mx - mn) * 100, 0, 100)));
                const mae = calcMAE(pcts, mohangBT);
                if (mae != null && mae < mBestMAE) { mBestMAE = mae; mBestMin = mn; mBestMax = mx; }
            }
        }
        const m_tideOpt = mohangData.map(d =>
            Math.round(clamp((d.diff - mBestMin) / (mBestMax - mBestMin) * 100, 0, 100))
        );

        console.log('\n──── 모항항 MAE 비교 ────');
        console.log(`  ① crsp/연간max (MaxRatio):       ${calcMAE(m_crspRatio, mohangBT)}`);
        console.log(`  ② crsp MinMax:                   ${calcMAE(m_crspMinMax, mohangBT)}`);
        console.log(`  ④ 조차 동적 MinMax:              ${calcMAE(m_tideDynMinMax, mohangBT)}`);
        console.log(`  ⑤ 조차 최적 MinMax (${mBestMin}~${mBestMax}):  ${mBestMAE}`);

        // 모항항 상세 (상위 10일)
        console.log('\n[모항항 상세 - 상위 10일]');
        console.log('날짜   물때  crsp  조차 바다타임 crsp비율 crspMM 조차동적 조차최적');
        for (let i = 0; i < Math.min(10, mohangData.length); i++) {
            const d = mohangData[i];
            const ds = `${d.date.slice(4, 6)}.${d.date.slice(6, 8)}`;
            const crsp = d.maxCrsp != null ? d.maxCrsp.toFixed(1).padStart(5) : '  N/A';
            console.log(
                `${ds} ${(d.mulddae || '?').padEnd(4)} ${crsp} ${String(d.diff).padStart(4)}  ` +
                `${String(d.badaPct).padStart(3)}%    ` +
                `${String(m_crspRatio[i] ?? 'N/A').padStart(3)}%    ` +
                `${String(m_crspMinMax[i] ?? 'N/A').padStart(3)}%   ` +
                `${String(m_tideDynMinMax[i]).padStart(3)}%    ` +
                `${String(m_tideOpt[i]).padStart(3)}%`
            );
        }

        // ═══════ 6단계: 종합 순위 ═══════
        console.log('\n' + '═'.repeat(60));
        console.log('  종합 순위 (대산 + 모항항 평균 MAE)');
        console.log('─'.repeat(60));

        const daesanMAEs = {
            'crsp MaxRatio': calcMAE(crspRatio, btArr),
            'crsp MinMax': calcMAE(crspMinMax, btArr),
            [`crsp 최적K(×${bestK.toFixed(2)})`]: bestKmae,
            '조차 동적 MinMax': calcMAE(rangeDynMinMax, btArr),
            '조차 최적 MinMax': calcMAE(rangeOptMinMax, btArr),
        };
        const mohangMAEs = {
            'crsp MaxRatio': calcMAE(m_crspRatio, mohangBT),
            'crsp MinMax': calcMAE(m_crspMinMax, mohangBT),
            [`crsp 최적K(×${bestK.toFixed(2)})`]: null, // 모항 별도 K 미탐색
            '조차 동적 MinMax': calcMAE(m_tideDynMinMax, mohangBT),
            '조차 최적 MinMax': mBestMAE,
        };

        const combined = [];
        for (const [name, dMAE] of Object.entries(daesanMAEs)) {
            const mMAE = mohangMAEs[name];
            if (dMAE != null && mMAE != null) {
                combined.push({ name, dMAE, mMAE, avg: +((dMAE + mMAE) / 2).toFixed(1) });
            } else if (dMAE != null) {
                combined.push({ name, dMAE, mMAE: 'N/A', avg: dMAE });
            }
        }
        combined.sort((a, b) => (typeof a.avg === 'number' ? a.avg : 999) - (typeof b.avg === 'number' ? b.avg : 999));

        for (let i = 0; i < combined.length; i++) {
            const c = combined[i];
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
            console.log(`  ${medal} ${c.name.padEnd(25)} 대산=${String(c.dMAE).padStart(4)}  모항=${String(c.mMAE).padStart(4)}  평균=${String(c.avg).padStart(4)}`);
        }
        console.log('═'.repeat(60));
    }

    await browser.close();
}

main().catch(e => console.error(e));
