/**
 * 조차 MinMax 복원 후 검증: API 직접 호출로 동적 윈도우 포함 계산
 * 바다타임 값과 비교
 */
const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

// 고저조 → 조차
async function getTidalRange(stationCode, dateStr) {
    const data = await fetchJSON(`${API_BASE}/api/tide-hilo?obsCode=${stationCode}&reqDate=${dateStr}&numOfRows=50&pageNo=1`);
    const items = data?.body?.items?.item || [];
    const arr = Array.isArray(items) ? items : [items];
    const day = arr.filter(i => (i.predcDt || '').replace(/[^0-9]/g, '').startsWith(dateStr));
    const highs = day.filter(i => i.extrSe === '1' || i.extrSe === '3');
    const lows = day.filter(i => i.extrSe === '2' || i.extrSe === '4');
    if (!highs.length || !lows.length) return null;
    return Math.max(...highs.map(h => parseFloat(h.predcTdlvVl))) - Math.min(...lows.map(l => parseFloat(l.predcTdlvVl)));
}

// ±15일 윈도우
async function getWindowRange(stationCode, dateStr) {
    const ranges = [];
    const base = new Date(dateStr.slice(0,4), dateStr.slice(4,6)-1, dateStr.slice(6,8));
    for (let d = -15; d <= 15; d++) {
        const dt = new Date(base); dt.setDate(dt.getDate() + d);
        const ds = `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;
        const r = await getTidalRange(stationCode, ds);
        if (r != null) ranges.push(r);
    }
    return { min: Math.min(...ranges), max: Math.max(...ranges), count: ranges.length };
}

function calcMinMax(diff, min, max) {
    if (max <= min || diff == null) return null;
    return Math.round(Math.min(100, Math.max(0, ((diff - min) / (max - min)) * 100)));
}

async function main() {
    const station = 'DT_0025'; // 보령
    console.log('=== 조차 MinMax 복원 검증 (보령) ===\n');

    // 바다타임 값 (분석 v3에서 스크래핑)
    const badatime = {
        '20260222': { mul: '12물', pct: 83 },
        '20260223': { mul: '13물', pct: 76 },
        '20260224': { mul: '조금', pct: 63 },
        '20260225': { mul: '무시', pct: 44 },
        '20260226': { mul: '1물', pct: 28 },
        '20260227': { mul: '2물', pct: 27 },
        '20260228': { mul: '3물', pct: 44 },
        '20260301': { mul: '4물', pct: 66 },
        '20260302': { mul: '5물', pct: 85 },
        '20260303': { mul: '6물', pct: 95 },
        '20260304': { mul: '7물', pct: 99 },
        '20260305': { mul: '8물', pct: 96 },
        '20260306': { mul: '9물', pct: 88 },
        '20260307': { mul: '10물', pct: 84 },
        '20260308': { mul: '11물', pct: 76 },
    };

    const dates = Object.keys(badatime);

    // 중앙 날짜 윈도우
    console.log('±15일 동적 윈도우 계산 중...');
    const win = await getWindowRange(station, '20260228');
    console.log(`  윈도우: [${win.min.toFixed(0)} ~ ${win.max.toFixed(0)}], ${win.count}일\n`);

    console.log('날짜     | 물때 | 조차  | MinMax% | 바다타임 | 오차');
    console.log('-'.repeat(60));

    let totalErr = 0, count = 0;
    for (const ds of dates) {
        const diff = await getTidalRange(station, ds);
        const pct = calcMinMax(diff, win.min, win.max);
        const bada = badatime[ds];
        const err = (pct != null && bada) ? pct - bada.pct : null;
        if (err != null) { totalErr += Math.abs(err); count++; }

        console.log(
            `${ds.slice(4,6)}/${ds.slice(6,8)} ${ds} | ${bada.mul.padEnd(3)} | ` +
            `${diff != null ? diff.toFixed(0).padStart(4) : ' N/A'} | ` +
            `${pct != null ? (pct + '%').padStart(4) : ' N/A'} | ` +
            `${(bada.pct + '%').padStart(4)} | ` +
            `${err != null ? (err >= 0 ? '+' : '') + err : ' -'}`
        );
    }

    console.log('-'.repeat(60));
    console.log(`MAE = ${(totalErr / count).toFixed(1)} (n=${count})\n`);
    console.log(count > 0 && totalErr / count < 6 ? '✅ 바다타임과 근접!' : '⚠️ 오차가 큰 편');
}

main().catch(e => { console.error(e); process.exit(1); });
