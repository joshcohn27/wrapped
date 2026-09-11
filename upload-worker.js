// Web Worker for the Upload tab: takes a visitor's Spotify Extended
// Streaming History .zip, unzips + parses it, and aggregates it into the
// exact same stats shape stats.json uses -- entirely in the browser. The
// zip is never sent anywhere; this worker only ever touches the File object
// the main thread hands it. No unzip/inflate library is used -- the zip
// central directory format is simple enough to read by hand, and modern
// browsers can inflate DEFLATE natively via DecompressionStream, keeping
// this project's zero-dependency stance intact.
"use strict";

importScripts("stats-lib.js");

// Matches "Streaming_History_Audio_2024.json" / "Streaming_History_Video_2023.json"
// at the zip root or nested under any subfolder (real exports do both), on
// either / or \ path separators. Everything else in the zip (the readme
// PDF, any other file) is ignored.
const STREAMING_HISTORY_PATTERN = /(^|[/\\])Streaming_History_(Audio|Video)_.*\.json$/i;

const EOCD_SIGNATURE = 0x06054b50; // "PK\x05\x06"
const CENTRAL_DIR_SIGNATURE = 0x02014b50; // "PK\x01\x02"
const LOCAL_FILE_SIGNATURE = 0x04034b50; // "PK\x03\x04"

// ---------- minimal ZIP central-directory reader ----------

// The End Of Central Directory record sits near the end of the file, after
// an optional comment of up to 65535 bytes -- so it has to be found by
// scanning backward for its signature rather than read at a fixed offset.
function findEndOfCentralDirectory(view) {
  const maxCommentLength = 65535;
  const minPos = Math.max(0, view.byteLength - 22 - maxCommentLength);
  for (let i = view.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new Error("Not a valid zip file (End Of Central Directory record not found).");
}

// Walks the central directory and returns [{ name, method, compressedSize,
// localHeaderOffset }] for every entry. Central-directory sizes are always
// correct (unlike a local header's, which can be zeroed out when the
// "data descriptor" bit is set), so extractEntryBytes only ever needs the
// local header to locate where an entry's data actually starts.
function parseCentralDirectory(buffer) {
  const view = new DataView(buffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  let offset = centralDirOffset;
  const decoder = new TextDecoder("utf-8");

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`Corrupt zip: expected a central directory entry at offset ${offset}.`);
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));

    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// Jumps to an entry's local file header to find where its actual (still
// compressed) bytes begin -- its filename/extra-field lengths can differ
// from the central directory's -- then slices them out.
function extractEntryBytes(buffer, entry) {
  const view = new DataView(buffer);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Corrupt zip: expected a local file header for "${entry.name}".`);
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  return buffer.slice(dataStart, dataStart + entry.compressedSize);
}

async function inflateRaw(compressedBytes) {
  const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).arrayBuffer();
}

// method 0 = stored (no compression), method 8 = deflate (the standard case
// for zips produced by Explorer/Finder/Spotify's own export). Anything else
// is rare enough for this kind of export to just surface as a clear error
// for that one entry rather than be silently supported.
async function readEntryText(buffer, entry) {
  const compressedBytes = extractEntryBytes(buffer, entry);
  let dataBuffer;
  if (entry.method === 0) {
    dataBuffer = compressedBytes;
  } else if (entry.method === 8) {
    dataBuffer = await inflateRaw(compressedBytes);
  } else {
    throw new Error(`Unsupported compression method (${entry.method}) for "${entry.name}".`);
  }
  return new TextDecoder("utf-8").decode(dataBuffer);
}

// ---------- main pipeline ----------

self.onmessage = async (e) => {
  const file = e.data && e.data.file;

  try {
    if (typeof DecompressionStream === "undefined") {
      throw new Error(
        "Your browser doesn't support in-browser zip decompression. Try a recent Chrome, Edge, Firefox, or Safari."
      );
    }
    if (!file) {
      throw new Error("No file received.");
    }

    postMessage({ type: "progress", message: "Reading zip..." });
    const buffer = await file.arrayBuffer();
    const entries = parseCentralDirectory(buffer);
    const matching = entries.filter((entry) => STREAMING_HISTORY_PATTERN.test(entry.name));

    if (!matching.length) {
      throw new Error(
        "No Streaming_History_Audio_*.json or Streaming_History_Video_*.json files found in this zip. " +
          "Make sure it's the unmodified export from Spotify's \"Extended Streaming History\" request."
      );
    }

    let allRawRecords = [];
    const failedFiles = [];

    for (let i = 0; i < matching.length; i++) {
      const entry = matching[i];
      postMessage({
        type: "progress",
        message: `Parsing ${entry.name} (${i + 1} of ${matching.length})...`,
      });
      try {
        const text = await readEntryText(buffer, entry);
        const records = JSON.parse(text);
        if (Array.isArray(records)) {
          allRawRecords = allRawRecords.concat(records);
        }
      } catch (err) {
        failedFiles.push({ filename: entry.name, error: err.message });
      }
    }

    if (!allRawRecords.length) {
      throw new Error("None of the matched files in this zip could be parsed as valid JSON.");
    }

    postMessage({
      type: "progress",
      message: `Aggregating ${allRawRecords.length.toLocaleString()} records...`,
    });

    const rows = allRawRecords.map((r) => StatsLib.recordToRow(r));
    const validRows = StatsLib.filterValidRows(rows);

    if (!validRows.length) {
      throw new Error(
        "No valid music listening rows found in this upload (only podcasts/audiobooks, or no plays with any duration)."
      );
    }

    const stats = StatsLib.computeFullStats(validRows);

    postMessage({
      type: "done",
      stats,
      meta: {
        filesMatched: matching.length,
        recordsParsed: allRawRecords.length,
        validRows: validRows.length,
        failedFiles,
      },
    });
  } catch (err) {
    postMessage({ type: "error", message: (err && err.message) || String(err) });
  }
};
