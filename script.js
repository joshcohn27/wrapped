// ---- CONFIG: your data files here ----
// Add or remove filenames as needed.
// Each file should be the same format as your old data.json export.
const DATA_FILES = ["data1.json", "data2.json", "data3.json", "data4.json"];
// Show-more state for tables
let showAllSongs = false;    // false = top 20, true = up to 100
let showAllArtists = false;  // false = top 10, true = up to 20

// --------------------------------------

// ---------- helpers ----------

function showLoader() {
    document.getElementById("loader").style.display = "flex";
}

function hideLoader() {
    document.getElementById("loader").style.display = "none";
}


function normalizeTrackTitle(name) {
    if (!name) return "";
    let s = name.trim();

    // Remove anything in parentheses: (Live), (Remastered 2011), etc.
    s = s.replace(/\s*\([^)]*\)/g, "");

    // Remove stuff after " - " (version tags)
    s = s.split(" - ")[0];

    return s.trim();
}

function hourToAmPm(hour) {
    const h = Number(hour);
    const suffix = h < 12 ? "AM" : "PM";
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return `${h12} ${suffix}`;
}

function formatMinutesToHoursMinutes(totalMinutes) {
    const hours = totalMinutes / 60;
    return {
        hours,
        hoursText: `${hours.toFixed(2)} hours`,
        minutesText: `${Math.round(totalMinutes)} minutes`,
    };
}

// ---------- DOM helpers ----------

function createTable(containerId, columns, rows) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");

    const headerRow = document.createElement("tr");
    columns.forEach((col) => {
        const th = document.createElement("th");
        th.textContent = col;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    rows.forEach((row) => {
        const tr = document.createElement("tr");
        row.forEach((cell) => {
            const td = document.createElement("td");
            td.textContent = cell;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    wrapper.appendChild(table);
    container.appendChild(wrapper);
}

// ---------- data loading ----------

async function loadAllDataFiles() {
    const allRecords = [];

    for (const filename of DATA_FILES) {
        try {
            const res = await fetch(filename);
            if (!res.ok) {
                console.warn(`Skipping ${filename}, status: ${res.status}`);
                continue;
            }
            const raw = await res.json();
            const records = Array.isArray(raw) ? raw : raw.data ?? [];
            console.log(`Loaded ${records.length} records from ${filename}`);
            allRecords.push(...records);
        } catch (err) {
            console.warn(`Error loading ${filename}:`, err);
        }
    }

    return allRecords;
}

function mapRawToRows(records) {
    return records.map((r) => {
        const ts = new Date(r.ts); // ISO Z string, UTC
        const year = ts.getUTCFullYear();

        const minutes = (r.ms_played || 0) / 60000;

        const trackName = r.master_metadata_track_name || "";
        const artistName = r.master_metadata_album_artist_name || "";

        const trackTitleNorm = normalizeTrackTitle(trackName);
        const artistNorm = artistName.toLowerCase().trim();
        const trackArtistKey =
            trackTitleNorm.toLowerCase().trim() + " — " + artistNorm;

        return {
            ts,
            year, // year determined directly from ts (UTC)
            localDate: ts.toLocaleDateString("en-CA"), // e.g. 2025-09-17 (local)
            localHour: ts.getHours(), // local hour
            minutes,
            msPlayed: r.ms_played || 0,
            isMusic: !!trackName,
            trackName,
            artistName,
            trackTitleNorm,
            trackArtistKey,
            artistNorm,
            trackUri: r.spotify_track_uri || "",
            country: r.conn_country || "??",
        };
    });
}

function groupRowsByYear(rows) {
    const byYear = new Map();
    for (const r of rows) {
        if (
            !r.isMusic ||
            r.msPlayed <= 0 ||
            !r.trackName ||
            !r.artistName ||
            !r.year
        ) {
            continue;
        }

        if (!byYear.has(r.year)) {
            byYear.set(r.year, []);
        }
        byYear.get(r.year).push(r);
    }
    return byYear;
}

// ---------- stats per year ----------

function computeStatsForYear(rows) {
    if (!rows || !rows.length) {
        return null;
    }

    // Total minutes/hours
    const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0);

    // Unique songs (normalized key) and artists
    const uniqueSongKeys = new Set(rows.map((r) => r.trackArtistKey));
    const uniqueArtists = new Set(rows.map((r) => r.artistName));

    // Top 5 dates (by localDate)
    const minutesByDate = new Map();
    for (const r of rows) {
        const key = r.localDate;
        minutesByDate.set(key, (minutesByDate.get(key) || 0) + r.minutes);
    }
    const topDates = Array.from(minutesByDate.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    // Top 50 songs (group by trackArtistKey, merging different versions)
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

    // Top 5 artists
    const artistMap = new Map();
    for (const r of rows) {
        const name = r.artistName;
        if (!artistMap.has(name)) {
            artistMap.set(name, {
                artist: name,
                totalMinutes: 0,
                playEvents: 0,
                trackKeys: new Set(),
            });
        }
        const a = artistMap.get(name);
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

    // Top hours (local)
    const minutesByHour = new Map();
    for (const r of rows) {
        const h = r.localHour;
        minutesByHour.set(h, (minutesByHour.get(h) || 0) + r.minutes);
    }
    const topHours = Array.from(minutesByHour.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    // By country
    const minutesByCountry = new Map();
    for (const r of rows) {
        const c = r.country;
        minutesByCountry.set(c, (minutesByCountry.get(c) || 0) + r.minutes);
    }
    const byCountry = Array.from(minutesByCountry.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    return {
        totalMinutes,
        uniqueSongCount: uniqueSongKeys.size,
        uniqueArtistCount: uniqueArtists.size,
        topDates,
        topSongs,
        topArtists,
        topHours,
        byCountry,
    };
}

// ---------- rendering per year ----------

function renderSummary(year, stats) {
    const { totalMinutes, uniqueSongCount, uniqueArtistCount } = stats;
    const total = formatMinutesToHoursMinutes(totalMinutes);

    const container = document.getElementById("summary-content");
    container.innerHTML = "";

    const items = [
        { label: `Total Listening Time (${year})`, value: total.hoursText },
        { label: "Total Minutes", value: total.minutesText },
        { label: "Unique Songs", value: uniqueSongCount.toString() },
        { label: "Unique Artists", value: uniqueArtistCount.toString() },
    ];

    items.forEach((item) => {
        const div = document.createElement("div");
        div.className = "summary-item";

        const labelSpan = document.createElement("span");
        labelSpan.className = "label";
        labelSpan.textContent = item.label;

        const valueSpan = document.createElement("span");
        valueSpan.className = "value";
        valueSpan.textContent = item.value;

        div.appendChild(labelSpan);
        div.appendChild(valueSpan);
        container.appendChild(div);
    });
}

function renderTopDays(stats) {
    const rows = stats.topDates.map(([date, minutes], idx) => {
        const fm = formatMinutesToHoursMinutes(minutes);
        return [
            (idx + 1).toString(),
            date,
            fm.hours.toFixed(2),
            Math.round(minutes).toString(),
        ];
    });

    createTable("top-days-table", ["#", "Date", "Hours", "Minutes"], rows);
}

function renderTopSongs(stats) {
    const totalAvailable = stats.topSongs.length;
    const visibleCount = showAllSongs
        ? Math.min(100, totalAvailable)
        : Math.min(20, totalAvailable);

    const rows = stats.topSongs.slice(0, visibleCount).map((song, idx) => {
        const fm = formatMinutesToHoursMinutes(song.totalMinutes);
        return [
            (idx + 1).toString(),
            song.normalizedTitle,
            song.displayArtist,
            fm.hours.toFixed(2),
            Math.round(song.totalMinutes).toString(),
            song.playEvents.toString(),
        ];
    });

    createTable(
        "top-songs-table",
        ["#", "Song", "Artist", "Hours", "Minutes", "Play Events"],
        rows
    );

    // Add / update Show More / Show Less button
    const container = document.getElementById("top-songs-table");
    const existingButton = container.querySelector(".show-more-btn-songs");
    if (existingButton) existingButton.remove();

    if (totalAvailable > 20) {
        const btn = document.createElement("button");
        btn.className = "show-more-btn show-more-btn-songs";
        btn.textContent = showAllSongs ? "Show Less" : "Show More";
        btn.addEventListener("click", () => {
            showAllSongs = !showAllSongs;
            renderTopSongs(stats);
        });
        container.appendChild(btn);
    }
}

function renderTopArtists(stats) {
    const totalAvailable = stats.topArtists.length;
    const visibleCount = showAllArtists
        ? Math.min(20, totalAvailable)
        : Math.min(10, totalAvailable);

    const rows = stats.topArtists.slice(0, visibleCount).map((artist, idx) => {
        const fm = formatMinutesToHoursMinutes(artist.totalMinutes);
        return [
            (idx + 1).toString(),
            artist.artist,
            fm.hours.toFixed(2),
            Math.round(artist.totalMinutes).toString(),
            artist.uniqueSongs.toString(),
            artist.playEvents.toString(),
        ];
    });

    createTable(
        "top-artists-table",
        ["#", "Artist", "Hours", "Minutes", "Unique Songs", "Play Events"],
        rows
    );

    // Add / update Show More / Show Less button
    const container = document.getElementById("top-artists-table");
    const existingButton = container.querySelector(".show-more-btn-artists");
    if (existingButton) existingButton.remove();

    if (totalAvailable > 10) {
        const btn = document.createElement("button");
        btn.className = "show-more-btn show-more-btn-artists";
        btn.textContent = showAllArtists ? "Show Less" : "Show More";
        btn.addEventListener("click", () => {
            showAllArtists = !showAllArtists;
            renderTopArtists(stats);
        });
        container.appendChild(btn);
    }
}


function renderTopHours(stats) {
    const totalMinutes = stats.totalMinutes || 1;
    const rows = stats.topHours.map(([hour, minutes], idx) => {
        const fm = formatMinutesToHoursMinutes(minutes);
        const percent = ((minutes / totalMinutes) * 100).toFixed(1) + "%";
        return [
            (idx + 1).toString(),
            hourToAmPm(hour),
            fm.hours.toFixed(2),
            Math.round(minutes).toString(),
            percent,
        ];
    });

    createTable(
        "top-hours-table",
        ["#", "Hour", "Hours", "Minutes", "% of Total"],
        rows
    );
}

function renderByCountry(stats) {
    const totalMinutes = stats.totalMinutes || 1;
    const rows = stats.byCountry.map(([country, minutes], idx) => {
        const fm = formatMinutesToHoursMinutes(minutes);
        const percent = ((minutes / totalMinutes) * 100).toFixed(1) + "%";
        return [
            (idx + 1).toString(),
            country,
            fm.hours.toFixed(2),
            Math.round(minutes).toString(),
            percent,
        ];
    });

    createTable(
        "by-country-table",
        ["#", "Country", "Hours", "Minutes", "% of Total"],
        rows
    );
}

// ---------- tabs + main ----------

let statsByYear = new Map();
let currentYear = null;

function renderYearTabs(years) {
    const container = document.getElementById("year-tabs");
    container.innerHTML = "";

    years.forEach((year) => {
        const btn = document.createElement("button");
        btn.className = "tab-button";
        btn.textContent = year;
        btn.dataset.year = year;
        btn.addEventListener("click", () => setActiveYear(year));
        container.appendChild(btn);
    });
}

function setActiveYear(year) {
    currentYear = year;

    // Update tab button classes
    document.querySelectorAll(".tab-button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.year === String(year));
    });

    // Update hero year tag
    const yearTag = document.getElementById("year-tag");
    if (yearTag) {
        yearTag.textContent = year;
    }

    const stats = statsByYear.get(year);
    if (!stats) return;

    showAllSongs = false;
    showAllArtists = false;

    renderSummary(year, stats);
    renderTopDays(stats);
    renderTopSongs(stats);
    renderTopArtists(stats);
    renderTopHours(stats);
    renderByCountry(stats);
}

async function main() {
    showLoader();  // <-- Show spinner immediately

    try {
        // Load & combine all JSON files
        const allRecords = await loadAllDataFiles();
        if (!allRecords.length) {
            hideLoader();
            alert("No data loaded from any data files.");
            return;
        }

        // Convert raw JSON into normalized rows
        const rows = mapRawToRows(allRecords);

        // Group rows by ts-year (all years found)
        const grouped = groupRowsByYear(rows);

        const years = Array.from(grouped.keys()).sort((a, b) => b - a);
        if (!years.length) {
            hideLoader();
            alert("No valid music listening data found in any year.");
            return;
        }

        // Compute stats per year
        statsByYear = new Map();
        for (const year of years) {
            const stats = computeStatsForYear(grouped.get(year));
            if (stats) {
                statsByYear.set(year, stats);
            }
        }

        const availableYears = Array.from(statsByYear.keys()).sort((a, b) => b - a);
        if (!availableYears.length) {
            hideLoader();
            alert("No stats could be computed from the data.");
            return;
        }

        // Show year tabs
        renderYearTabs(availableYears);

        // Default selection = newest year
        setActiveYear(availableYears[0]);

    } catch (err) {
        console.error(err);
        alert("Error loading or processing data files. Check the console.");
    }

    hideLoader(); // <-- Hide spinner when everything is ready
}

main();

