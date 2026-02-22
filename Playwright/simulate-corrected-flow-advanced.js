/**
 * Advanced simulation for corrected flow model.
 *
 * What it does:
 * - Runs 3-month + 1-month simulations for Daesan(145) and Mohang(134)
 * - Compares current-station sensitivity
 * - Optimizes weights only
 * - Optimizes weights + delta clamp together
 *
 * Usage:
 *   node Playwright/simulate-corrected-flow-advanced.js
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';

const FULL_RANGE = { from: '2025-10-01', to: '2025-12-31' };
const MONTH_RANGE = { from: '2025-11-01', to: '2025-11-30' };

const APP_DEFAULT = {
    weights: { range: 0.92, crsp: 0.08 },
    deltaClamp: { min: -10, max: 14 },
};

const PREV_DEFAULT = {
    weights: { range: 0.78, crsp: 0.22 },
    deltaClamp: { min: -10, max: 14 },
};

const SCENARIOS = [
    {
        key: 'daesan',
        badatimeId: '145',
        badatimeJsonPath: path.resolve(__dirname, '..', 'analysis', 'badatime_145_2010-01_2026-02.json'),
        tideStation: 'DT_0017',
        currentStations: ['07DS02', '16LTC03', '16LTC01', '16LTC02'],
    },
    {
        key: 'mohang',
        badatimeId: '134',
        badatimeJsonPath: path.resolve(__dirname, '..', 'analysis', 'badatime_134_2010-01_2026-02.json'),
        tideStation: 'DT_0031',
        currentStations: ['16LTC01', '16LTC03', '16LTC02', '07DS02'],
    },
];

// Keep aligned with app.js fallback table (for stations used in this script).
const MAX_TIDAL_RANGE = {
    DT_0017: 750,
    DT_0031: 250,
};

const MIN_TIDAL_RANGE = {
    DT_0017: 150,
    DT_0031: 55,
};

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function safeMin(arr) {
    return arr.reduce((m, v) => (v < m ? v : m), Infinity);
}

function safeMax(arr) {
    return arr.reduce((m, v) => (v > m ? v : m), -Infinity);
}

function toFinite(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

function ymdToCompact(ymd) {
    return ymd.replace(/-/g, '');
}

function compactToYmd(compact) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function toDateUTC(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function compactToDateUTC(compact) {
    return toDateUTC(compactToYmd(compact));
}

function dateToCompactUTC(dt) {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

function dateRangeCompact(fromYmd, toYmd) {
    const out = [];
    const from = toDateUTC(fromYmd);
    const to = toDateUTC(toYmd);
    for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
        out.push(dateToCompactUTC(new Date(t)));
    }
    return out;
}

function parseApiItems(json) {
    const item = json?.body?.items?.item;
    if (!item) return [];
    return Array.isArray(item) ? item : [item];
}

function extractTimeLabel(item) {
    const raw =
        item?.predcDt ??
        item?.predcTm ??
        item?.predcTime ??
        item?.tm ??
        item?.obsrvnDt ??
        '';
    const s = String(raw).trim();
    if (!s) return null;

    let m = s.match(/(\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]}`;

    m = s.match(/(?:^|\D)\d{8}(\d{2})(\d{2})(?:\d{2})?(?:\D|$)/);
    if (m) return `${m[1]}:${m[2]}`;

    m = s.match(/(\d{2})(\d{2})(?:\d{2})?$/);
    if (m) return `${m[1]}:${m[2]}`;

    return null;
}

function dedupeCurrentItems(items) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const t = extractTimeLabel(it) || `idx:${i}`;
        const s = toFinite(it?.crsp ?? it?.speed ?? it?.spd);
        const d = String(it?.crdir ?? it?.direction ?? it?.dir ?? '');
        const key = `${t}|${Number.isFinite(s) ? s.toFixed(3) : ''}|${d}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(it);
    }
    return out;
}

async function fetchJSON(url, retries = 2) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (e) {
            lastErr = e;
            if (i < retries) {
                await new Promise((r) => setTimeout(r, 250 * (i + 1)));
            }
        }
    }
    throw lastErr;
}

function calcRangeFlowPct(diff, stationCode, rangeData) {
    if (diff == null || diff <= 0) return null;
    let maxRange;
    let minRange;
    if (
        rangeData &&
        rangeData.windowRange &&
        Number.isFinite(rangeData.windowRange.max) &&
        Number.isFinite(rangeData.windowRange.min) &&
        rangeData.windowRange.max > rangeData.windowRange.min
    ) {
        maxRange = rangeData.windowRange.max;
        minRange = rangeData.windowRange.min;
    } else {
        maxRange = MAX_TIDAL_RANGE[stationCode] || 300;
        minRange = MIN_TIDAL_RANGE[stationCode] || Math.round(maxRange * 0.2);
    }
    if (maxRange <= minRange) return null;
    const pct = ((diff - minRange) / (maxRange - minRange)) * 100;
    return Math.round(clamp(pct, 0, 100));
}

function calcCrspFlowPct(todayMaxSpeed, windowMaxSpeeds) {
    if (todayMaxSpeed == null || !windowMaxSpeeds || windowMaxSpeeds.length < 3) return null;
    const wMax = safeMax(windowMaxSpeeds);
    if (wMax <= 0) return null;
    const pct = (todayMaxSpeed / wMax) * 100;
    return Math.round(clamp(pct, 0, 100));
}

function calcCorrectedFlowPct(rangePct, crspPct, weights, deltaClampCfg) {
    const hasRange = Number.isFinite(rangePct);
    const hasCrsp = Number.isFinite(crspPct);
    if (!hasRange && !hasCrsp) return null;
    if (!hasRange) return clamp(Math.round(crspPct), 0, 100);
    if (!hasCrsp) return clamp(Math.round(rangePct), 0, 100);

    const blended = (rangePct * weights.range) + (crspPct * weights.crsp);
    const delta = clamp(blended - rangePct, deltaClampCfg.min, deltaClampCfg.max);
    return clamp(Math.round(rangePct + delta), 0, 100);
}

// Share current caches across scenarios (same date range, same current stations).
const sharedCurrentDayCache = new Map();      // station:date -> dayMax
const sharedCurrentWindowCache = new Map();   // station:date -> maxSpeeds

class DataCollector {
    constructor(tideStation) {
        this.tideStation = tideStation;
        this.tideDayCache = new Map();         // date -> diff
        this.tideWindowCache = new Map();      // date -> {windowRange}
    }

    async fetchTideDayDiff(dateCompact) {
        if (this.tideDayCache.has(dateCompact)) return this.tideDayCache.get(dateCompact);

        const url = `${API_BASE}/api/tide-hilo?obsCode=${this.tideStation}&reqDate=${dateCompact}&numOfRows=50&pageNo=1`;
        const json = await fetchJSON(url);
        const items = parseApiItems(json);
        const datePrefix = compactToYmd(dateCompact);
        const sameDay = items.filter((i) => String(i?.predcDt || '').startsWith(datePrefix));

        const dayFiltered = sameDay.filter((i) => {
            const t = String(i?.predcDt || '').substring(11, 16);
            return t >= '05:00' && t <= '18:00';
        });
        const highs = dayFiltered.filter((i) => parseInt(i?.extrSe, 10) % 2 === 1 && toFinite(i?.predcTdlvVl) != null);
        const lows = dayFiltered.filter((i) => parseInt(i?.extrSe, 10) % 2 === 0 && toFinite(i?.predcTdlvVl) != null);

        let diff = null;
        if (highs.length > 0 && lows.length > 0) {
            const maxH = safeMax(highs.map((h) => parseFloat(h.predcTdlvVl)));
            const minL = safeMin(lows.map((l) => parseFloat(l.predcTdlvVl)));
            if (maxH > minL) diff = Math.round((maxH - minL) * 10) / 10;
        }

        this.tideDayCache.set(dateCompact, diff);
        return diff;
    }

    async fetchTideWindowRange(dateCompact) {
        if (this.tideWindowCache.has(dateCompact)) return this.tideWindowCache.get(dateCompact);

        const center = compactToDateUTC(dateCompact);
        const start = new Date(center.getTime() - (15 * 86400000));
        const startCompact = dateToCompactUTC(start);
        const url = `${API_BASE}/api/tide-hilo?obsCode=${this.tideStation}&reqDate=${startCompact}&numOfRows=140&pageNo=1`;
        const json = await fetchJSON(url);
        const items = parseApiItems(json);

        const byDate = new Map();
        for (const item of items) {
            const dt = String(item?.predcDt || '');
            if (!dt) continue;
            const dk = dt.substring(0, 10).replace(/-/g, '');
            if (!byDate.has(dk)) byDate.set(dk, []);
            byDate.get(dk).push(item);
        }

        const diffs = [];
        for (const dayItems of byDate.values()) {
            const filtered = dayItems.filter((i) => {
                const t = String(i?.predcDt || '').substring(11, 16);
                return t >= '05:00' && t <= '18:00';
            });
            const highs = filtered.filter((i) => parseInt(i?.extrSe, 10) % 2 === 1 && toFinite(i?.predcTdlvVl) != null);
            const lows = filtered.filter((i) => parseInt(i?.extrSe, 10) % 2 === 0 && toFinite(i?.predcTdlvVl) != null);
            if (highs.length > 0 && lows.length > 0) {
                const maxH = safeMax(highs.map((h) => parseFloat(h.predcTdlvVl)));
                const minL = safeMin(lows.map((l) => parseFloat(l.predcTdlvVl)));
                if (maxH > minL) diffs.push(Math.round((maxH - minL) * 10) / 10);
            }
        }

        let result = null;
        if (diffs.length >= 3) {
            result = {
                windowRange: {
                    min: safeMin(diffs),
                    max: safeMax(diffs),
                },
            };
        }

        this.tideWindowCache.set(dateCompact, result);
        return result;
    }

    async fetchCurrentDayMax(currentStation, dateCompact) {
        const key = `${currentStation}:${dateCompact}`;
        if (sharedCurrentDayCache.has(key)) return sharedCurrentDayCache.get(key);

        const fetchPage = async (pageNo) => {
            const url = `${API_BASE}/api/current?obsCode=${currentStation}&reqDate=${dateCompact}&numOfRows=300&pageNo=${pageNo}&min=10`;
            const json = await fetchJSON(url);
            return parseApiItems(json);
        };

        let merged = await fetchPage(1);
        let timeTagged = merged.map((i) => ({ ...i, __timeLabel: extractTimeLabel(i) }));
        let withTime = timeTagged.filter((i) => !!i.__timeLabel);
        let timeFiltered = withTime.filter((i) => i.__timeLabel >= '05:00' && i.__timeLabel <= '18:00');

        if (timeFiltered.length === 0) {
            const chunks = await Promise.all([2, 3, 4, 5].map(async (p) => {
                try {
                    return await fetchPage(p);
                } catch {
                    return [];
                }
            }));
            for (const c of chunks) {
                if (Array.isArray(c) && c.length > 0) merged.push(...c);
            }
            merged = dedupeCurrentItems(merged);
            timeTagged = merged.map((i) => ({ ...i, __timeLabel: extractTimeLabel(i) }));
            withTime = timeTagged.filter((i) => !!i.__timeLabel);
            timeFiltered = withTime.filter((i) => i.__timeLabel >= '05:00' && i.__timeLabel <= '18:00');
        }

        let filtered = [];
        if (timeFiltered.length > 0) {
            const tenMinute = timeFiltered.filter((i) => {
                const t = i.__timeLabel;
                if (!t || t.length < 5) return false;
                const mm = parseInt(t.substring(3, 5), 10);
                return Number.isFinite(mm) && (mm % 10 === 0);
            });
            filtered = tenMinute.length > 0 ? tenMinute : timeFiltered.filter((_, idx) => idx % 10 === 0);
        }

        const speeds = filtered
            .map((i) => toFinite(i?.crsp ?? i?.speed ?? i?.spd))
            .filter((v) => Number.isFinite(v));
        const dayMax = speeds.length > 0 ? safeMax(speeds) : null;

        sharedCurrentDayCache.set(key, dayMax);
        return dayMax;
    }

    async fetchCurrentWindowMaxSpeeds(currentStation, dateCompact) {
        const key = `${currentStation}:${dateCompact}`;
        if (sharedCurrentWindowCache.has(key)) return sharedCurrentWindowCache.get(key);

        const url = `${API_BASE}/api/current-window?obsCode=${currentStation}&reqDate=${dateCompact}`;
        const json = await fetchJSON(url);
        const rows = Array.isArray(json?.dailyMaxSpeeds) ? json.dailyMaxSpeeds : [];
        const maxSpeeds = rows
            .map((r) => toFinite(r?.maxCrsp ?? r?.max ?? r?.crsp))
            .filter((v) => Number.isFinite(v));

        sharedCurrentWindowCache.set(key, maxSpeeds);
        return maxSpeeds;
    }
}

function mae(predRealPairs) {
    const vals = predRealPairs.filter((x) => Number.isFinite(x.pred) && Number.isFinite(x.real));
    if (!vals.length) return null;
    const s = vals.reduce((acc, x) => acc + Math.abs(x.pred - x.real), 0);
    return s / vals.length;
}

function evaluateRows(rows, currentStation, params) {
    const rangePairs = [];
    const crspPairs = [];
    const correctedPairs = [];
    for (const r of rows) {
        if (!Number.isFinite(r.targetPct)) continue;
        const crspPct = r.currents[currentStation]?.crspPct ?? null;
        rangePairs.push({ pred: r.rangePct, real: r.targetPct });
        crspPairs.push({ pred: crspPct, real: r.targetPct });
        correctedPairs.push({
            pred: calcCorrectedFlowPct(r.rangePct, crspPct, params.weights, params.deltaClamp),
            real: r.targetPct,
        });
    }
    const n = correctedPairs.filter((x) => Number.isFinite(x.pred) && Number.isFinite(x.real)).length;
    return {
        n,
        rangeMae: mae(rangePairs),
        crspMae: mae(crspPairs),
        correctedMae: mae(correctedPairs),
    };
}

function optimizeWeights(rows, currentStation, deltaClampCfg) {
    let best = null;
    for (let wCrsp = 0; wCrsp <= 0.5; wCrsp += 0.01) {
        const wc = Math.round(wCrsp * 100) / 100;
        const params = {
            weights: { range: +(1 - wc).toFixed(2), crsp: wc },
            deltaClamp: deltaClampCfg,
        };
        const m = evaluateRows(rows, currentStation, params);
        if (!Number.isFinite(m.correctedMae)) continue;
        if (!best || m.correctedMae < best.correctedMae) {
            best = { ...m, params };
        }
    }
    return best;
}

function optimizeWeightsAndDelta(rows, currentStation) {
    let best = null;
    for (let wCrsp = 0; wCrsp <= 0.5; wCrsp += 0.01) {
        const wc = Math.round(wCrsp * 100) / 100;
        const weights = { range: +(1 - wc).toFixed(2), crsp: wc };

        for (let dMin = -15; dMin <= 0; dMin += 1) {
            for (let dMax = 8; dMax <= 20; dMax += 1) {
                if (dMax <= dMin) continue;
                const params = { weights, deltaClamp: { min: dMin, max: dMax } };
                const m = evaluateRows(rows, currentStation, params);
                if (!Number.isFinite(m.correctedMae)) continue;
                if (!best || m.correctedMae < best.correctedMae) {
                    best = { ...m, params };
                }
            }
        }
    }
    return best;
}

function filterRowsByRange(rows, fromYmd, toYmd) {
    const from = ymdToCompact(fromYmd);
    const to = ymdToCompact(toYmd);
    return rows.filter((r) => r.date >= from && r.date <= to);
}

function fmt(v, digits = 2) {
    return Number.isFinite(v) ? v.toFixed(digits) : 'N/A';
}

function summarizeRange(rows, currentStations, label) {
    const table = [];
    let bestStation = null;
    let bestMae = Infinity;

    for (const cStation of currentStations) {
        const prev = evaluateRows(rows, cStation, PREV_DEFAULT);
        const app = evaluateRows(rows, cStation, APP_DEFAULT);
        table.push({ station: cStation, prev, app });

        if (Number.isFinite(app.correctedMae) && app.correctedMae < bestMae) {
            bestMae = app.correctedMae;
            bestStation = cStation;
        }
    }

    const weightOpt = bestStation
        ? optimizeWeights(rows, bestStation, APP_DEFAULT.deltaClamp)
        : null;
    const wdOpt = bestStation
        ? optimizeWeightsAndDelta(rows, bestStation)
        : null;

    return {
        label,
        rows: rows.length,
        table,
        bestStation,
        bestDefault: bestStation ? evaluateRows(rows, bestStation, APP_DEFAULT) : null,
        bestWeightOnly: weightOpt,
        bestWeightDelta: wdOpt,
    };
}

async function buildScenarioDataset(scenario, dates) {
    if (!fs.existsSync(scenario.badatimeJsonPath)) {
        throw new Error(`badatime json not found: ${scenario.badatimeJsonPath}`);
    }
    const badatimeJson = JSON.parse(fs.readFileSync(scenario.badatimeJsonPath, 'utf8'));
    const allBadatimeRows = Array.isArray(badatimeJson?.rows) ? badatimeJson.rows : [];

    const targetMap = new Map();
    for (const r of allBadatimeRows) {
        const date = ymdToCompact(String(r.date || ''));
        if (!dates.includes(date)) continue;
        const pct = toFinite(r.flow_pct);
        if (Number.isFinite(pct)) targetMap.set(date, pct);
    }

    const collector = new DataCollector(scenario.tideStation);
    const dataset = [];

    for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const row = {
            date,
            targetPct: targetMap.has(date) ? targetMap.get(date) : null,
            diff: null,
            rangePct: null,
            currents: {},
        };

        const [diff, rangeData] = await Promise.all([
            collector.fetchTideDayDiff(date),
            collector.fetchTideWindowRange(date),
        ]);
        row.diff = diff;
        row.rangePct = calcRangeFlowPct(diff, scenario.tideStation, rangeData);

        await Promise.all(scenario.currentStations.map(async (cStation) => {
            const [dayMax, windowMaxes] = await Promise.all([
                collector.fetchCurrentDayMax(cStation, date),
                collector.fetchCurrentWindowMaxSpeeds(cStation, date),
            ]);
            row.currents[cStation] = {
                dayMaxCrsp: dayMax,
                windowMaxCrsp: windowMaxes.length > 0 ? safeMax(windowMaxes) : null,
                crspPct: calcCrspFlowPct(dayMax, windowMaxes),
            };
        }));

        dataset.push(row);
        if ((i + 1) % 7 === 0 || i === dates.length - 1) {
            console.log(`  progress ${i + 1}/${dates.length}`);
        }
    }
    return dataset;
}

function printSummary(summary) {
    console.log(`\n--- ${summary.label} ---`);
    console.log(`rows=${summary.rows}`);
    console.log('station    n   rangeMAE  crspMAE  prev(0.78/0.22)  app(0.92/0.08)  appGain(vs range)');
    for (const r of summary.table) {
        const gain = (Number.isFinite(r.app.rangeMae) && Number.isFinite(r.app.correctedMae))
            ? (r.app.rangeMae - r.app.correctedMae)
            : null;
        console.log(
            `${r.station.padEnd(9)} ${String(r.app.n).padStart(3)} ${fmt(r.app.rangeMae).padStart(9)} ${fmt(r.app.crspMae).padStart(8)} ${fmt(r.prev.correctedMae).padStart(15)} ${fmt(r.app.correctedMae).padStart(14)} ${fmt(gain).padStart(16)}`
        );
    }

    if (!summary.bestStation) {
        console.log('best station: N/A');
        return;
    }

    console.log('');
    console.log(`bestStation(appDefault)=${summary.bestStation}`);
    console.log(`appDefault correctedMAE=${fmt(summary.bestDefault.correctedMae)}`);
    if (summary.bestWeightOnly) {
        const p = summary.bestWeightOnly.params;
        console.log(
            `weight-opt  range=${fmt(p.weights.range, 2)}, crsp=${fmt(p.weights.crsp, 2)}, delta=[${p.deltaClamp.min},${p.deltaClamp.max}], mae=${fmt(summary.bestWeightOnly.correctedMae)}`
        );
    }
    if (summary.bestWeightDelta) {
        const p = summary.bestWeightDelta.params;
        console.log(
            `wd-opt      range=${fmt(p.weights.range, 2)}, crsp=${fmt(p.weights.crsp, 2)}, delta=[${p.deltaClamp.min},${p.deltaClamp.max}], mae=${fmt(summary.bestWeightDelta.correctedMae)}`
        );
    }
}

async function main() {
    const dates = dateRangeCompact(FULL_RANGE.from, FULL_RANGE.to);
    const allResults = {
        generatedAt: new Date().toISOString(),
        fullRange: FULL_RANGE,
        monthRange: MONTH_RANGE,
        appDefault: APP_DEFAULT,
        prevDefault: PREV_DEFAULT,
        scenarios: {},
    };

    console.log('=== Advanced Corrected Flow Simulation ===');
    console.log(`fullRange=${FULL_RANGE.from}..${FULL_RANGE.to} (${dates.length} days)`);
    console.log(`monthRange=${MONTH_RANGE.from}..${MONTH_RANGE.to}`);

    for (const scenario of SCENARIOS) {
        console.log(`\n### Scenario: ${scenario.key} (badatime=${scenario.badatimeId}, tide=${scenario.tideStation})`);
        console.log(`currentStations=${scenario.currentStations.join(', ')}`);
        const dataset = await buildScenarioDataset(scenario, dates);

        const fullSummary = summarizeRange(dataset, scenario.currentStations, '3-Month Window');
        const monthRows = filterRowsByRange(dataset, MONTH_RANGE.from, MONTH_RANGE.to);
        const monthSummary = summarizeRange(monthRows, scenario.currentStations, '1-Month Window');

        printSummary(monthSummary);
        printSummary(fullSummary);

        allResults.scenarios[scenario.key] = {
            config: {
                badatimeId: scenario.badatimeId,
                tideStation: scenario.tideStation,
                currentStations: scenario.currentStations,
            },
            monthSummary,
            fullSummary,
        };
    }

    const outPath = path.resolve(
        __dirname,
        '..',
        'analysis',
        `corrected_flow_advanced_${FULL_RANGE.from.replace(/-/g, '')}_${FULL_RANGE.to.replace(/-/g, '')}.json`
    );
    fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2), 'utf8');
    console.log(`\nsaved: ${outPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

