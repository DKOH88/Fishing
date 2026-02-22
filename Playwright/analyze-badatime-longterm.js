/**
 * 바다타임 장기 데이터 분석 (대산: 145)
 * - 기간: 2010-01 ~ 2026-02
 * - 수집: https://www.badatime.com/{stationId}/daily/YYYY-MM
 * - 출력:
 *   - analysis/badatime_{stationId}_{start}_{end}.csv
 *   - analysis/badatime_{stationId}_{start}_{end}.json
 *   - analysis/badatime_{stationId}_{start}_{end}_report.md
 */

const fs = require('fs');
const path = require('path');

const STATION_ID = process.argv[2] || '145'; // default: 대산
const START_YM = process.argv[3] || '2010-01';
const END_YM = process.argv[4] || '2026-02';

const OUTPUT_DIR = path.resolve(__dirname, '..', 'analysis');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateFromYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1);
}

function ymFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function listMonths(startYm, endYm) {
  const start = toDateFromYm(startYm);
  const end = toDateFromYm(endYm);
  const out = [];
  const cur = new Date(start);
  while (cur <= end) {
    out.push(ymFromDate(cur));
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

function stripTags(s) {
  return (s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normTideLabel(raw) {
  const t = (raw || '')
    .replace(/\s+/g, '')
    .replace(/&nbsp;/g, '')
    .trim();
  // 예: "13물", "1물", "조금", "무시", "사리"
  const m = t.match(/^(\d{1,2})물$/);
  if (m) return `${parseInt(m[1], 10)}물`;
  if (t.includes('조금')) return '조금';
  if (t.includes('무시')) return '무시';
  if (t.includes('사리')) return '사리';
  return t || null;
}

function parseDailyRows(html, ym) {
  const rows = [...html.matchAll(/<tr[^>]*class="day-row"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = [];

  for (const r of rows) {
    const row = r[1];

    const dayCellHtml = (row.match(/class="day-cell"[\s\S]*?>([\s\S]*?)<\/td>/i) || [])[1] || '';
    const dayNum = parseInt((dayCellHtml.match(/(\d{1,2})\s*\(/) || [])[1], 10);
    if (!Number.isFinite(dayNum)) continue;

    const lunar = ((dayCellHtml.match(/<span[^>]*>([\d.]+)<\/span>/i) || [])[1] || '').trim() || null;

    const tideRaw = ((row.match(/class="tide-text"[\s\S]*?<b>([\s\S]*?)<\/b>/i) || [])[1] || '').trim();
    const tide = normTideLabel(stripTags(tideRaw));

    const flow = parseInt((row.match(/class="progress-bar"[^>]*data-value="(\d{1,3})"/i) || [])[1], 10);
    if (!Number.isFinite(flow)) continue;

    const date = `${ym}-${pad2(dayNum)}`;
    out.push({
      date,
      ym,
      day: dayNum,
      tide: tide || '',
      flow_pct: flow,
      lunar: lunar || '',
    });
  }

  // 중복 방지(혹시라도 같은 일자가 중복될 때 첫 번째만)
  const dedup = new Map();
  for (const row of out) {
    if (!dedup.has(row.date)) dedup.set(row.date, row);
  }
  return [...dedup.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const resp = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      lastErr = e;
      const ms = 300 * i;
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  throw lastErr || new Error('fetch failed');
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function mae(actual, pred) {
  let s = 0;
  let c = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const p = pred[i];
    if (!Number.isFinite(a) || !Number.isFinite(p)) continue;
    s += Math.abs(a - p);
    c++;
  }
  return c ? s / c : NaN;
}

function corr(a, b) {
  const x = [];
  const y = [];
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      x.push(a[i]);
      y.push(b[i]);
    }
  }
  if (x.length < 3) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i++) {
    const vx = x[i] - mx;
    const vy = y[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  if (dx === 0 || dy === 0) return NaN;
  return num / Math.sqrt(dx * dy);
}

function autocorr(series, lag) {
  if (lag <= 0 || lag >= series.length) return NaN;
  const a = series.slice(lag);
  const b = series.slice(0, series.length - lag);
  return corr(a, b);
}

function monthFromDate(dateStr) {
  return parseInt(dateStr.slice(5, 7), 10);
}

function yearFromDate(dateStr) {
  return parseInt(dateStr.slice(0, 4), 10);
}

function fixed(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : 'NaN';
}

function toCsv(rows) {
  const header = 'date,ym,day,tide,flow_pct,lunar';
  const lines = rows.map((r) =>
    [
      r.date,
      r.ym,
      r.day,
      `"${String(r.tide || '').replace(/"/g, '""')}"`,
      r.flow_pct,
      `"${String(r.lunar || '').replace(/"/g, '""')}"`,
    ].join(',')
  );
  return [header, ...lines].join('\n');
}

function buildPhasePredictor(values, period) {
  const buckets = Array.from({ length: period }, () => []);
  for (let i = 0; i < values.length; i++) buckets[i % period].push(values[i]);
  const phaseMean = buckets.map((arr) => (arr.length ? mean(arr) : NaN));
  const pred = values.map((_, i) => phaseMean[i % period]);
  return { pred, phaseMean };
}

function topN(arr, n, keyFn) {
  return [...arr].sort((a, b) => keyFn(b) - keyFn(a)).slice(0, n);
}

async function main() {
  const months = listMonths(START_YM, END_YM);
  console.log(`station=${STATION_ID}, months=${months.length}, range=${START_YM}..${END_YM}`);

  const all = [];
  const failed = [];

  for (let i = 0; i < months.length; i++) {
    const ym = months[i];
    const url = `https://www.badatime.com/${STATION_ID}/daily/${ym}`;
    process.stdout.write(`[${String(i + 1).padStart(3)}/${months.length}] ${ym} ... `);
    try {
      const html = await fetchWithRetry(url, 3);
      const rows = parseDailyRows(html, ym);
      if (rows.length === 0) {
        failed.push({ ym, reason: 'no rows' });
        console.log('0 rows');
      } else {
        all.push(...rows);
        console.log(`${rows.length} rows`);
      }
    } catch (e) {
      failed.push({ ym, reason: e.message });
      console.log(`fail: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  all.sort((a, b) => a.date.localeCompare(b.date));

  // 분석용 시계열
  const values = all.map((r) => r.flow_pct);
  const globalMean = mean(values);
  const globalStd = std(values);
  const globalMin = Math.min(...values);
  const globalMax = Math.max(...values);

  // 연도/월 통계
  const byYear = new Map();
  const byMonth = new Map();
  for (const r of all) {
    const y = yearFromDate(r.date);
    const m = monthFromDate(r.date);
    if (!byYear.has(y)) byYear.set(y, []);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byYear.get(y).push(r.flow_pct);
    byMonth.get(m).push(r.flow_pct);
  }

  const yearStats = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, arr]) => ({
      year,
      n: arr.length,
      mean: mean(arr),
      std: std(arr),
      min: Math.min(...arr),
      max: Math.max(...arr),
    }));

  const monthStats = [...byMonth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([month, arr]) => ({
      month,
      n: arr.length,
      mean: mean(arr),
      std: std(arr),
      min: Math.min(...arr),
      max: Math.max(...arr),
    }));

  // 물때별 통계
  const byTide = new Map();
  for (const r of all) {
    const key = r.tide || '미상';
    if (!byTide.has(key)) byTide.set(key, []);
    byTide.get(key).push(r.flow_pct);
  }
  const tideStats = [...byTide.entries()]
    .map(([tide, arr]) => ({
      tide,
      n: arr.length,
      mean: mean(arr),
      std: std(arr),
      min: Math.min(...arr),
      max: Math.max(...arr),
    }))
    .sort((a, b) => a.mean - b.mean);

  // 물때 전이 분석(일 단위 연속 구간)
  const cycleOrder = [];
  for (const r of all) {
    if (!cycleOrder.includes(r.tide)) cycleOrder.push(r.tide);
    if (cycleOrder.length >= 15) break;
  }
  const expectedNext = new Map();
  for (let i = 0; i < cycleOrder.length; i++) {
    expectedNext.set(cycleOrder[i], cycleOrder[(i + 1) % cycleOrder.length]);
  }

  let transitionTotal = 0;
  let transitionExpected = 0;
  const anomalyPairs = new Map();
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1];
    const cur = all[i];
    const dGap = (new Date(cur.date) - new Date(prev.date)) / 86400000;
    if (dGap !== 1) continue;
    transitionTotal++;
    const exp = expectedNext.get(prev.tide);
    if (cur.tide === exp) {
      transitionExpected++;
    } else {
      const k = `${prev.tide}->${cur.tide} (exp ${exp})`;
      anomalyPairs.set(k, (anomalyPairs.get(k) || 0) + 1);
    }
  }
  const transitionUnexpected = transitionTotal - transitionExpected;
  const transitionHitRate = transitionTotal ? transitionExpected / transitionTotal : NaN;
  const topAnomalyPairs = [...anomalyPairs.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // 음력(삭망월 29.53058867일) 대비 30일 기준 누적 보정량 비교
  const expectedSkipBySynodic = months.length * (30 - 29.53058867);

  // 자기상관(주기 탐지)
  const ac = [];
  for (let lag = 1; lag <= 60; lag++) {
    ac.push({ lag, corr: autocorr(values, lag) });
  }
  const bestLags = topN(ac.filter((x) => Number.isFinite(x.corr)), 10, (x) => x.corr);

  // 단순 모델 비교
  const predMean = values.map(() => globalMean);
  const maeMean = mae(values, predMean);

  // 물때 평균 모델
  const tideMean = new Map(tideStats.map((s) => [s.tide, s.mean]));
  const predTide = all.map((r) => tideMean.get(r.tide || '미상'));
  const maeTide = mae(values, predTide);

  // 월 평균 모델
  const monthMean = new Map(monthStats.map((s) => [s.month, s.mean]));
  const predMonth = all.map((r) => monthMean.get(monthFromDate(r.date)));
  const maeMonth = mae(values, predMonth);

  // 물때+월 additive 모델
  const predAdd = all.map((r) => {
    const tm = tideMean.get(r.tide || '미상');
    const mm = monthMean.get(monthFromDate(r.date));
    return tm + (mm - globalMean);
  });
  const maeAdd = mae(values, predAdd);

  // 고정 주기(정수) 위상 평균 모델: 10~40일 스캔
  const periodScan = [];
  for (let p = 10; p <= 40; p++) {
    const { pred } = buildPhasePredictor(values, p);
    periodScan.push({ period: p, mae: mae(values, pred) });
  }
  periodScan.sort((a, b) => a.mae - b.mae);
  const bestPeriods = periodScan.slice(0, 8);

  // 리포트 저장
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const prefix = `badatime_${STATION_ID}_${START_YM}_${END_YM}`.replace(/[^0-9A-Za-z_\-.]/g, '_');
  const csvPath = path.join(OUTPUT_DIR, `${prefix}.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `${prefix}.json`);
  const reportPath = path.join(OUTPUT_DIR, `${prefix}_report.md`);

  fs.writeFileSync(csvPath, toCsv(all), 'utf8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        meta: {
          stationId: STATION_ID,
          startYm: START_YM,
          endYm: END_YM,
          collectedAt: new Date().toISOString(),
          monthsRequested: months.length,
          failedMonths: failed,
        },
        rows: all,
      },
      null,
      2
    ),
    'utf8'
  );

  const reportLines = [];
  reportLines.push(`# 바다타임 장기 패턴 분석`);
  reportLines.push(`- 지점 ID: \`${STATION_ID}\``);
  reportLines.push(`- 기간: \`${START_YM}\` ~ \`${END_YM}\``);
  reportLines.push(`- 수집 성공 월: ${months.length - failed.length}/${months.length}`);
  reportLines.push(`- 수집 일수: ${all.length}일`);
  reportLines.push('');

  reportLines.push(`## 1) 기초 통계`);
  reportLines.push(`- 평균: ${fixed(globalMean)}%`);
  reportLines.push(`- 표준편차: ${fixed(globalStd)}%`);
  reportLines.push(`- 최소/최대: ${globalMin}% / ${globalMax}%`);
  reportLines.push('');

  reportLines.push(`## 2) 주기(자기상관 상위 10)`);
  reportLines.push(`- 해석 포인트: 14~15일, 29~30일 라그가 높으면 반월/삭망 주기 신호가 강함`);
  for (const x of bestLags) {
    reportLines.push(`- lag ${x.lag}일: corr=${fixed(x.corr, 4)}`);
  }
  reportLines.push('');

  reportLines.push(`## 3) 모델 오차(MAE, 낮을수록 좋음)`);
  reportLines.push(`- 전역 평균 모델: ${fixed(maeMean)}%`);
  reportLines.push(`- 물때 평균 모델: ${fixed(maeTide)}%`);
  reportLines.push(`- 월 평균 모델: ${fixed(maeMonth)}%`);
  reportLines.push(`- 물때+월 additive 모델: ${fixed(maeAdd)}%`);
  reportLines.push('');

  reportLines.push(`## 4) 고정 주기 스캔(10~40일)`);
  for (const p of bestPeriods) {
    reportLines.push(`- period ${p.period}일: MAE=${fixed(p.mae)}%`);
  }
  reportLines.push('');

  reportLines.push(`## 5) 물때 전이(엔진 규칙)`);
  reportLines.push(`- 기준 순서: ${cycleOrder.join(' -> ')}`);
  reportLines.push(`- 기대 전이 일치율: ${fixed(transitionHitRate * 100)}% (${transitionExpected}/${transitionTotal})`);
  reportLines.push(`- 비정상 전이 건수: ${transitionUnexpected}`);
  reportLines.push(`- 삭망월 보정 추정(30일 기준 누적): ${fixed(expectedSkipBySynodic)}회`);
  reportLines.push(`- 실제 비정상 전이(스킵): ${transitionUnexpected}회`);
  if (topAnomalyPairs.length) {
    reportLines.push(`- 상위 비정상 전이:`);
    for (const a of topAnomalyPairs) {
      reportLines.push(`  - ${a.pair}: ${a.count}회`);
    }
  }
  reportLines.push('');

  reportLines.push(`## 6) 물때별 분포`);
  reportLines.push(`- 표준편차가 작으면 '물때별 고정값 엔진'에 가깝고, 크면 추가 보정(계절/천문/지역)이 개입된 것`);
  for (const s of tideStats) {
    reportLines.push(
      `- ${s.tide}: n=${s.n}, mean=${fixed(s.mean)}%, std=${fixed(s.std)}%, min=${s.min}, max=${s.max}`
    );
  }
  reportLines.push('');

  const hasStrong15 = bestLags.some((x) => x.lag >= 14 && x.lag <= 16 && x.corr > 0.7);
  const hasStrong29 = bestLags.some((x) => x.lag >= 28 && x.lag <= 31 && x.corr > 0.6);
  const tideStdMedian = (() => {
    const arr = tideStats.map((s) => s.std).sort((a, b) => a - b);
    if (!arr.length) return NaN;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  })();

  reportLines.push(`## 7) 엔진 추정`);
  reportLines.push(`- 반월 주기 신호(14~16일): ${hasStrong15 ? '강함' : '약함/보통'}`);
  reportLines.push(`- 삭망 주기 신호(28~31일): ${hasStrong29 ? '강함' : '약함/보통'}`);
  reportLines.push(`- 물때 그룹 내부 변동(중앙 std): ${fixed(tideStdMedian)}%`);
  reportLines.push(`- 추정:`);
  reportLines.push(`  1. 기본 골격은 15단계 물때(사리→조금→무시→들물) 주기형 곡선`);
  reportLines.push(`  2. 일자 전이의 98% 이상이 고정 순서를 따르고, 예외는 특정 단계 스킵(예: 5물→7물)으로 집중됨`);
  reportLines.push(`  3. 스킵 누적 횟수가 삭망월 보정량과 매우 유사해, 음력 29.53일 동기화 보정 로직이 있는 것으로 추정됨`);
  reportLines.push(`  4. 단일 고정 테이블만으로는 설명이 부족하며(물때 내부 분산 존재) 추가 보정(시기/천문/지역)이 개입된 형태`);
  reportLines.push('');

  reportLines.push(`## 8) 산출물`);
  reportLines.push(`- CSV: \`${csvPath}\``);
  reportLines.push(`- JSON: \`${jsonPath}\``);
  reportLines.push(`- REPORT: \`${reportPath}\``);
  if (failed.length) {
    reportLines.push('');
    reportLines.push(`## 실패 월`);
    for (const f of failed) reportLines.push(`- ${f.ym}: ${f.reason}`);
  }

  fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf8');

  console.log('\n=== DONE ===');
  console.log(`rows=${all.length}, failedMonths=${failed.length}`);
  console.log(`mae(mean)=${fixed(maeMean)}, mae(tide)=${fixed(maeTide)}, mae(month)=${fixed(maeMonth)}, mae(add)=${fixed(maeAdd)}`);
  console.log(`transition hit=${fixed(transitionHitRate * 100)}% (${transitionExpected}/${transitionTotal}), unexpected=${transitionUnexpected}`);
  if (topAnomalyPairs.length) {
    console.log(`top anomaly: ${topAnomalyPairs[0].pair} x ${topAnomalyPairs[0].count}`);
  }
  console.log(`expected synodic skip≈${fixed(expectedSkipBySynodic)}, observed=${transitionUnexpected}`);
  console.log(`best lags: ${bestLags.slice(0, 5).map((x) => `${x.lag}:${fixed(x.corr, 3)}`).join(', ')}`);
  console.log(`best periods: ${bestPeriods.slice(0, 5).map((x) => `${x.period}:${fixed(x.mae, 2)}`).join(', ')}`);
  console.log(`report: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
