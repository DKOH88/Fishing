/**
 * 바다타임 단일 포트 스크래핑 → KV 업로드용 JSON 생성
 * Usage: node scripts/fetch-single-badatime.js <station_id> [start_ym] [end_ym]
 * Example: node scripts/fetch-single-badatime.js 144 2025-01 2026-12
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const SID = process.argv[2];
const START = process.argv[3] || '2025-01';
const END = process.argv[4] || '2026-12';

if (!SID) { console.error('Usage: node fetch-single-badatime.js <station_id>'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function pad2(n) { return String(n).padStart(2, '0'); }

function listMonths(startYm, endYm) {
  const out = [];
  const [sy, sm] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad2(m)}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseDailyRows(html, ym) {
  const rows = [...html.matchAll(/<tr[^>]*class="day-row"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = {};
  for (const m of rows) {
    const rowHtml = m[1];
    const dayCell = (rowHtml.match(/class="day-cell"[\s\S]*?>([\s\S]*?)<\/td>/i) || [])[1] || '';
    const day = parseInt((dayCell.match(/(\d{1,2})\s*\(/) || [])[1], 10);
    if (!Number.isFinite(day)) continue;
    const flow = parseInt((rowHtml.match(/class="progress-bar"[^>]*data-value="(\d{1,3})"/i) || [])[1], 10);
    if (!Number.isFinite(flow)) continue;
    out[`${ym}-${pad2(day)}`] = flow;
  }
  return out;
}

async function main() {
  const months = listMonths(START, END);
  console.log(`🔍 Station ${SID}: ${months.length} months (${START} ~ ${END})`);

  const data = {};
  let total = 0;
  for (const ym of months) {
    const url = `https://www.badatime.com/${SID}/daily/${ym}`;
    try {
      const html = await fetchPage(url);
      const rows = parseDailyRows(html, ym);
      const count = Object.keys(rows).length;
      Object.assign(data, rows);
      total += count;
      process.stdout.write(`  ${ym}: ${count} days\n`);
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.error(`  ${ym}: ERROR ${e.message}`);
    }
  }

  console.log(`\n✅ Total: ${total} days`);

  // KV bulk JSON 형식으로 저장
  const outPath = path.join(__dirname, `badatime-single-${SID}.json`);
  const bulk = [{ key: `bt:${SID}`, value: JSON.stringify(data) }];
  fs.writeFileSync(outPath, JSON.stringify(bulk));
  console.log(`📦 Written to ${outPath}`);
  console.log(`\n🚀 KV 업로드:`);
  console.log(`   cd worker && npx wrangler kv bulk put ${outPath} --namespace-id=cd2306ce540a4402907f4610b1e19368 --remote`);
}

main().catch(e => { console.error(e); process.exit(1); });
