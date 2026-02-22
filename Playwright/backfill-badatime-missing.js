/**
 * Backfill missing badatime rows from an existing merged dataset.
 *
 * Strategy:
 * - Load current dataset json
 * - Detect missing dates per station in [range.from, range.to]
 * - Fetch only missing months (/id/daily/YYYY-MM)
 * - Merge rows by station_id + date
 * - Recompute summary and overwrite json/csv/summary
 *
 * Usage:
 *   node Playwright/backfill-badatime-missing.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_FILE = path.resolve(__dirname, '..', 'data', 'badatime_all_ports_20250101_20260222.json');
const REQUEST_DELAY_MS = 120;
const CONCURRENCY = 3;
const MAX_PASSES = 4;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toYmd(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function toYm(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
}

function ymdCompact(ymd) {
  return ymd.replace(/-/g, '');
}

function listDates(startYmd, endYmd) {
  const out = [];
  const start = toDate(startYmd);
  const end = toDate(endYmd);
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    out.push(toYmd(new Date(t)));
  }
  return out;
}

function listMonths(startYmd, endYmd) {
  const out = [];
  const start = toDate(startYmd);
  const end = toDate(endYmd);
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    out.push(toYm(cur));
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

function normalizeTide(raw) {
  const t = (raw || '')
    .replace(/\s+/g, '')
    .replace(/&nbsp;/g, '')
    .trim();

  const num = t.match(/(\d{1,2})/);
  if (num) return `${parseInt(num[1], 10)}물`;

  if (t.includes('조금')) return '조금';
  if (t.includes('무시')) return '무시';
  if (t.includes('사리')) return '사리';
  if (t.includes('\uFFFD') || t.includes('�')) return '';
  return t || '';
}

function parseDailyRows(html, ym, stationId) {
  const rows = [...html.matchAll(/<tr[^>]*class="day-row"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = [];

  for (const m of rows) {
    const rowHtml = m[1];
    const dayCell = (rowHtml.match(/class="day-cell"[\s\S]*?>([\s\S]*?)<\/td>/i) || [])[1] || '';
    const day = parseInt((dayCell.match(/(\d{1,2})\s*\(/) || [])[1], 10);
    if (!Number.isFinite(day)) continue;

    const date = `${ym}-${pad2(day)}`;
    const lunar = ((dayCell.match(/<span[^>]*>([\d.]+)<\/span>/i) || [])[1] || '').trim() || '';
    const tideRaw = ((rowHtml.match(/class="tide-text"[\s\S]*?<b>([\s\S]*?)<\/b>/i) || [])[1] || '').trim();
    const tide = normalizeTide(stripTags(tideRaw));
    const flow = parseInt((rowHtml.match(/class="progress-bar"[^>]*data-value="(\d{1,3})"/i) || [])[1], 10);
    if (!Number.isFinite(flow)) continue;

    out.push({
      station_id: stationId,
      date,
      ym,
      day,
      tide,
      flow_pct: flow,
      lunar,
    });
  }

  const dedup = new Map();
  for (const r of out) {
    if (!dedup.has(r.date)) dedup.set(r.date, r);
  }
  return [...dedup.values()].sort((a, b) => a.date.localeCompare(b.date));
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
        res.on('data', (c) => { data += c.toString('utf8'); });
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

async function fetchText(url, tries = 6) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      return await getText(url, 20000);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 900 * i));
    }
  }
  throw lastErr || new Error('fetch failed');
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

function toCsv(rows) {
  const header = 'station_id,station_name,date,ym,day,tide,flow_pct,lunar';
  const lines = rows.map((r) =>
    [
      r.station_id,
      `"${String(r.station_name || '').replace(/"/g, '""')}"`,
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

function toSummaryCsv(stations) {
  const header = 'station_id,station_name,row_count,first_date,last_date,failed_months';
  const lines = stations.map((s) => [
    s.station_id,
    `"${String(s.station_name || '').replace(/"/g, '""')}"`,
    s.row_count,
    s.first_date || '',
    s.last_date || '',
    (s.failed_months || []).join('|'),
  ].join(','));
  return [header, ...lines].join('\n');
}

function buildRowsMap(rows) {
  const byStation = new Map(); // station -> Map(date,row)
  for (const r of rows) {
    const sid = String(r.station_id || '');
    if (!sid || !r.date) continue;
    if (!byStation.has(sid)) byStation.set(sid, new Map());
    byStation.get(sid).set(r.date, {
      station_id: sid,
      date: r.date,
      ym: r.ym || r.date.slice(0, 7),
      day: Number(r.day) || Number(r.date.slice(8, 10)),
      tide: r.tide || '',
      flow_pct: Number(r.flow_pct),
      lunar: r.lunar || '',
    });
  }
  return byStation;
}

function computeMissingMonths(byStationDateMap, expectedDates, expectedMonths) {
  const out = new Map(); // station -> Set(month)
  for (const [sid, dateMap] of byStationDateMap.entries()) {
    const missMonths = new Set();
    for (const d of expectedDates) {
      if (!dateMap.has(d)) missMonths.add(d.slice(0, 7));
    }
    // keep order
    const ordered = expectedMonths.filter((m) => missMonths.has(m));
    out.set(sid, new Set(ordered));
  }
  return out;
}

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`dataset not found: ${DATA_FILE}`);
  }

  const json = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const range = json.range || { from: '2025-01-01', to: toYmd(new Date()) };
  const expectedDates = listDates(range.from, range.to);
  const expectedMonths = listMonths(range.from, range.to);

  const stations = Array.isArray(json.stations) ? json.stations : [];
  const stationName = new Map(stations.map((s) => [String(s.station_id), String(s.station_name || '')]));

  const rows = Array.isArray(json.rows) ? json.rows : [];
  const byStation = buildRowsMap(rows);

  // include station ids that might exist only in stations list
  for (const sid of stationName.keys()) {
    if (!byStation.has(sid)) byStation.set(sid, new Map());
  }

  console.log(`backfill start: stations=${byStation.size}, rows=${rows.length}, range=${range.from}..${range.to}`);

  let totalFetchedRows = 0;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const missingByStation = computeMissingMonths(byStation, expectedDates, expectedMonths);
    const jobs = [];
    for (const [sid, monthsSet] of missingByStation.entries()) {
      for (const ym of monthsSet) jobs.push({ sid, ym });
    }

    if (jobs.length === 0) {
      console.log(`pass ${pass}: no missing jobs, done`);
      break;
    }

    let fetchedRowsThisPass = 0;
    let done = 0;
    console.log(`pass ${pass}: missing month jobs=${jobs.length}`);

    await runQueue(
      jobs,
      async (job) => {
        const { sid, ym } = job;
        const url = `https://www.badatime.com/${sid}/daily/${ym}`;
        try {
          const html = await fetchText(url, 6);
          const parsed = parseDailyRows(html, ym, sid);
          if (!byStation.has(sid)) byStation.set(sid, new Map());
          const dateMap = byStation.get(sid);
          for (const r of parsed) {
            if (!dateMap.has(r.date)) {
              dateMap.set(r.date, r);
              fetchedRowsThisPass++;
            }
          }
        } catch {
          // keep missing, next pass may retry
        } finally {
          done++;
          if (done % 100 === 0 || done === jobs.length) {
            console.log(`  progress ${done}/${jobs.length}`);
          }
          if (REQUEST_DELAY_MS > 0) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
        }
      },
      CONCURRENCY
    );

    totalFetchedRows += fetchedRowsThisPass;
    console.log(`pass ${pass}: newly fetched rows=${fetchedRowsThisPass}`);
    if (fetchedRowsThisPass === 0) {
      console.log(`pass ${pass}: no progress, stop`);
      break;
    }
  }

  // Rebuild rows + summary
  const finalStations = [];
  const finalRows = [];

  const stationIds = [...byStation.keys()].sort((a, b) => Number(a) - Number(b));
  for (const sid of stationIds) {
    const dateMap = byStation.get(sid);
    const arr = [...dateMap.values()]
      .filter((r) => expectedDates.includes(r.date))
      .sort((a, b) => a.date.localeCompare(b.date));

    const missMonthsSet = new Set();
    const hasDate = new Set(arr.map((r) => r.date));
    for (const d of expectedDates) {
      if (!hasDate.has(d)) missMonthsSet.add(d.slice(0, 7));
    }
    const failedMonths = expectedMonths.filter((m) => missMonthsSet.has(m));

    const sName = stationName.get(sid) || '';
    finalStations.push({
      station_id: sid,
      station_name: sName,
      row_count: arr.length,
      first_date: arr.length ? arr[0].date : '',
      last_date: arr.length ? arr[arr.length - 1].date : '',
      failed_months: failedMonths,
    });

    for (const r of arr) {
      finalRows.push({
        station_id: sid,
        station_name: sName,
        date: r.date,
        ym: r.ym || r.date.slice(0, 7),
        day: Number(r.day) || Number(r.date.slice(8, 10)),
        tide: r.tide || '',
        flow_pct: Number(r.flow_pct),
        lunar: r.lunar || '',
      });
    }
  }

  finalRows.sort((a, b) => {
    if (a.station_id !== b.station_id) return Number(a.station_id) - Number(b.station_id);
    return a.date.localeCompare(b.date);
  });

  finalStations.sort((a, b) => Number(a.station_id) - Number(b.station_id));

  const jsonPath = DATA_FILE;
  const csvPath = DATA_FILE.replace(/\.json$/i, '.csv');
  const summaryPath = DATA_FILE.replace(/\.json$/i, '_summary.csv');

  const out = {
    source: json.source || 'https://www.badatime.com',
    generated_at: new Date().toISOString(),
    range,
    ports_count: finalStations.length,
    rows_count: finalRows.length,
    failed_jobs_count: finalStations.reduce((s, x) => s + x.failed_months.length, 0),
    stations: finalStations,
    rows: finalRows,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
  fs.writeFileSync(csvPath, toCsv(finalRows), 'utf8');
  fs.writeFileSync(summaryPath, toSummaryCsv(finalStations), 'utf8');

  const fullCount = finalStations.filter((s) => s.row_count === expectedDates.length).length;
  const partialCount = finalStations.length - fullCount;
  console.log(`saved: ${jsonPath}`);
  console.log(`saved: ${csvPath}`);
  console.log(`saved: ${summaryPath}`);
  console.log(`backfill done: totalFetchedRows=${totalFetchedRows}, stations=${finalStations.length}, full=${fullCount}, partial=${partialCount}, rows=${finalRows.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

