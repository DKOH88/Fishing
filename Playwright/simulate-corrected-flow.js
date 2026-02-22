/**
 * Simulate tide-flow correction model against badatime reference.
 *
 * Scope:
 * - 3-month backtest + embedded 1-month slice
 * - current-station sensitivity
 * - weight optimization for corrected model
 *
 * Usage:
 *   node Playwright/simulate-corrected-flow.js
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://tide-api-proxy.odk297.workers.dev';

const CONFIG = {
    badatimeId: '145',
    badatimeJsonPath: path.resolve(__dirname, '..', 'analysis', 'badatime_145_2010-01_2026-02.json'),
    tideStation: 'DT_0017', // Daesan
    currentStations: ['07DS02', '16LTC03', '16LTC01', '16LTC02'],
    fullRange: { from: '2025-10-01', to: '2025-12-31' },   // 3 months
    monthRange: { from: '2025-11-01', to: '2025-11-30' },  // 1 month
    defaultWeights: { range: 0.78, crsp: 0.22 },
    deltaClamp: { min: -10, max: 14 },
};

const MAX_TIDAL_RANGE = {
    DT_0017: 750, // Daesan
    DT_0031: 250, // Mohang
    DT_0025: 750, // Boryeong
};

const MIN_TIDAL_RANGE = {
    DT_0017: 150, // Daesan
    DT_0031: 55,  // Mohang
    DT_0025: 150, // Boryeong
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

function calcCorrectedFlowPct(
    rangePct,
    crspPct,
    weights = CONFIG.defaultWeights,
    deltaClamp = CONFIG.deltaClamp
) {
    const hasRange = Number.isFinite(rangePct);
    const hasCrsp = Number.isFinite(crspPct);
    if (!hasRange && !hasCrsp) return null;
    if (!hasRange) return clamp(Math.round(crspPct), 0, 100);
    if (!hasCrsp) return clamp(Math.round(rangePct), 0, 100);

    const blended = (rangePct * weights.range) + (crspPct * weights.crsp);
    const delta = clamp(blended - rangePct, deltaClamp.min, deltaClamp.max);
    return clamp(Math.round(rangePct + delta), 0, 100);
}

class DataCollector {
    constructor(tideStation) {
        this.tideStation = tideStation;
        this.tideDayCache = new Map();         // date -> diff
        this.tideWindowCache = new Map();      // date -> {windowRange}
        this.currentDayCache = new Map();      // station:date -> dayMax
        this.currentWindowCache = new Map();   // station:date -> [maxSpeeds]
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
        if (this.currentDayCache.has(key)) return this.currentDayCache.get(key);

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

        this.currentDayCache.set(key, dayMax);
        return dayMax;
    }

    async fetchCurrentWindowMaxSpeeds(currentStation, dateCompact) {
        const key = `${currentStation}:${dateCompact}`;
        if (this.currentWindowCache.has(key)) return this.currentWindowCache.get(key);

        const url = `${API_BASE}/api/current-window?obsCode=${currentStation}&reqDate=${dateCompact}`;
        const json = await fetchJSON(url);
        const rows = Array.isArray(json?.dailyMaxSpeeds) ? json.dailyMaxSpeeds : [];
        const maxSpeeds = rows
            .map((r) => toFinite(r?.maxCrsp ?? r?.max ?? r?.crsp))
            .filter((v) => Number.isFinite(v));

        this.currentWindowCache.set(key, maxSpeeds);
        return maxSpeeds;
    }
}

function mae(predRealPairs) {
    const vals = predRealPairs.filter((x) => Number.isFinite(x.pred) && Number.isFinite(x.real));
    if (!vals.length) return null;
    const s = vals.reduce((acc, x) => acc + Math.abs(x.pred - x.real), 0);
    return s / vals.length;
}

function evaluateRows(rows, currentStation, weights = CONFIG.defaultWeights) {
    const rangePairs = [];
    const crspPairs = [];
    const correctedPairs = [];

    for (const r of rows) {
        if (!Number.isFinite(r.targetPct)) continue;
        rangePairs.push({ pred: r.rangePct, real: r.targetPct });

        const crspPct = r.currents[currentStation]?.crspPct ?? null;
        crspPairs.push({ pred: crspPct, real: r.targetPct });
        correctedPairs.push({
            pred: calcCorrectedFlowPct(r.rangePct, crspPct, weights, CONFIG.deltaClamp),
            real: r.targetPct,
        });
    }

    const rangeMae = mae(rangePairs);
    const crspMae = mae(crspPairs);
    const correctedMae = mae(correctedPairs);
    const n = correctedPairs.filter((x) => Number.isFinite(x.pred) && Number.isFinite(x.real)).length;

    return { n, rangeMae, crspMae, correctedMae };
}

function optimizeWeights(rows, currentStation) {
    let best = null;
    for (let wCrsp = 0; wCrsp <= 0.5; wCrsp += 0.01) {
        const wC = Math.round(wCrsp * 100) / 100;
        const weights = { range: +(1 - wC).toFixed(2), crsp: wC };
        const m = evaluateRows(rows, currentStation, weights);
        if (!Number.isFinite(m.correctedMae)) continue;
        if (!best || m.correctedMae < best.correctedMae) {
            best = { ...m, weights };
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

async function main() {
    console.log('=== Corrected Flow Simulation ===');
    console.log(`badatimeId=${CONFIG.badatimeId}, tideStation=${CONFIG.tideStation}`);
    console.log(`fullRange=${CONFIG.fullRange.from}..${CONFIG.fullRange.to}`);
    console.log(`monthRange=${CONFIG.monthRange.from}..${CONFIG.monthRange.to}`);
    console.log(`currentStations=${CONFIG.currentStations.join(', ')}`);
    console.log('');

    if (!fs.existsSync(CONFIG.badatimeJsonPath)) {
        throw new Error(`badatime json not found: ${CONFIG.badatimeJsonPath}`);
    }
    const badatimeJson = JSON.parse(fs.readFileSync(CONFIG.badatimeJsonPath, 'utf8'));
    const allBadatimeRows = Array.isArray(badatimeJson?.rows) ? badatimeJson.rows : [];

    const fullDates = dateRangeCompact(CONFIG.fullRange.from, CONFIG.fullRange.to);
    const targetMap = new Map();
    for (const r of allBadatimeRows) {
        const date = ymdToCompact(String(r.date || ''));
        if (!date || !fullDates.includes(date)) continue;
        const pct = toFinite(r.flow_pct);
        if (Number.isFinite(pct)) targetMap.set(date, pct);
    }

    const collector = new DataCollector(CONFIG.tideStation);
    const dataset = [];

    for (let i = 0; i < fullDates.length; i++) {
        const date = fullDates[i];
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
        row.rangePct = calcRangeFlowPct(diff, CONFIG.tideStation, rangeData);

        await Promise.all(CONFIG.currentStations.map(async (cStation) => {
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
        if ((i + 1) % 7 === 0 || i === fullDates.length - 1) {
            console.log(`progress ${i + 1}/${fullDates.length}`);
        }
    }

    const monthRows = filterRowsByRange(dataset, CONFIG.monthRange.from, CONFIG.monthRange.to);
    const fullRows = dataset;

    function printSection(title, rows) {
        console.log('');
        console.log(`--- ${title} ---`);
        console.log(`rows=${rows.length}`);
        console.log('station    n   rangeMAE  crspMAE  correctedMAE  gain(vs range)');

        let bestStation = null;
        let bestMae = Infinity;
        for (const cStation of CONFIG.currentStations) {
            const m = evaluateRows(rows, cStation, CONFIG.defaultWeights);
            const gain = (Number.isFinite(m.rangeMae) && Number.isFinite(m.correctedMae))
                ? (m.rangeMae - m.correctedMae)
                : null;
            console.log(
                `${cStation.padEnd(9)} ${String(m.n).padStart(3)} ${fmt(m.rangeMae).padStart(9)} ${fmt(m.crspMae).padStart(8)} ${fmt(m.correctedMae).padStart(13)} ${fmt(gain).padStart(14)}`
            );
            if (Number.isFinite(m.correctedMae) && m.correctedMae < bestMae) {
                bestMae = m.correctedMae;
                bestStation = cStation;
            }
        }

        if (!bestStation) {
            console.log('no valid station result');
            return null;
        }

        const bestDefault = evaluateRows(rows, bestStation, CONFIG.defaultWeights);
        const bestOpt = optimizeWeights(rows, bestStation);
        console.log('');
        console.log(`bestStation(default)=${bestStation}`);
        console.log(
            `default weights range=${CONFIG.defaultWeights.range}, crsp=${CONFIG.defaultWeights.crsp}, correctedMAE=${fmt(bestDefault.correctedMae)}`
        );
        if (bestOpt) {
            const deltaMae = bestDefault.correctedMae - bestOpt.correctedMae;
            console.log(
                `optimized weights range=${bestOpt.weights.range}, crsp=${bestOpt.weights.crsp}, correctedMAE=${fmt(bestOpt.correctedMae)}, improvement=${fmt(deltaMae)}`
            );
        } else {
            console.log('optimized weights: unavailable');
        }

        return { bestStation, bestDefault, bestOpt };
    }

    const resMonth = printSection('1-Month Window', monthRows);
    const resFull = printSection('3-Month Window', fullRows);

    const out = {
        generatedAt: new Date().toISOString(),
        config: CONFIG,
        summary: {
            month: resMonth,
            full: resFull,
        },
    };
    const outPath = path.resolve(
        __dirname,
        '..',
        'analysis',
        `corrected_flow_sim_${CONFIG.badatimeId}_${CONFIG.fullRange.from.replace(/-/g, '')}_${CONFIG.fullRange.to.replace(/-/g, '')}.json`
    );
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.log('');
    console.log(`saved: ${outPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

