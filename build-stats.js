// Build-time precompute step. Reads every data*.json export in the data/
// folder, normalizes/aggregates it via stats-lib.js (the same aggregation
// code the in-browser Upload tab uses on a visitor's own uploaded export),
// and writes stats.json + search-index.json for the browser to fetch.
//
// Run via `npm run build`. Re-run any time a data*.json file is added.
"use strict";

const fs = require("fs");
const path = require("path");
const StatsLib = require("./stats-lib.js");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE_PATTERN = /^data\d+\.json$/i;
const OUTPUT_FILE = path.join(ROOT, "stats.json");
const SEARCH_INDEX_FILE = path.join(ROOT, "search-index.json");

function findDataFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => DATA_FILE_PATTERN.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
}

// Loads every data*.json file, tolerating individual files that fail to
// parse (corrupt/truncated download, wrong format, etc) -- one bad file
// shouldn't abort the whole build when there are 10+ others to process.
// Returns the successfully parsed rows plus a list of any failures so the
// caller can report them clearly instead of the build silently succeeding
// (or crashing) on a subset of the data.
function loadAllRows() {
  const files = findDataFiles();
  if (!files.length) {
    throw new Error(
      `No data*.json files found in ${DATA_DIR} (expected files matching data\\d+.json).`
    );
  }

  const rows = [];
  const failedFiles = [];

  for (const filename of files) {
    const fullPath = path.join(DATA_DIR, filename);
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const records = Array.isArray(raw) ? raw : raw.data ?? [];
      console.log(`Loaded ${records.length} records from ${filename}`);
      for (const r of records) {
        rows.push(StatsLib.recordToRow(r));
      }
    } catch (err) {
      console.error(`FAILED to parse ${filename}: ${err.message}`);
      failedFiles.push({ filename, error: err.message });
    }
  }

  return { rows, failedFiles };
}

function main() {
  console.log("Reading data files...");
  const { rows: allRows, failedFiles } = loadAllRows();
  console.log(`Total raw records loaded: ${allRows.length}`);

  const nonMusicCount = allRows.filter((r) => !r.isMusicTrack).length;
  const musicButInvalidCount = allRows.filter(
    (r) => r.isMusicTrack && !(r.msPlayed > 0 && r.year)
  ).length;

  const validRows = StatsLib.filterValidRows(allRows);
  console.log(`Filtered out as non-music (podcast/audiobook, no track+artist name): ${nonMusicCount}`);
  console.log(`Filtered out for other reasons (zero ms_played / bad timestamp): ${musicButInvalidCount}`);
  console.log(`Valid music-play rows: ${validRows.length}`);

  if (!validRows.length) {
    throw new Error("No valid music listening rows found across data files.");
  }

  const rowYears = validRows.map((r) => r.year);
  console.log(`Date range of valid rows: ${Math.min(...rowYears)}-${Math.max(...rowYears)}`);

  const { years, byYear, allTime } = StatsLib.computeFullStats(validRows);

  const output = {
    generatedAt: new Date().toISOString(),
    years,
    byYear,
    allTime,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`Years: ${output.years.join(", ")}`);

  const searchIndex = StatsLib.buildSearchIndex(validRows);
  const searchIndexJson = JSON.stringify(searchIndex);
  fs.writeFileSync(SEARCH_INDEX_FILE, searchIndexJson);
  console.log(
    `Wrote ${SEARCH_INDEX_FILE} (${searchIndex.artists.length} artists, ${searchIndex.songs.length} songs, ` +
      `${(searchIndexJson.length / 1024 / 1024).toFixed(2)} MB)`
  );

  if (failedFiles.length) {
    console.error(
      `\nWARNING: ${failedFiles.length} data file(s) failed to parse and were skipped:`
    );
    failedFiles.forEach((f) => console.error(`  - ${f.filename}: ${f.error}`));
  }
}

main();
