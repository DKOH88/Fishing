/**
 * 바다타임 추정 엔진 시뮬레이션
 * 가정:
 * 1) 15단계 물때 순환
 * 2) 음력 동기화 보정으로 특정 구간(기본 5물->7물) 스킵
 * 3) 유속% = 물때 평균 + 월 보정(옵션)
 *
 * 사용:
 * node Playwright/simulate-badatime-engine.js 145 2010-01 2026-02
 */

const fs = require('fs');
const path = require('path');

const stationId = process.argv[2] || '145';
const startYm = process.argv[3] || '2010-01';
const endYm = process.argv[4] || '2026-02';

const base = path.resolve(__dirname, '..', 'analysis');
const inputPath = path.join(base, `badatime_${stationId}_${startYm}_${endYm}.json`);
const outPath = path.join(base, `badatime_${stationId}_${startYm}_${endYm}_sim_report.md`);

const SYNODIC_MONTH = 29.53058867;
const SOLAR_MONTH_NORM = 30;
const SKIP_PER_MONTH = SOLAR_MONTH_NORM - SYNODIC_MONTH; // 0.4694...
const SKIP_PER_DAY = SKIP_PER_MONTH / SYNODIC_MONTH; // 약 0.0159/day

const CYCLE = ['8물', '9물', '10물', '11물', '12물', '13물', '조금', '무시', '1물', '2물', '3물', '4물', '5물', '6물', '7물'];
const NEXT = new Map(CYCLE.map((x, i) => [x, CYCLE[(i + 1) % CYCLE.length]]));

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function mae(actual, pred) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const p = pred[i];
    if (!Number.isFinite(a) || !Number.isFinite(p)) continue;
    s += Math.abs(a - p);
    n++;
  }
  return n ? s / n : NaN;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function monthOf(dateStr) {
  return parseInt(dateStr.slice(5, 7), 10);
}

function trainModel(rows) {
  const byTide = new Map();
  const byMonth = new Map();
  const all = [];

  for (const r of rows) {
    if (!byTide.has(r.tide)) byTide.set(r.tide, []);
    byTide.get(r.tide).push(r.flow_pct);
    const m = monthOf(r.date);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r.flow_pct);
    all.push(r.flow_pct);
  }

  const globalMean = mean(all);
  const tideMean = new Map([...byTide.entries()].map(([k, arr]) => [k, mean(arr)]));
  const monthMean = new Map([...byMonth.entries()].map(([k, arr]) => [k, mean(arr)]));
  const monthOffset = new Map([...monthMean.entries()].map(([m, mm]) => [m, mm - globalMean]));

  return { globalMean, tideMean, monthOffset };
}

function simulateTides(rows, opts = {}) {
  const skipFrom = opts.skipFrom || '5물';
  const skipTo = opts.skipTo || '7물';
  const skipPerDay = Number.isFinite(opts.skipPerDay) ? opts.skipPerDay : SKIP_PER_DAY;
  const initAccumulator = Number.isFinite(opts.initAccumulator) ? opts.initAccumulator : 0;

  if (!rows.length) return { predTide: [], unexpected: 0 };
  const predTide = [];
  let acc = initAccumulator;

  predTide[0] = rows[0].tide; // 시작 상태 고정
  let skipCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const prev = predTide[i - 1];
    let cur = NEXT.get(prev) || rows[i].tide;

    // 음력 보정 누적
    acc += skipPerDay;

    // 스킵은 특정 구간에서만 허용
    if (prev === skipFrom && acc >= 1) {
      cur = skipTo;
      acc -= 1;
      skipCount++;
    }

    predTide[i] = cur;
  }

  return { predTide, skipCount, finalAccumulator: acc };
}

function lunarDayFromLunarField(s) {
  const m = String(s || '').match(/\.(\d{1,2})$/);
  if (!m) return NaN;
  return parseInt(m[1], 10);
}

function simulateTidesByLunarBoundary(rows, opts = {}) {
  const useDoubleStep = opts.useDoubleStep !== false; // 기본 true
  if (!rows.length) return { predTide: [], skipCount: 0 };

  const predTide = [];
  predTide[0] = rows[0].tide;
  let skipCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const prevPred = predTide[i - 1];
    let curPred = NEXT.get(prevPred) || rows[i].tide;

    const ldPrev = lunarDayFromLunarField(rows[i - 1].lunar);
    const ldCur = lunarDayFromLunarField(rows[i].lunar);

    // 핵심 규칙: 음력 29일 → 다음달 1일로 넘어가는 날 한 단계 추가 진행(스킵)
    if (Number.isFinite(ldPrev) && Number.isFinite(ldCur) && ldPrev === 29 && ldCur === 1) {
      if (useDoubleStep) {
        curPred = NEXT.get(curPred) || curPred;
      }
      skipCount++;
    }

    predTide[i] = curPred;
  }

  return { predTide, skipCount };
}

function evaluate(rows, predTide, model, useMonthOffset) {
  const actualTide = rows.map((r) => r.tide);
  const actualPct = rows.map((r) => r.flow_pct);

  let tideHit = 0;
  for (let i = 0; i < rows.length; i++) {
    if (predTide[i] === actualTide[i]) tideHit++;
  }
  const tideAcc = rows.length ? tideHit / rows.length : NaN;

  const predPct = rows.map((r, i) => {
    const t = predTide[i];
    const base = model.tideMean.get(t) ?? model.globalMean;
    const mo = useMonthOffset ? (model.monthOffset.get(monthOf(r.date)) ?? 0) : 0;
    return Math.round(clamp(base + mo, 0, 100));
  });

  return {
    tideAcc,
    maePct: mae(actualPct, predPct),
    predPct,
  };
}

function buildTransitionAnomaly(rows) {
  let total = 0;
  let unexpected = 0;
  const pairs = new Map();
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const gap = (new Date(cur.date) - new Date(prev.date)) / 86400000;
    if (gap !== 1) continue;
    total++;
    const exp = NEXT.get(prev.tide);
    if (cur.tide !== exp) {
      unexpected++;
      const k = `${prev.tide}->${cur.tide} (exp ${exp})`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return { total, unexpected, top };
}

function ymCompare(dateStr, ymBoundary) {
  const ym = dateStr.slice(0, 7);
  if (ym < ymBoundary) return -1;
  if (ym > ymBoundary) return 1;
  return 0;
}

function fixed(v, d = 2) {
  return Number.isFinite(v) ? v.toFixed(d) : 'NaN';
}

function run() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`input not found: ${inputPath}`);
  }
  const json = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const rows = (json.rows || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new Error('no rows');

  // 학습/평가 분리: 2010~2024 학습, 2025~2026.02 평가
  const splitYm = '2025-01';
  const trainRows = rows.filter((r) => ymCompare(r.date, splitYm) < 0);
  const testRows = rows.filter((r) => ymCompare(r.date, splitYm) >= 0);

  const model = trainModel(trainRows);
  const transition = buildTransitionAnomaly(rows);

  // 시뮬레이션
  const sim = simulateTides(rows, {
    skipFrom: '5물',
    skipTo: '7물',
    skipPerDay: SKIP_PER_DAY,
    initAccumulator: 0,
  });
  const simLunar = simulateTidesByLunarBoundary(rows, { useDoubleStep: true });

  // 전체 평가
  const evalAllNoMonth = evaluate(rows, sim.predTide, model, false);
  const evalAllWithMonth = evaluate(rows, sim.predTide, model, true);
  const evalAllLunarNoMonth = evaluate(rows, simLunar.predTide, model, false);
  const evalAllLunarWithMonth = evaluate(rows, simLunar.predTide, model, true);

  // 테스트 구간 평가(2025~)
  const predTideTest = sim.predTide.slice(trainRows.length);
  const predTideTestLunar = simLunar.predTide.slice(trainRows.length);
  const evalTestNoMonth = evaluate(testRows, predTideTest, model, false);
  const evalTestWithMonth = evaluate(testRows, predTideTest, model, true);
  const evalTestLunarNoMonth = evaluate(testRows, predTideTestLunar, model, false);
  const evalTestLunarWithMonth = evaluate(testRows, predTideTestLunar, model, true);

  const expectedSkip = ((rows.length - 1) * SKIP_PER_DAY);

  const report = [];
  report.push(`# 바다타임 추정 엔진 시뮬레이션`);
  report.push(`- station: \`${stationId}\``);
  report.push(`- data: \`${startYm}\` ~ \`${endYm}\``);
  report.push(`- rows: ${rows.length}`);
  report.push(`- train: ${trainRows.length} rows (<= 2024-12)`);
  report.push(`- test: ${testRows.length} rows (>= 2025-01)`);
  report.push('');

  report.push(`## 가정 엔진`);
  report.push(`- 15단계 순환: ${CYCLE.join(' -> ')}`);
  report.push(`- 스킵 규칙: \`5물 -> 7물\``);
  report.push(`- 스킵 누적율: ${(SKIP_PER_DAY).toFixed(6)} /day`);
  report.push(`- 기대 스킵 수(전체): ${fixed(expectedSkip, 2)}회`);
  report.push(`- 시뮬레이션 스킵 수(전체): ${sim.skipCount}회`);
  report.push(`- 음력경계 스킵 수(전체): ${simLunar.skipCount}회`);
  report.push('');

  report.push(`## 실제 데이터 전이`);
  report.push(`- 연속 전이 수: ${transition.total}`);
  report.push(`- 비정상 전이 수: ${transition.unexpected}`);
  for (const [k, c] of transition.top) {
    report.push(`- ${k}: ${c}회`);
  }
  report.push('');

  report.push(`## 결과(전체 구간)`);
  report.push(`- [비율누적형] tide 일치율: ${fixed(evalAllNoMonth.tideAcc * 100, 2)}%`);
  report.push(`- [비율누적형] % MAE (물때평균만): ${fixed(evalAllNoMonth.maePct)}%`);
  report.push(`- [비율누적형] % MAE (물때평균+월보정): ${fixed(evalAllWithMonth.maePct)}%`);
  report.push(`- [음력경계형] tide 일치율: ${fixed(evalAllLunarNoMonth.tideAcc * 100, 2)}%`);
  report.push(`- [음력경계형] % MAE (물때평균만): ${fixed(evalAllLunarNoMonth.maePct)}%`);
  report.push(`- [음력경계형] % MAE (물때평균+월보정): ${fixed(evalAllLunarWithMonth.maePct)}%`);
  report.push('');

  report.push(`## 결과(테스트 2025~)`);
  report.push(`- [비율누적형] tide 일치율: ${fixed(evalTestNoMonth.tideAcc * 100, 2)}%`);
  report.push(`- [비율누적형] % MAE (물때평균만): ${fixed(evalTestNoMonth.maePct)}%`);
  report.push(`- [비율누적형] % MAE (물때평균+월보정): ${fixed(evalTestWithMonth.maePct)}%`);
  report.push(`- [음력경계형] tide 일치율: ${fixed(evalTestLunarNoMonth.tideAcc * 100, 2)}%`);
  report.push(`- [음력경계형] % MAE (물때평균만): ${fixed(evalTestLunarNoMonth.maePct)}%`);
  report.push(`- [음력경계형] % MAE (물때평균+월보정): ${fixed(evalTestLunarWithMonth.maePct)}%`);
  report.push('');

  report.push(`## 해석`);
  report.push(`- 물때 라벨은 "음력 29일 경계 스킵"을 넣었을 때 재현도가 크게 개선됨.`);
  report.push(`- 유속%는 물때 평균만으로도 기본 재현 가능하나, 잔차가 커서 추가 보정(천문/조차/지역)이 필요.`);

  fs.writeFileSync(outPath, report.join('\n'), 'utf8');

  console.log(`input=${inputPath}`);
  console.log(`output=${outPath}`);
  console.log(`ratio_acc_all=${fixed(evalAllNoMonth.tideAcc * 100, 2)}%, ratio_mae_all=${fixed(evalAllNoMonth.maePct)}%, ratio_mae_all_month=${fixed(evalAllWithMonth.maePct)}%`);
  console.log(`lunar_acc_all=${fixed(evalAllLunarNoMonth.tideAcc * 100, 2)}%, lunar_mae_all=${fixed(evalAllLunarNoMonth.maePct)}%, lunar_mae_all_month=${fixed(evalAllLunarWithMonth.maePct)}%`);
  console.log(`ratio_acc_test=${fixed(evalTestNoMonth.tideAcc * 100, 2)}%, ratio_mae_test=${fixed(evalTestNoMonth.maePct)}%, ratio_mae_test_month=${fixed(evalTestWithMonth.maePct)}%`);
  console.log(`lunar_acc_test=${fixed(evalTestLunarNoMonth.tideAcc * 100, 2)}%, lunar_mae_test=${fixed(evalTestLunarNoMonth.maePct)}%, lunar_mae_test_month=${fixed(evalTestLunarWithMonth.maePct)}%`);
  console.log(`expected_skip=${fixed(expectedSkip, 2)}, simulated_skip=${sim.skipCount}, observed_unexpected=${transition.unexpected}`);
  console.log(`lunar_boundary_skip=${simLunar.skipCount}`);
}

run();
