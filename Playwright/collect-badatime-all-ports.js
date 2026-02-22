/**
 * Collect badatime flow percent data for all ports visible on homepage (/id/tide links).
 *
 * Range:
 * - from 2025-01-01
 * - to   today (local date)
 *
 * Output:
 * - data/badatime_all_ports_YYYYMMDD_YYYYMMDD.json
 * - data/badatime_all_ports_YYYYMMDD_YYYYMMDD.csv
 * - data/badatime_all_ports_YYYYMMDD_YYYYMMDD_summary.csv
 *
 * Usage:
 *   node Playwright/collect-badatime-all-ports.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'https://www.badatime.com';
const START_DATE = '2025-01-01';
const REQUEST_DELAY_MS = 120;
const CONCURRENCY = 3;
const MERGE_PREVIOUS = true;

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

  // Drop mojibake from non-UTF8 pages. Flow percentage is the primary target.
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
    const tide = normalizeTide(stripTags(tideRaw)) || '';

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

function parseStationNameFromTitle(html) {
  const title = ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  // Example: "2025년 10월 대산 물때표, 대산 조항정보 - 바다타임"
  const m = title.match(/\d{4}년\s*\d{1,2}월\s*(.+?)\s*물때표/i);
  return m ? m[1].trim() : '';
}

function parsePortsFromHomepage(html) {
  const re = /<a[^>]*href=['"]\/(\d+)\/tide[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  const map = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const text = stripTags(m[2]);
    if (!text) continue;
    if (!map.has(id)) map.set(id, text.replace(/\s*물때표\s*$/i, '').trim());
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

async function collectPortsFromHomepage(samples = 5) {
  const merged = new Map();
  for (let i = 0; i < samples; i++) {
    try {
      const homeHtml = await fetchText(BASE_URL, 3);
      const ports = parsePortsFromHomepage(homeHtml);
      for (const p of ports) {
        if (!merged.has(p.id)) {
          merged.set(p.id, p.name || '');
        } else if (!merged.get(p.id) && p.name) {
          merged.set(p.id, p.name);
        }
      }
    } catch {
      // ignore one-sample failure
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return [...merged.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => Number(a.id) - Number(b.id));
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
    s.id,
    `"${String(s.name || '').replace(/"/g, '""')}"`,
    s.row_count,
    s.first_date || '',
    s.last_date || '',
    s.failed_months.join('|'),
  ].join(','));
  return [header, ...lines].join('\n');
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

async function main() {
  const today = toYmd(new Date());
  const months = listMonths(START_DATE, today);
  const stamp = `${ymdCompact(START_DATE)}_${ymdCompact(today)}`;
  const outputBase = path.resolve(__dirname, '..', 'data');
  fs.mkdirSync(outputBase, { recursive: true });
  const jsonPath = path.join(outputBase, `badatime_all_ports_${stamp}.json`);
  const csvPath = path.join(outputBase, `badatime_all_ports_${stamp}.csv`);
  const summaryPath = path.join(outputBase, `badatime_all_ports_${stamp}_summary.csv`);

  console.log(`collecting badatime all ports from ${START_DATE} to ${today}`);

  const portsFromHome = await collectPortsFromHomepage(6);
  if (portsFromHome.length === 0) {
    throw new Error('failed to parse ports from homepage');
  }
  console.log(`ports found on homepage (union): ${portsFromHome.length}`);

  const portMap = new Map(portsFromHome.map((p) => [String(p.id), p.name || '']));

  if (MERGE_PREVIOUS && fs.existsSync(jsonPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const prevStations = Array.isArray(prev?.stations) ? prev.stations : [];
      for (const s of prevStations) {
        const id = String(s?.station_id || '');
        if (!id) continue;
        if (!portMap.has(id)) {
          portMap.set(id, String(s?.station_name || ''));
        } else if (!portMap.get(id) && s?.station_name) {
          portMap.set(id, String(s.station_name));
        }
      }
    } catch {
      // ignore merge seed load failure
    }
  }

  const ports = [...portMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  console.log(`ports after merge-seed union: ${ports.length}`);

  const jobs = [];
  for (const p of ports) {
    for (const ym of months) jobs.push({ id: p.id, ym });
  }
  console.log(`jobs: ${jobs.length} (${ports.length} ports x ${months.length} months)`);

  const portNameMap = new Map(ports.map((p) => [p.id, p.name]));
  const stationRows = new Map();       // id -> rows[]
  const stationFailed = new Map();     // id -> failed ym[]
  const stationSeenName = new Map();   // id -> parsed title name
  let done = 0;

  // Merge mode: keep previously collected rows and only add newly fetched rows.
  if (MERGE_PREVIOUS && fs.existsSync(jsonPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const prevRows = Array.isArray(prev?.rows) ? prev.rows : [];
      for (const r of prevRows) {
        const id = String(r.station_id || '');
        if (!id) continue;
        if (!stationRows.has(id)) stationRows.set(id, []);
        stationRows.get(id).push({
          station_id: id,
          date: r.date,
          ym: r.ym || String(r.date || '').slice(0, 7),
          day: Number(r.day) || Number(String(r.date || '').slice(8, 10)),
          tide: r.tide || '',
          flow_pct: Number(r.flow_pct),
          lunar: r.lunar || '',
        });
      }
      const prevStations = Array.isArray(prev?.stations) ? prev.stations : [];
      for (const s of prevStations) {
        if (s?.station_id && s?.station_name) {
          stationSeenName.set(String(s.station_id), String(s.station_name));
        }
      }
      console.log(`merge mode: loaded previous rows=${prevRows.length}`);
    } catch (e) {
      console.warn(`merge mode load failed: ${e.message}`);
    }
  }

  await runQueue(
    jobs,
    async (job) => {
      const { id, ym } = job;
      const url = `${BASE_URL}/${id}/daily/${ym}`;
      try {
        const html = await fetchText(url, 3);
        const parsed = parseDailyRows(html, ym, id);
        const titleName = parseStationNameFromTitle(html);
        if (titleName && !stationSeenName.has(id)) stationSeenName.set(id, titleName);

        if (!stationRows.has(id)) stationRows.set(id, []);
        stationRows.get(id).push(...parsed);
      } catch (e) {
        if (!stationFailed.has(id)) stationFailed.set(id, []);
        stationFailed.get(id).push(ym);
      } finally {
        done++;
        if (done % 100 === 0 || done === jobs.length) {
          console.log(`progress ${done}/${jobs.length}`);
        }
        if (REQUEST_DELAY_MS > 0) {
          await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
        }
      }
    },
    CONCURRENCY
  );

  const startDateObj = toDate(START_DATE);
  const endDateObj = toDate(today);
  const flatRows = [];
  const stationSummary = [];

  for (const p of ports) {
    const id = p.id;
    const baseName = stationSeenName.get(id) || portNameMap.get(id) || '';
    const rows = (stationRows.get(id) || [])
      .filter((r) => {
        const d = toDate(r.date);
        return d >= startDateObj && d <= endDateObj;
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const dedupByDate = new Map();
    for (const r of rows) {
      if (!dedupByDate.has(r.date)) dedupByDate.set(r.date, r);
    }
    const finalRows = [...dedupByDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    for (const r of finalRows) {
      flatRows.push({
        station_id: r.station_id,
        station_name: baseName,
        date: r.date,
        ym: r.ym,
        day: r.day,
        tide: r.tide,
        flow_pct: r.flow_pct,
        lunar: r.lunar,
      });
    }

    stationSummary.push({
      id,
      name: baseName,
      row_count: finalRows.length,
      first_date: finalRows.length > 0 ? finalRows[0].date : '',
      last_date: finalRows.length > 0 ? finalRows[finalRows.length - 1].date : '',
      failed_months: stationFailed.get(id) || [],
    });
  }

  flatRows.sort((a, b) => {
    if (a.station_id !== b.station_id) return Number(a.station_id) - Number(b.station_id);
    return a.date.localeCompare(b.date);
  });
  stationSummary.sort((a, b) => Number(a.id) - Number(b.id));

  const jsonObj = {
    source: BASE_URL,
    generated_at: new Date().toISOString(),
    range: { from: START_DATE, to: today },
    ports_count: ports.length,
    rows_count: flatRows.length,
    failed_jobs_count: [...stationSummary].reduce((s, x) => s + x.failed_months.length, 0),
    stations: stationSummary.map((s) => ({
      station_id: s.id,
      station_name: s.name,
      row_count: s.row_count,
      first_date: s.first_date,
      last_date: s.last_date,
      failed_months: s.failed_months,
    })),
    rows: flatRows,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(jsonObj, null, 2), 'utf8');
  fs.writeFileSync(csvPath, toCsv(flatRows), 'utf8');
  fs.writeFileSync(summaryPath, toSummaryCsv(stationSummary), 'utf8');

  const nonEmptyStations = stationSummary.filter((s) => s.row_count > 0).length;
  const failedStations = stationSummary.filter((s) => s.failed_months.length > 0).length;

  console.log('');
  console.log(`saved json   : ${jsonPath}`);
  console.log(`saved csv    : ${csvPath}`);
  console.log(`saved summary: ${summaryPath}`);
  console.log(`ports=${ports.length}, nonEmpty=${nonEmptyStations}, rows=${flatRows.length}, failedStations=${failedStations}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
