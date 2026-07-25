// Build-time precompute step. Reads every data*.json export in the project
// root, normalizes/aggregates it the same way the old client-side script.js
// did, and writes a single stats.json for the browser to fetch and render.
//
// Run via `npm run build`. Re-run any time a data*.json file is added.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_FILE_PATTERN = /^data\d+\.json$/i;
const OUTPUT_FILE = path.join(ROOT, "stats.json");

const MOBILE_PLATFORMS = new Set(["ios", "android"]);
const DESKTOP_PLATFORMS = new Set(["windows", "osx", "mac", "macos", "linux"]);
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ---------- normalization (ported from the old client-side script.js) ----------

function normalizeTrackTitle(name) {
  if (!name) return "";
  let s = name.trim();
  s = s.replace(/\s*\([^)]*\)/g, ""); // (Live), (Remastered 2011), etc.
  s = s.split(" - ")[0]; // drop " - Version Revisited" style suffixes
  return s.trim();
}

function findDataFiles() {
  return fs
    .readdirSync(ROOT)
    .filter((f) => DATA_FILE_PATTERN.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
}

// Converts one raw export record into a normalized row.
// Intentionally never reads r.ip_addr (or copies `r` itself) -- only the
// specific fields below are pulled out, so PII from the export never
// reaches the row objects that stats.json is built from.
function recordToRow(r) {
  const ts = new Date(r.ts);
  const year = ts.getUTCFullYear();
  const minutes = (r.ms_played || 0) / 60000;

  const trackName = r.master_metadata_track_name || "";
  const artistName = r.master_metadata_album_artist_name || "";
  const trackTitleNorm = normalizeTrackTitle(trackName);
  const artistNorm = artistName.toLowerCase().trim();
  const trackArtistKey = trackTitleNorm.toLowerCase().trim() + " — " + artistNorm;

  return {
    ts,
    year,
    localDate: ts.toLocaleDateString("en-CA"), // e.g. 2025-09-17 (local)
    localHour: ts.getHours(), // local hour
    minutes,
    msPlayed: r.ms_played || 0,
    isMusic: !!trackName,
    trackName,
    artistName,
    trackTitleNorm,
    trackArtistKey,
    country: r.conn_country || "??",
    platform: (r.platform || "").toLowerCase(),
    reasonEnd: r.reason_end || "",
    shuffle: !!r.shuffle,
  };
}

function loadAllRows() {
  const files = findDataFiles();
  if (!files.length) {
    throw new Error(
      "No data*.json files found in project root (expected files matching data\\d+.json)."
    );
  }

  const rows = [];
  for (const filename of files) {
    const fullPath = path.join(ROOT, filename);
    const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    const records = Array.isArray(raw) ? raw : raw.data ?? [];
    console.log(`Loaded ${records.length} records from ${filename}`);
    for (const r of records) {
      rows.push(recordToRow(r));
    }
  }
  return rows;
}

function filterValidRows(rows) {
  return rows.filter(
    (r) => r.isMusic && r.msPlayed > 0 && r.trackName && r.artistName && r.year
  );
}

function groupRowsByYear(rows) {
  const byYear = new Map();
  for (const r of rows) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r);
  }
  return byYear;
}

// ---------- all-time ----------

function computeFirstListenByArtist(rows) {
  const map = new Map(); // artistName -> { artist, ts }
  for (const r of rows) {
    const existing = map.get(r.artistName);
    if (!existing || r.ts < existing.ts) {
      map.set(r.artistName, { artist: r.artistName, ts: r.ts });
    }
  }
  return map;
}

// ---------- new per-year stats ----------

function computeLongestStreak(rows) {
  const uniqueDates = Array.from(new Set(rows.map((r) => r.localDate))).sort();
  if (!uniqueDates.length) return { days: 0, startDate: null, endDate: null };

  let bestLen = 1;
  let bestStart = uniqueDates[0];
  let bestEnd = uniqueDates[0];
  let curLen = 1;
  let curStart = uniqueDates[0];

  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = new Date(uniqueDates[i - 1] + "T00:00:00Z");
    const cur = new Date(uniqueDates[i] + "T00:00:00Z");
    const diffDays = Math.round((cur - prev) / 86400000);

    if (diffDays === 1) {
      curLen += 1;
    } else {
      curLen = 1;
      curStart = uniqueDates[i];
    }

    if (curLen > bestLen) {
      bestLen = curLen;
      bestStart = curStart;
      bestEnd = uniqueDates[i];
    }
  }

  return { days: bestLen, startDate: bestStart, endDate: bestEnd };
}

function computeMostObsessedDay(rows) {
  const counts = new Map(); // "date|trackArtistKey" -> entry
  for (const r of rows) {
    const key = r.localDate + "|" + r.trackArtistKey;
    if (!counts.has(key)) {
      counts.set(key, {
        count: 0,
        date: r.localDate,
        song: r.trackTitleNorm || r.trackName,
        artist: r.artistName,
      });
    }
    counts.get(key).count += 1;
  }

  let best = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best) return null;
  return { song: best.song, artist: best.artist, date: best.date, playCount: best.count };
}

// Per-year: fixed Jan-Dec buckets for that single year.
function computeYearDiscoveryByMonth(year, firstListenMap) {
  const counts = new Array(12).fill(0);
  for (const entry of firstListenMap.values()) {
    if (entry.ts.getUTCFullYear() === year) {
      counts[entry.ts.getUTCMonth()] += 1;
    }
  }
  return counts.map((count, idx) => ({ label: MONTH_NAMES[idx], count }));
}

// All-time: one bucket per actual calendar month across the whole history
// (e.g. "July 2024", "August 2024", ...), not a repeating 12-month cycle.
function computeAllTimeDiscoveryTimeline(firstListenMap) {
  const counts = new Map(); // "YYYY-MM" -> count
  for (const entry of firstListenMap.values()) {
    const key = `${entry.ts.getUTCFullYear()}-${String(entry.ts.getUTCMonth() + 1).padStart(2, "0")}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, count]) => {
      const [y, m] = key.split("-");
      return { label: `${MONTH_NAMES[Number(m) - 1]} ${y}`, count };
    });
}

function computeSkipRatePercent(rows) {
  if (!rows.length) return 0;
  const skipped = rows.filter((r) => r.reasonEnd === "fwdbtn").length;
  return (skipped / rows.length) * 100;
}

function computeShuffleRatio(rows) {
  if (!rows.length) return { shufflePercent: 0, onDemandPercent: 0 };
  const shuffled = rows.filter((r) => r.shuffle).length;
  const shufflePercent = (shuffled / rows.length) * 100;
  return { shufflePercent, onDemandPercent: 100 - shufflePercent };
}

function categorizePlatform(platform) {
  if (MOBILE_PLATFORMS.has(platform)) return "mobile";
  if (DESKTOP_PLATFORMS.has(platform)) return "desktop";
  return "other";
}

function computePlatformBreakdown(rows) {
  const counts = { mobile: 0, desktop: 0, other: 0 };
  for (const r of rows) counts[categorizePlatform(r.platform)] += 1;
  const total = rows.length || 1;
  return {
    mobile: (counts.mobile / total) * 100,
    desktop: (counts.desktop / total) * 100,
    other: (counts.other / total) * 100,
  };
}

function computeHourHeatmap(rows) {
  const minutesByHour = new Array(24).fill(0);
  for (const r of rows) minutesByHour[r.localHour] += r.minutes;
  const totalMinutes = minutesByHour.reduce((a, b) => a + b, 0) || 1;

  let peakHour = 0;
  for (let h = 1; h < 24; h++) {
    if (minutesByHour[h] > minutesByHour[peakHour]) peakHour = h;
  }

  return {
    heatmap: minutesByHour.map((minutes, hour) => ({
      hour,
      minutes,
      percent: (minutes / totalMinutes) * 100,
    })),
    peakHour,
  };
}

// ---------- core stats (shared by per-year and all-time) ----------

// Everything that just needs "a set of rows" -- no notion of which year(s)
// they came from. Used both per-year (one year's rows) and all-time (every
// valid row combined), so e.g. "top songs"/"longest streak"/"platform
// breakdown" all have a real all-time equivalent, not just a per-year one.
function computeCoreStats(rows) {
  const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0);
  const uniqueSongKeys = new Set(rows.map((r) => r.trackArtistKey));
  const uniqueArtists = new Set(rows.map((r) => r.artistName));

  const minutesByDate = new Map();
  for (const r of rows) {
    minutesByDate.set(r.localDate, (minutesByDate.get(r.localDate) || 0) + r.minutes);
  }
  const topDates = Array.from(minutesByDate.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([date, minutes]) => ({ date, minutes }));

  const songsMap = new Map();
  for (const r of rows) {
    const key = r.trackArtistKey;
    if (!songsMap.has(key)) {
      songsMap.set(key, {
        key,
        normalizedTitle: r.trackTitleNorm || r.trackName,
        displayArtist: r.artistName,
        totalMinutes: 0,
        playEvents: 0,
      });
    }
    const s = songsMap.get(key);
    s.totalMinutes += r.minutes;
    s.playEvents += 1;
  }
  const topSongs = Array.from(songsMap.values())
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
    .slice(0, 100);

  const artistMap = new Map();
  for (const r of rows) {
    if (!artistMap.has(r.artistName)) {
      artistMap.set(r.artistName, {
        artist: r.artistName,
        totalMinutes: 0,
        playEvents: 0,
        trackKeys: new Set(),
      });
    }
    const a = artistMap.get(r.artistName);
    a.totalMinutes += r.minutes;
    a.playEvents += 1;
    a.trackKeys.add(r.trackArtistKey);
  }
  const topArtists = Array.from(artistMap.values())
    .map((a) => ({
      artist: a.artist,
      totalMinutes: a.totalMinutes,
      playEvents: a.playEvents,
      uniqueSongs: a.trackKeys.size,
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
    .slice(0, 20);

  const minutesByCountry = new Map();
  for (const r of rows) {
    minutesByCountry.set(r.country, (minutesByCountry.get(r.country) || 0) + r.minutes);
  }
  const byCountry = Array.from(minutesByCountry.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([country, minutes]) => ({ country, minutes }));

  const { heatmap: hourHeatmap, peakHour } = computeHourHeatmap(rows);

  return {
    totalMinutes,
    uniqueSongCount: uniqueSongKeys.size,
    uniqueArtistCount: uniqueArtists.size,
    topDates,
    topSongs,
    topArtists,
    byCountry,
    hourHeatmap,
    peakHour,
    longestStreak: computeLongestStreak(rows),
    mostObsessedDay: computeMostObsessedDay(rows),
    skipRatePercent: computeSkipRatePercent(rows),
    shuffleRatio: computeShuffleRatio(rows),
    platformBreakdown: computePlatformBreakdown(rows),
  };
}

function computeStatsForYear(rows, year, firstListenMap) {
  if (!rows || !rows.length) return null;

  const discoveryByMonth = computeYearDiscoveryByMonth(year, firstListenMap);
  const newArtistCount = discoveryByMonth.reduce((sum, m) => sum + m.count, 0);

  return {
    year,
    ...computeCoreStats(rows),
    discoveryByMonth,
    newArtistCount,
  };
}

// ---------- all-time (not year-scoped) ----------

function computeAllTime(rows, firstListenMap) {
  const firstListenedByArtist = Array.from(firstListenMap.values())
    .map((e) => ({
      artist: e.artist,
      firstTs: e.ts.toISOString(),
      firstDate: e.ts.toLocaleDateString("en-CA"),
    }))
    .sort((a, b) => new Date(a.firstTs) - new Date(b.firstTs));

  return {
    ...computeCoreStats(rows),
    discoveryByMonth: computeAllTimeDiscoveryTimeline(firstListenMap),
    firstListenedByArtist,
  };
}

// ---------- main ----------

function main() {
  console.log("Reading data files...");
  const allRows = loadAllRows();
  console.log(`Total raw records loaded: ${allRows.length}`);

  const validRows = filterValidRows(allRows);
  console.log(`Valid music-play rows: ${validRows.length}`);

  if (!validRows.length) {
    throw new Error("No valid music listening rows found across data files.");
  }

  const firstListenMap = computeFirstListenByArtist(validRows);
  const grouped = groupRowsByYear(validRows);
  const years = Array.from(grouped.keys()).sort((a, b) => b - a);

  const byYear = {};
  for (const year of years) {
    const stats = computeStatsForYear(grouped.get(year), year, firstListenMap);
    if (stats) byYear[year] = stats;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    years: Object.keys(byYear)
      .map(Number)
      .sort((a, b) => b - a),
    byYear,
    allTime: computeAllTime(validRows, firstListenMap),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`Years: ${output.years.join(", ")}`);
}

main();
