/**
 * 바다타임 CSV → Cloudflare KV 벌크 업로드 스크립트
 *
 * 사용법:
 *   node scripts/upload-badatime-kv.js
 *   cd worker && npx wrangler kv:bulk put --namespace-id=cd2306ce540a4402907f4610b1e19368 ../scripts/badatime-bulk.json
 *
 * CSV 포맷: station_id,station_name,date,ym,day,tide,flow_pct,lunar
 * KV 키: bt:{station_id}  값: {"2025-01-01":78,"2025-01-02":80,...}
 */

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'data', 'badatime_all_ports_20250101_20260222.csv');
const OUT_PATH = path.join(__dirname, 'badatime-bulk.json');

// CSV 파싱
const raw = fs.readFileSync(CSV_PATH, 'utf-8');
const lines = raw.trim().split('\n');
const header = lines[0]; // station_id,station_name,date,ym,day,tide,flow_pct,lunar

console.log(`📄 CSV: ${lines.length - 1} rows`);

// station_id별로 그룹핑: {station_id: {date: flow_pct}}
const stationMap = {};

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  // CSV 파싱 (따옴표 처리)
  const parts = [];
  let current = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);

  const [stationId, , date, , , , flowPctRaw] = parts;
  const flowPct = parseInt(flowPctRaw, 10);

  if (!stationId || !date || isNaN(flowPct)) continue;

  if (!stationMap[stationId]) stationMap[stationId] = {};
  stationMap[stationId][date] = flowPct;
}

const stationIds = Object.keys(stationMap);
console.log(`📊 ${stationIds.length} stations parsed`);

// wrangler kv:bulk put 형식으로 변환
// [{"key":"bt:1","value":"{\"2025-01-01\":78,...}"},...]
const bulk = stationIds.map(sid => ({
  key: `bt:${sid}`,
  value: JSON.stringify(stationMap[sid]),
}));

// 크기 확인
const totalBytes = bulk.reduce((sum, item) => sum + item.key.length + item.value.length, 0);
console.log(`📦 Bulk JSON: ${bulk.length} keys, ~${(totalBytes / 1024).toFixed(1)} KB`);

fs.writeFileSync(OUT_PATH, JSON.stringify(bulk, null, 0));
console.log(`✅ Written to ${OUT_PATH}`);
console.log(`\n🚀 다음 명령어로 KV에 업로드:`);
console.log(`   cd worker && npx wrangler kv:bulk put --namespace-id=cd2306ce540a4402907f4610b1e19368 ../scripts/badatime-bulk.json`);
