// Shared pure-computation library: every stats function that just needs "a
// set of rows" (or a couple of small derived maps), with no file I/O and no
// dependency on being run in Node. Used two ways:
//   - build-stats.js (Node, require()'d) reads data*.json off disk, then
//     calls into here to turn rows into stats.json / search-index.json.
//   - upload-worker.js (browser Worker, importScripts()'d) unzips an
//     uploaded Spotify export, then calls the exact same functions here to
//     turn its rows into the same shape, entirely client-side.
// Keeping this logic in one place means the built-in dataset and any
// visitor's uploaded data are guaranteed to be aggregated identically.
"use strict";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Ordered substring rules against the lowercased `platform` string. Real
// exports mix in dozens of raw variants (e.g. "Windows 10 (10.0.19044; x64;
// AppX)", "web_player windows 10;chrome 86.0.4240.111;desktop",
// "Partner SCEI sony_tv;ps4;...", "not_applicable") -- this buckets them
// into a small, chart-friendly set instead of leaving nearly everything to
// fall through as "other". Order matters: more specific patterns (game
// console, cast device) are checked before generic OS substrings so e.g. a
// "Partner ... sony_tv;ps4" string lands in Game Console, not Other.
const PLATFORM_RULES = [
  { category: "Game Console", patterns: ["playstation", "xbox", "ps3", "ps4", "ps5"] },
  { category: "Cast / Smart Speaker", patterns: ["cast_voice", "chromecast", "google_home", "sonos", "partner"] },
  { category: "iOS", patterns: ["ios", "iphone", "ipad"] },
  { category: "Android", patterns: ["android"] },
  { category: "Windows", patterns: ["windows"] },
  { category: "Mac", patterns: ["osx", "mac os", "macos", "mac"] },
  { category: "Linux", patterns: ["linux"] },
  { category: "Web", patterns: ["web_player", "web"] },
  { category: "TV", patterns: ["tv"] },
];

function categorizePlatform(platform) {
  const p = (platform || "").toLowerCase();
  for (const rule of PLATFORM_RULES) {
    if (rule.patterns.some((pat) => p.includes(pat))) return rule.category;
  }
  return "Other";
}

// ---------- normalization ----------

function normalizeTrackTitle(name) {
  if (!name) return "";
  let s = name.trim();
  s = s.replace(/\s*\([^)]*\)/g, ""); // (Live), (Remastered 2011), etc.
  s = s.split(" - ")[0]; // drop " - Version Revisited" style suffixes
  return s.trim();
}

// Converts one raw export record into a normalized row.
// Intentionally never reads r.ip_addr (or copies `r` itself) -- only the
// specific fields below are pulled out, so PII from the export never
// reaches the row objects that stats.json/search-index.json (or an
// uploaded file's in-browser stats) are built from.
function recordToRow(r) {
  const ts = new Date(r.ts);
  const year = ts.getUTCFullYear();
  const minutes = (r.ms_played || 0) / 60000;

  const trackName = r.master_metadata_track_name || "";
  const artistName = r.master_metadata_album_artist_name || "";
  const trackTitleNorm = normalizeTrackTitle(trackName);
  const artistNorm = artistName.toLowerCase().trim();
  const trackArtistKey = trackTitleNorm.toLowerCase().trim() + " — " + artistNorm;

  // Extended-streaming-history exports mix podcast episodes and audiobook
  // chapters in with music plays. Those rows carry episode_name /
  // audiobook_title instead, and always leave master_metadata_track_name
  // (usually also master_metadata_album_artist_name) null. Explicitly
  // requiring BOTH fields here -- not just one -- is what excludes them;
  // this is checked once, by name, rather than left as an incidental
  // side effect of other truthy checks downstream.
  const isMusicTrack = Boolean(r.master_metadata_track_name) && Boolean(r.master_metadata_album_artist_name);

  return {
    ts,
    year,
    localDate: ts.toLocaleDateString("en-CA"), // e.g. 2025-09-17 (local)
    localHour: ts.getHours(), // local hour
    minutes,
    msPlayed: r.ms_played || 0,
    isMusicTrack,
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

// Explicit music-only filter: r.isMusicTrack (set in recordToRow) is what
// drops podcast/audiobook rows, by requiring both master_metadata_track_name
// and master_metadata_album_artist_name to be present. The other two
// conditions drop zero-length plays and rows with an unparseable timestamp.
function filterValidRows(rows) {
  return rows.filter((r) => r.isMusicTrack && r.msPlayed > 0 && r.year);
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

// ---------- per-year stats ----------

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

// Returns { [category]: percent, ... } -- however many categories
// categorizePlatform actually produced for this row set, not a fixed shape.
// Sorted descending so the biggest category renders first.
function computePlatformBreakdown(rows) {
  const counts = new Map();
  for (const r of rows) {
    const category = categorizePlatform(r.platform);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const total = rows.length || 1;
  const entries = Array.from(counts.entries())
    .map(([category, count]) => [category, (count / total) * 100])
    .sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries);
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

// ---------- small reusable row-set helpers ----------
// (Used both by computeCoreStats below, and by the per-entity search index
// -- anything here just needs "a set of rows", no notion of which entity or
// year(s) they came from.)

function computeTopDates(rows, limit) {
  const minutesByDate = new Map();
  for (const r of rows) {
    minutesByDate.set(r.localDate, (minutesByDate.get(r.localDate) || 0) + r.minutes);
  }
  return Array.from(minutesByDate.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([date, minutes]) => ({ date, minutes }));
}

function computeByCountry(rows, limit) {
  const minutesByCountry = new Map();
  for (const r of rows) {
    minutesByCountry.set(r.country, (minutesByCountry.get(r.country) || 0) + r.minutes);
  }
  return Array.from(minutesByCountry.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([country, minutes]) => ({ country, minutes }));
}

// Real calendar-month timeline (e.g. "July 2024", "August 2024", ...), not a
// repeating 12-month cycle -- so it works unmodified whether `rows` spans one
// year or the whole history: a single year just produces up to 12 entries.
function computeMonthlyTrend(rows) {
  const minutesByMonth = new Map(); // "YYYY-MM" -> minutes
  for (const r of rows) {
    const key = `${r.ts.getUTCFullYear()}-${String(r.ts.getUTCMonth() + 1).padStart(2, "0")}`;
    minutesByMonth.set(key, (minutesByMonth.get(key) || 0) + r.minutes);
  }
  return Array.from(minutesByMonth.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, minutes]) => {
      const [y, m] = key.split("-");
      return { label: `${MONTH_NAMES[Number(m) - 1]} ${y}`, minutes };
    });
}

function firstLastDates(rows) {
  let first = rows[0].ts;
  let last = rows[0].ts;
  for (const r of rows) {
    if (r.ts < first) first = r.ts;
    if (r.ts > last) last = r.ts;
  }
  return {
    firstDate: first.toLocaleDateString("en-CA"),
    lastDate: last.toLocaleDateString("en-CA"),
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

  const topDates = computeTopDates(rows, 5);

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

  const byCountry = computeByCountry(rows, 10);

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

// Top-level orchestration: valid rows in, the exact { years, byYear, allTime }
// shape out (everything stats.json has except generatedAt). Used by
// build-stats.js (Node, from disk files) and upload-worker.js (browser, from
// an uploaded zip) so neither has to duplicate this grouping/looping.
function computeFullStats(validRows) {
  const firstListenMap = computeFirstListenByArtist(validRows);
  const grouped = groupRowsByYear(validRows);
  const years = Array.from(grouped.keys()).sort((a, b) => b - a);

  const byYear = {};
  for (const year of years) {
    const stats = computeStatsForYear(grouped.get(year), year, firstListenMap);
    if (stats) byYear[year] = stats;
  }

  return {
    years: Object.keys(byYear)
      .map(Number)
      .sort((a, b) => b - a),
    byYear,
    allTime: computeAllTime(validRows, firstListenMap),
  };
}

// ---------- search index (per-artist / per-song, every scope) ----------
// Powers the Search tab: "ALL information" about one artist or song, for
// All Time or any single year.

// Rounds to 2 decimal places -- plenty of precision for minutes/percentages
// the UI only ever displays with toFixed(1-2), and it keeps search-index.json
// (tens of thousands of small per-entity profiles) from bloating with long
// floating-point tails.
function round2(n) {
  return Math.round(n * 100) / 100;
}

function roundMinutesList(list) {
  return list.map((item) => ({ ...item, minutes: round2(item.minutes) }));
}

function roundPercentMap(map) {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, round2(v)]));
}

// Full profile for one entity within one scope (a single year's rows, or
// every valid row for "all"). Shares the same row-set helpers as
// computeCoreStats above, just without the top-N truncation those apply.
function buildEntityProfile(rows) {
  const { firstDate, lastDate } = firstLastDates(rows);
  const shuffleRatio = computeShuffleRatio(rows);
  return {
    totalMinutes: round2(rows.reduce((sum, r) => sum + r.minutes, 0)),
    playEvents: rows.length,
    firstDate,
    lastDate,
    topDays: roundMinutesList(computeTopDates(rows, 5)),
    monthlyTrend: roundMinutesList(computeMonthlyTrend(rows)),
    byCountry: roundMinutesList(computeByCountry(rows, 5)),
    platformBreakdown: roundPercentMap(computePlatformBreakdown(rows)),
    skipRatePercent: round2(computeSkipRatePercent(rows)),
    shuffleRatio: {
      shufflePercent: round2(shuffleRatio.shufflePercent),
      onDemandPercent: round2(shuffleRatio.onDemandPercent),
    },
  };
}

// Groups `rows` by `keyFn`, ranks the groups by total minutes desc, and
// returns them as [{ key, rows, totalMinutes, rank, totalInScope }] --
// shared ranking logic for both artists and songs within a scope.
function rankGroupsByMinutes(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const ranked = Array.from(groups.entries()).map(([key, groupRows]) => ({
    key,
    rows: groupRows,
    totalMinutes: groupRows.reduce((sum, r) => sum + r.minutes, 0),
  }));
  ranked.sort((a, b) => b.totalMinutes - a.totalMinutes);

  const totalInScope = ranked.length;
  return ranked.map((g, idx) => ({
    key: g.key,
    rows: g.rows,
    totalMinutes: g.totalMinutes,
    rank: idx + 1,
    totalInScope,
  }));
}

function buildSearchIndex(validRows) {
  // scopeKey "all" plus one per year every row belongs to both.
  const scopes = new Map(); // scopeKey -> rows[]
  for (const r of validRows) {
    const yearKey = String(r.year);
    if (!scopes.has("all")) scopes.set("all", []);
    if (!scopes.has(yearKey)) scopes.set(yearKey, []);
    scopes.get("all").push(r);
    scopes.get(yearKey).push(r);
  }

  const artists = new Map(); // artistName -> { name, byScope: {...} }
  const songs = new Map(); // trackArtistKey -> { key, title, artist, byScope: {...} }

  for (const [scopeKey, scopeRows] of scopes) {
    const artistGroups = rankGroupsByMinutes(scopeRows, (r) => r.artistName);
    const songGroups = rankGroupsByMinutes(scopeRows, (r) => r.trackArtistKey);

    // Song groups, keyed for quick lookup when attaching each artist's own
    // top-songs list below.
    const songGroupsByKey = new Map(songGroups.map((g) => [g.key, g]));

    for (const group of artistGroups) {
      if (!artists.has(group.key)) artists.set(group.key, { name: group.key, byScope: {} });

      const artistSongKeys = new Set(group.rows.map((r) => r.trackArtistKey));
      const ownSongs = Array.from(artistSongKeys)
        .map((key) => songGroupsByKey.get(key))
        .sort((a, b) => b.totalMinutes - a.totalMinutes)
        .map((g) => ({
          title: g.rows[0].trackTitleNorm || g.rows[0].trackName,
          totalMinutes: round2(g.totalMinutes),
          playEvents: g.rows.length,
        }));

      artists.get(group.key).byScope[scopeKey] = {
        ...buildEntityProfile(group.rows),
        rank: group.rank,
        totalInScope: group.totalInScope,
        uniqueSongs: artistSongKeys.size,
        songs: ownSongs,
      };
    }

    for (const group of songGroups) {
      if (!songs.has(group.key)) {
        songs.set(group.key, {
          key: group.key,
          title: group.rows[0].trackTitleNorm || group.rows[0].trackName,
          artist: group.rows[0].artistName,
          byScope: {},
        });
      }

      songs.get(group.key).byScope[scopeKey] = {
        ...buildEntityProfile(group.rows),
        rank: group.rank,
        totalInScope: group.totalInScope,
      };
    }
  }

  return {
    artists: Array.from(artists.values()),
    songs: Array.from(songs.values()),
  };
}

// ---------- dual-mode export (Node require() / browser importScripts()) ----------

const StatsLib = {
  MONTH_NAMES,
  categorizePlatform,
  normalizeTrackTitle,
  recordToRow,
  filterValidRows,
  groupRowsByYear,
  computeFirstListenByArtist,
  computeLongestStreak,
  computeMostObsessedDay,
  computeYearDiscoveryByMonth,
  computeAllTimeDiscoveryTimeline,
  computeSkipRatePercent,
  computeShuffleRatio,
  computePlatformBreakdown,
  computeHourHeatmap,
  computeTopDates,
  computeByCountry,
  computeMonthlyTrend,
  firstLastDates,
  computeCoreStats,
  computeStatsForYear,
  computeAllTime,
  computeFullStats,
  round2,
  roundMinutesList,
  roundPercentMap,
  buildEntityProfile,
  rankGroupsByMinutes,
  buildSearchIndex,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = StatsLib;
} else {
  // Browser / Worker context: importScripts("stats-lib.js") makes this
  // available as self.StatsLib.
  self.StatsLib = StatsLib;
}
