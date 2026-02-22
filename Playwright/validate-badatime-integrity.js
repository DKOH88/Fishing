/**
 * Validate stored badatime dataset against live badatime pages.
 *
 * Usage:
 *   node Playwright/validate-badatime-integrity.js
 *   node Playwright/validate-badatime-integrity.js --station-id 145 --month 2026-02
 *   node Playwright/validate-badatime-integrity.js --limit-jobs 20
 *   node Playwright/validate-badatime-integrity.js --data-file data/badatime_all_ports_20250101_20260222.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'https://www.badatime.com';
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const REPORT_DIR = path.join(DATA_DIR, 'validation');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_DELAY_MS = 80;
const DEFAULT_RETRIES = 5;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localStamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeCsv(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

function usageAndExit() {
  console.log([
    'Usage:',
    '  node Playwright/validate-badatime-integrity.js [options]',
    '',
    'Options:',
    '  --data-file <path>     Dataset json path. Default: latest badatime_all_ports_*.json',
    '  --station-id <id>      Validate only one station id',
    '  --month <YYYY-MM>      Validate only one month',
    '  --limit-jobs <n>       Validate first n station-month jobs (for quick test)',
    '  --concurrency <n>      Parallel request workers (default: 5)',
    '  --delay-ms <n>         Delay after each job in ms (default: 80)',
    '  --retries <n>          Request retries per page (default: 5)',
    '  --help                 Show this help',
  ].join('\n'));
  process.exit(0);
}

function parseArgs(argv) {
  const out = {
    dataFile: '',
    stationId: '',
    month: '',
    limitJobs: 0,
    concurrency: DEFAULT_CONCURRENCY,
    delayMs: DEFAULT_DELAY_MS,
    retries: DEFAULT_RETRIES,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usageAndExit();
    if (a === '--data-file') {
      out.dataFile = String(argv[++i] || '').trim();
      continue;
    }
    if (a === '--station-id') {
      out.stationId = String(argv[++i] || '').trim();
      continue;
    }
    if (a === '--month') {
      out.month = String(argv[++i] || '').trim();
      continue;
    }
    if (a === '--limit-jobs') {
      out.limitJobs = Number(argv[++i] || 0);
      continue;
    }
    if (a === '--concurrency') {
      out.concurrency = Number(argv[++i] || DEFAULT_CONCURRENCY);
      continue;
    }
    if (a === '--delay-ms') {
      out.delayMs = Number(argv[++i] || DEFAULT_DELAY_MS);
      continue;
    }
    if (a === '--retries') {
      out.retries = Number(argv[++i] || DEFAULT_RETRIES);
      continue;
    }
    throw new Error(`unknown option: ${a}`);
  }

  if (out.month && !/^\d{4}-\d{2}$/.test(out.month)) {
    throw new Error(`invalid --month format: ${out.month}`);
  }

  if (!Number.isFinite(out.limitJobs) || out.limitJobs < 0) {
    throw new Error(`invalid --limit-jobs: ${out.limitJobs}`);
  }
  out.limitJobs = Math.floor(out.limitJobs);

  if (!Number.isFinite(out.concurrency) || out.concurrency < 1) {
    throw new Error(`invalid --concurrency: ${out.concurrency}`);
  }
  out.concurrency = Math.floor(out.concurrency);

  if (!Number.isFinite(out.delayMs) || out.delayMs < 0) {
    throw new Error(`invalid --delay-ms: ${out.delayMs}`);
  }
  out.delayMs = Math.floor(out.delayMs);

  if (!Number.isFinite(out.retries) || out.retries < 1) {
    throw new Error(`invalid --retries: ${out.retries}`);
  }
  out.retries = Math.floor(out.retries);

  return out;
}

function resolveDataFile(userPath) {
  if (userPath) {
    const abs = path.isAbsolute(userPath) ? userPath : path.resolve(process.cwd(), userPath);
    if (!fs.existsSync(abs)) throw new Error(`dataset not found: ${abs}`);
    return abs;
  }

  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`data directory not found: ${DATA_DIR}`);
  }

  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^badatime_all_ports_\d{8}_\d{8}\.json$/i.test(f))
    .map((name) => {
      const fullPath = path.join(DATA_DIR, name);
      return {
        name,
        fullPath,
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  if (files.length === 0) {
    throw new Error(`no dataset file found in ${DATA_DIR}`);
  }
  return files[0].fullPath;
}

function getText(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'user-agent': UA,
          accept: 'text/html,*/*',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchText(url, retries) {
  let lastErr = null;
  for (let i = 1; i <= retries; i++) {
    try {
      return await getText(url, 20000);
    } catch (e) {
      lastErr = e;
      await sleep(700 * i);
    }
  }
  throw lastErr || new Error('fetch failed');
}

function parseDailyFlowRows(html, ym) {
  const rowMatches = [...html.matchAll(/<tr[^>]*class="day-row"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = new Map();

  for (const rowMatch of rowMatches) {
    const rowHtml = rowMatch[1];
    const dayCellHtml = (rowHtml.match(/class="day-cell"[\s\S]*?>([\s\S]*?)<\/td>/i) || [])[1] || '';
    const day = parseInt((dayCellHtml.match(/(\d{1,2})\s*\(/) || [])[1], 10);
    if (!Number.isFinite(day)) continue;

    const flow = parseInt((rowHtml.match(/class="progress-bar"[^>]*data-value="(\d{1,3})"/i) || [])[1], 10);
    if (!Number.isFinite(flow)) continue;

    const date = `${ym}-${pad2(day)}`;
    if (!out.has(date)) out.set(date, flow);
  }

  return out;
}

async function runQueue(jobs, workerFn, concurrency) {
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= jobs.length) return;
      await workerFn(jobs[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toMismatchCsv(rows) {
  const header = [
    'type',
    'station_id',
    'station_name',
    'ym',
    'date',
    'stored_flow_pct',
    'live_flow_pct',
    'url',
    'note',
  ].join(',');
  const lines = rows.map((r) =>
    [
      escapeCsv(r.type),
      escapeCsv(r.station_id),
      escapeCsv(r.station_name),
      escapeCsv(r.ym),
      escapeCsv(r.date),
      escapeCsv(r.stored_flow_pct),
      escapeCsv(r.live_flow_pct),
      escapeCsv(r.url),
      escapeCsv(r.note),
    ].join(',')
  );
  return [header, ...lines].join('\n');
}

function toFailedJobsCsv(rows) {
  const header = ['station_id', 'station_name', 'ym', 'url', 'error'].join(',');
  const lines = rows.map((r) =>
    [
      escapeCsv(r.station_id),
      escapeCsv(r.station_name),
      escapeCsv(r.ym),
      escapeCsv(r.url),
      escapeCsv(r.error),
    ].join(',')
  );
  return [header, ...lines].join('\n');
}

function countByType(items, key) {
  const out = {};
  for (const item of items) {
    const k = String(item[key] || '');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function buildExpectedMap(datasetRows) {
  const byStationMonth = new Map(); // station -> ym -> date -> flow
  for (const row of datasetRows) {
    const stationId = String(row.station_id || '').trim();
    const date = String(row.date || '').trim();
    if (!stationId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const flow = Number(row.flow_pct);
    if (!Number.isFinite(flow)) continue;

    const ym = date.slice(0, 7);
    if (!byStationMonth.has(stationId)) byStationMonth.set(stationId, new Map());
    const monthMap = byStationMonth.get(stationId);
    if (!monthMap.has(ym)) monthMap.set(ym, new Map());

    monthMap.get(ym).set(date, Math.round(flow));
  }
  return byStationMonth;
}

async function main() {
  const startedAt = Date.now();
  const opts = parseArgs(process.argv.slice(2));

  ensureDir(REPORT_DIR);

  const dataFile = resolveDataFile(opts.dataFile);
  const dataset = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const datasetRows = Array.isArray(dataset.rows) ? dataset.rows : [];
  const stationInfo = Array.isArray(dataset.stations) ? dataset.stations : [];

  if (datasetRows.length === 0) {
    throw new Error(`dataset has no rows: ${dataFile}`);
  }

  const stationName = new Map();
  for (const s of stationInfo) {
    const sid = String(s.station_id || '').trim();
    if (!sid) continue;
    stationName.set(sid, String(s.station_name || '').trim());
  }
  for (const r of datasetRows) {
    const sid = String(r.station_id || '').trim();
    if (!sid) continue;
    if (!stationName.has(sid)) {
      stationName.set(sid, String(r.station_name || '').trim());
    }
  }

  const expected = buildExpectedMap(datasetRows);
  let jobs = [];
  for (const [sid, monthMap] of expected.entries()) {
    if (opts.stationId && sid !== opts.stationId) continue;
    for (const ym of monthMap.keys()) {
      if (opts.month && ym !== opts.month) continue;
      jobs.push({ sid, ym });
    }
  }

  jobs.sort((a, b) => Number(a.sid) - Number(b.sid) || a.ym.localeCompare(b.ym));
  if (opts.limitJobs > 0) {
    jobs = jobs.slice(0, opts.limitJobs);
  }

  if (jobs.length === 0) {
    throw new Error('no jobs to validate. check --station-id / --month / --limit-jobs options.');
  }

  const mismatches = [];
  const failedJobs = [];
  let checkedRows = 0;
  let matchedRows = 0;
  let liveRowsTotal = 0;
  let done = 0;

  console.log(`dataset: ${dataFile}`);
  console.log(`stations in dataset: ${expected.size}`);
  console.log(`jobs to validate: ${jobs.length}`);
  console.log(`options: concurrency=${opts.concurrency}, delayMs=${opts.delayMs}, retries=${opts.retries}`);

  await runQueue(
    jobs,
    async (job) => {
      const sid = job.sid;
      const ym = job.ym;
      const url = `${BASE_URL}/${sid}/daily/${ym}`;
      const expectedMonth = expected.get(sid).get(ym);
      const sName = stationName.get(sid) || '';

      try {
        const html = await fetchText(url, opts.retries);
        const liveMonth = parseDailyFlowRows(html, ym);

        liveRowsTotal += liveMonth.size;
        checkedRows += expectedMonth.size;

        for (const [date, storedFlow] of expectedMonth.entries()) {
          if (!liveMonth.has(date)) {
            mismatches.push({
              type: 'missing_on_live',
              station_id: sid,
              station_name: sName,
              ym,
              date,
              stored_flow_pct: storedFlow,
              live_flow_pct: '',
              url,
              note: 'date exists in stored data, missing on live page',
            });
            continue;
          }

          const liveFlow = liveMonth.get(date);
          if (liveFlow !== storedFlow) {
            mismatches.push({
              type: 'flow_changed',
              station_id: sid,
              station_name: sName,
              ym,
              date,
              stored_flow_pct: storedFlow,
              live_flow_pct: liveFlow,
              url,
              note: 'stored flow_pct differs from live page',
            });
          } else {
            matchedRows++;
          }
        }

        for (const [date, liveFlow] of liveMonth.entries()) {
          if (!expectedMonth.has(date)) {
            mismatches.push({
              type: 'extra_on_live',
              station_id: sid,
              station_name: sName,
              ym,
              date,
              stored_flow_pct: '',
              live_flow_pct: liveFlow,
              url,
              note: 'date exists on live page, missing in stored data',
            });
          }
        }
      } catch (e) {
        failedJobs.push({
          station_id: sid,
          station_name: sName,
          ym,
          url,
          error: e && e.message ? e.message : String(e),
        });
      } finally {
        done++;
        if (done % 100 === 0 || done === jobs.length) {
          console.log(`progress: ${done}/${jobs.length} jobs, mismatches=${mismatches.length}, failed=${failedJobs.length}`);
        }
        if (opts.delayMs > 0) await sleep(opts.delayMs);
      }
    },
    opts.concurrency
  );

  const stamp = localStamp();
  const reportBase = `badatime_integrity_${stamp}`;

  const reportJsonPath = path.join(REPORT_DIR, `${reportBase}.json`);
  const mismatchCsvPath = path.join(REPORT_DIR, `${reportBase}_mismatches.csv`);
  const failedCsvPath = path.join(REPORT_DIR, `${reportBase}_failed_jobs.csv`);

  const latestJsonPath = path.join(REPORT_DIR, 'badatime_integrity_latest.json');
  const latestMismatchCsvPath = path.join(REPORT_DIR, 'badatime_integrity_latest_mismatches.csv');
  const latestFailedCsvPath = path.join(REPORT_DIR, 'badatime_integrity_latest_failed_jobs.csv');

  const mismatchCountByType = countByType(mismatches, 'type');
  const checkedStationsCount = new Set(jobs.map((j) => j.sid)).size;
  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  const summary = {
    status: mismatches.length === 0 && failedJobs.length === 0 ? 'PASS' : 'FAIL',
    generated_at: new Date().toISOString(),
    duration_sec: durationSec,
    data_file: dataFile,
    dataset_range: dataset.range || null,
    dataset_rows_count: datasetRows.length,
    checked_station_count: checkedStationsCount,
    checked_station_month_jobs: jobs.length,
    checked_expected_rows: checkedRows,
    matched_rows: matchedRows,
    live_rows_parsed: liveRowsTotal,
    mismatches_count: mismatches.length,
    mismatches_by_type: mismatchCountByType,
    failed_jobs_count: failedJobs.length,
    options: {
      station_id: opts.stationId || null,
      month: opts.month || null,
      limit_jobs: opts.limitJobs || null,
      concurrency: opts.concurrency,
      delay_ms: opts.delayMs,
      retries: opts.retries,
    },
  };

  const report = {
    summary,
    mismatches,
    failed_jobs: failedJobs,
  };

  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mismatchCsvPath, toMismatchCsv(mismatches), 'utf8');
  fs.writeFileSync(failedCsvPath, toFailedJobsCsv(failedJobs), 'utf8');

  fs.copyFileSync(reportJsonPath, latestJsonPath);
  fs.copyFileSync(mismatchCsvPath, latestMismatchCsvPath);
  fs.copyFileSync(failedCsvPath, latestFailedCsvPath);

  console.log(`report: ${reportJsonPath}`);
  console.log(`mismatches csv: ${mismatchCsvPath}`);
  console.log(`failed jobs csv: ${failedCsvPath}`);
  console.log(`status: ${summary.status}`);
  console.log(`mismatches=${summary.mismatches_count}, failed_jobs=${summary.failed_jobs_count}, duration=${summary.duration_sec}s`);

  if (failedJobs.length > 0) {
    process.exit(2);
  }
  if (mismatches.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
