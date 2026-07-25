// Renders the precomputed stats.json (see build-stats.js). No raw export
// parsing happens here -- that all runs at build time via `npm run build`.

let showAllSongs = false;    // false = top 20, true = up to 100
let showAllArtists = false;  // false = top 10, true = up to 20

let statsByYear = {};
let currentYear = null;

let allTimeStats = null;
let firstListenedSearch = "";
let firstListenedPage = 1;
let firstListenedSortColIndex = null;
let firstListenedSortDirection = 1;
const FIRST_LISTENED_PAGE_SIZE = 25;

const ALL_TIME_KEY = "all";

// ---------- helpers ----------

function showLoader() {
    document.getElementById("loader").style.display = "flex";
}

function hideLoader() {
    document.getElementById("loader").style.display = "none";
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

// Compares two table-cell strings: numeric compare if both look like plain
// numbers (with optional %/,), otherwise a natural string compare -- so
// clicking a numeric column header sorts 2 before 10, and ISO dates and
// artist names still sort correctly too.
function smartCompare(a, b) {
    const cleanA = a.replace(/[,%]/g, "").trim();
    const cleanB = b.replace(/[,%]/g, "").trim();
    const isPlainNumber = /^-?\d+(\.\d+)?$/;
    const numA = parseFloat(cleanA);
    const numB = parseFloat(cleanB);

    if (isPlainNumber.test(cleanA) && isPlainNumber.test(cleanB)) {
        return numA - numB;
    }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// ---------- DOM helpers ----------

// Renders a sortable table. Clicking a header sorts by that column
// (toggling asc/desc); columns are compared with smartCompare so numeric
// columns sort numerically. Two modes:
//   - self-contained (default): sorts the given `rows` array in place in
//     the DOM, no caller involvement needed.
//   - external (opts.onSort provided): clicking a header just calls
//     opts.onSort(colIndex) and the caller re-sorts its own data and calls
//     createTable again -- needed when sorting has to happen before other
//     logic (e.g. First Listened sorts before paginating).
// opts.unsortableColumns skips sortability for columns like "#" ranks.
// opts.getRowStyle(row) can return a CSS string applied to each <tr>.
function createTable(containerId, columns, rows, opts = {}) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    const unsortable = new Set(opts.unsortableColumns || []);
    const externalSort = typeof opts.onSort === "function";

    let sortColIndex = opts.sortState ? opts.sortState.colIndex : null;
    let sortDirection = opts.sortState ? opts.sortState.direction : 1;

    function renderBody(sourceRows) {
        tbody.innerHTML = "";
        sourceRows.forEach((row) => {
            const tr = document.createElement("tr");
            if (typeof opts.getRowStyle === "function") {
                tr.style.cssText = opts.getRowStyle(row) || "";
            }
            row.forEach((cell) => {
                const td = document.createElement("td");
                td.textContent = cell;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
    }

    function sortedRows() {
        if (sortColIndex === null) return rows;
        return [...rows].sort((a, b) => smartCompare(a[sortColIndex], b[sortColIndex]) * sortDirection);
    }

    function updateSortIndicators(headerRow) {
        Array.from(headerRow.children).forEach((th, idx) => {
            th.classList.remove("sorted-asc", "sorted-desc");
            if (idx === sortColIndex) {
                th.classList.add(sortDirection === 1 ? "sorted-asc" : "sorted-desc");
            }
        });
    }

    const headerRow = document.createElement("tr");
    columns.forEach((col, idx) => {
        const th = document.createElement("th");
        th.textContent = col;

        if (!unsortable.has(idx)) {
            th.classList.add("sortable-th");
            if (idx === sortColIndex) {
                th.classList.add(sortDirection === 1 ? "sorted-asc" : "sorted-desc");
            }
            th.addEventListener("click", () => {
                if (sortColIndex === idx) {
                    sortDirection *= -1;
                } else {
                    sortColIndex = idx;
                    sortDirection = 1;
                }

                if (externalSort) {
                    opts.onSort(sortColIndex, sortDirection);
                    return;
                }

                updateSortIndicators(headerRow);
                renderBody(sortedRows());
            });
        }
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    renderBody(externalSort ? rows : sortedRows());

    table.appendChild(thead);
    table.appendChild(tbody);
    wrapper.appendChild(table);
    container.appendChild(wrapper);
}

// Same tile markup as the original Overview block; reused for every simple
// stat display (streak, obsessed day, skip rate, shuffle ratio).
function renderStatTiles(containerId, items) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";

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

// ---------- rendering per year ----------

function renderSummary(year, stats) {
    const { totalMinutes, uniqueSongCount, uniqueArtistCount } = stats;
    const total = formatMinutesToHoursMinutes(totalMinutes);

    renderStatTiles("summary-content", [
        { label: `Total Listening Time (${year})`, value: total.hoursText },
        { label: "Total Minutes", value: total.minutesText },
        { label: "Unique Songs", value: uniqueSongCount.toString() },
        { label: "Unique Artists", value: uniqueArtistCount.toString() },
    ]);
}

function renderTopDays(stats) {
    const rows = stats.topDates.map((d, idx) => {
        const fm = formatMinutesToHoursMinutes(d.minutes);
        return [
            (idx + 1).toString(),
            d.date,
            fm.hours.toFixed(2),
            Math.round(d.minutes).toString(),
        ];
    });

    createTable("top-days-table", ["#", "Date", "Hours", "Minutes"], rows, { unsortableColumns: [0] });
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
        rows,
        { unsortableColumns: [0] }
    );

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
        rows,
        { unsortableColumns: [0] }
    );

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

function renderByCountry(stats) {
    const totalMinutes = stats.totalMinutes || 1;
    const rows = stats.byCountry.map((c, idx) => {
        const fm = formatMinutesToHoursMinutes(c.minutes);
        const percent = ((c.minutes / totalMinutes) * 100).toFixed(1) + "%";
        return [
            (idx + 1).toString(),
            c.country,
            fm.hours.toFixed(2),
            Math.round(c.minutes).toString(),
            percent,
        ];
    });

    createTable(
        "by-country-table",
        ["#", "Country", "Hours", "Minutes", "% of Total"],
        rows,
        { unsortableColumns: [0] }
    );
}

function renderLongestStreak(stats) {
    const streak = stats.longestStreak;
    renderStatTiles("longest-streak-content", [
        {
            label: "Longest Streak",
            value: `${streak.days} day${streak.days === 1 ? "" : "s"}`,
        },
        { label: "From", value: streak.startDate || "—" },
        { label: "To", value: streak.endDate || "—" },
    ]);
}

function renderMostObsessedDay(stats) {
    const day = stats.mostObsessedDay;
    if (!day) {
        renderStatTiles("most-obsessed-day-content", [
            { label: "Most Obsessed Day", value: "No data" },
        ]);
        return;
    }

    renderStatTiles("most-obsessed-day-content", [
        { label: "Song", value: day.song },
        { label: "Artist", value: day.artist },
        { label: "Date", value: day.date },
        { label: "Plays That Day", value: day.playCount.toString() },
    ]);
}

function renderDiscoveryRate(stats) {
    const rows = stats.discoveryByMonth.map((m) => [m.label, m.count.toString()]);

    createTable("discovery-rate-table", ["Month", "New Artists"], rows);
}

function renderSkipRate(stats) {
    renderStatTiles("skip-rate-content", [
        { label: "Skipped (next-track button)", value: `${stats.skipRatePercent.toFixed(1)}%` },
        { label: "Played Through / Other", value: `${(100 - stats.skipRatePercent).toFixed(1)}%` },
    ]);
}

function renderShuffleRatio(stats) {
    renderStatTiles("shuffle-ratio-content", [
        { label: "Shuffle", value: `${stats.shuffleRatio.shufflePercent.toFixed(1)}%` },
        { label: "On-Demand", value: `${stats.shuffleRatio.onDemandPercent.toFixed(1)}%` },
    ]);
}

function renderPlatformBreakdown(stats) {
    const pb = stats.platformBreakdown;
    const rows = [
        ["Mobile", `${pb.mobile.toFixed(1)}%`],
        ["Desktop", `${pb.desktop.toFixed(1)}%`],
        ["Other", `${pb.other.toFixed(1)}%`],
    ];

    createTable("platform-breakdown-table", ["Platform", "% of Plays"], rows);
}

// 24-hour heatmap as a plain, sortable table, using the same table styling
// as every other section. Each row gets a light background tint (existing
// Spotify green) scaled to how much that hour was listened to, relative to
// the year's peak hour -- numbers first, shading is just a hint. Intensity
// is re-derived from each row's own % column, so shading stays correct
// even after the rows are re-sorted.
function renderHeatmap(stats) {
    const maxPercent = Math.max(...stats.hourHeatmap.map((h) => h.percent), 0.0001);
    const rows = stats.hourHeatmap.map((h) => [
        hourToAmPm(h.hour),
        Math.round(h.minutes).toString(),
        `${h.percent.toFixed(1)}%`,
    ]);

    createTable("hour-heatmap-table", ["Hour", "Minutes", "% of Day"], rows, {
        getRowStyle: (row) => {
            const percent = parseFloat(row[2]);
            const intensity = 0.05 + (percent / maxPercent) * 0.3;
            return `background-color: rgba(30, 215, 96, ${intensity.toFixed(3)})`;
        },
    });
}

// ---------- all-time (not year-scoped) ----------

function getFilteredFirstListened() {
    const list = allTimeStats.firstListenedByArtist;
    if (!firstListenedSearch) return list;

    const needle = firstListenedSearch.toLowerCase();
    return list.filter((entry) => entry.artist.toLowerCase().includes(needle));
}

function getSortedFirstListened() {
    const filtered = getFilteredFirstListened();
    if (firstListenedSortColIndex === null) return filtered;

    // Column 0 is the "#" rank -- not meaningfully sortable, handled by
    // unsortableColumns below so this case never actually triggers.
    const sorted = [...filtered];
    if (firstListenedSortColIndex === 1) {
        sorted.sort((a, b) => a.artist.localeCompare(b.artist) * firstListenedSortDirection);
    } else if (firstListenedSortColIndex === 2) {
        sorted.sort((a, b) => (a.firstTs < b.firstTs ? -1 : a.firstTs > b.firstTs ? 1 : 0) * firstListenedSortDirection);
    }
    return sorted;
}

function renderFirstListened() {
    const filtered = getSortedFirstListened();
    const totalPages = Math.max(1, Math.ceil(filtered.length / FIRST_LISTENED_PAGE_SIZE));
    firstListenedPage = Math.min(Math.max(1, firstListenedPage), totalPages);

    const start = (firstListenedPage - 1) * FIRST_LISTENED_PAGE_SIZE;
    const pageItems = filtered.slice(start, start + FIRST_LISTENED_PAGE_SIZE);

    const rows = pageItems.map((entry, idx) => [
        (start + idx + 1).toString(),
        entry.artist,
        entry.firstDate,
    ]);

    createTable("first-listened-table", ["#", "Artist", "First Heard"], rows, {
        unsortableColumns: [0],
        sortState: firstListenedSortColIndex === null
            ? null
            : { colIndex: firstListenedSortColIndex, direction: firstListenedSortDirection },
        onSort: (colIndex, direction) => {
            firstListenedSortColIndex = colIndex;
            firstListenedSortDirection = direction;
            firstListenedPage = 1;
            renderFirstListened();
        },
    });
    renderFirstListenedPagination(filtered.length, totalPages);
}

function renderFirstListenedPagination(totalCount, totalPages) {
    const container = document.getElementById("first-listened-pagination");
    container.innerHTML = "";

    if (!totalCount) {
        const empty = document.createElement("p");
        empty.className = "section-subtitle";
        empty.textContent = "No artists match your search.";
        container.appendChild(empty);
        return;
    }

    const wrap = document.createElement("div");
    wrap.className = "pagination";

    const prevBtn = document.createElement("button");
    prevBtn.className = "show-more-btn";
    prevBtn.textContent = "Previous";
    prevBtn.disabled = firstListenedPage <= 1;
    prevBtn.addEventListener("click", () => {
        firstListenedPage -= 1;
        renderFirstListened();
    });

    const info = document.createElement("span");
    info.className = "pagination-info";
    info.textContent = `Page ${firstListenedPage} of ${totalPages} (${totalCount} artist${totalCount === 1 ? "" : "s"})`;

    const nextBtn = document.createElement("button");
    nextBtn.className = "show-more-btn";
    nextBtn.textContent = "Next";
    nextBtn.disabled = firstListenedPage >= totalPages;
    nextBtn.addEventListener("click", () => {
        firstListenedPage += 1;
        renderFirstListened();
    });

    wrap.appendChild(prevBtn);
    wrap.appendChild(info);
    wrap.appendChild(nextBtn);
    container.appendChild(wrap);
}

function setupFirstListenedSearch() {
    const input = document.getElementById("first-listened-search");
    input.addEventListener("input", (e) => {
        firstListenedSearch = e.target.value.trim();
        firstListenedPage = 1;
        renderFirstListened();
    });
}

// ---------- tabs + main ----------

function renderYearTabs(years) {
    const container = document.getElementById("year-tabs");
    container.innerHTML = "";

    const allTimeBtn = document.createElement("button");
    allTimeBtn.className = "tab-button";
    allTimeBtn.textContent = "All Time";
    allTimeBtn.dataset.year = ALL_TIME_KEY;
    allTimeBtn.addEventListener("click", () => setActiveYear(ALL_TIME_KEY));
    container.appendChild(allTimeBtn);

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

    document.querySelectorAll(".tab-button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.year === String(year));
    });

    const isAllTime = year === ALL_TIME_KEY;
    const stats = isAllTime ? allTimeStats : statsByYear[year];
    if (!stats) return;

    const yearTag = document.getElementById("year-tag");
    if (yearTag) {
        yearTag.textContent = isAllTime ? "All Time" : year;
    }

    showAllSongs = false;
    showAllArtists = false;

    renderSummary(isAllTime ? "All Time" : year, stats);
    renderTopDays(stats);
    renderTopSongs(stats);
    renderTopArtists(stats);
    renderLongestStreak(stats);
    renderMostObsessedDay(stats);
    renderDiscoveryRate(stats);
    renderSkipRate(stats);
    renderShuffleRatio(stats);
    renderPlatformBreakdown(stats);
    renderByCountry(stats);
    renderHeatmap(stats);
}

async function main() {
    showLoader();

    try {
        const res = await fetch("stats.json");
        if (!res.ok) {
            throw new Error(`Failed to load stats.json: ${res.status}`);
        }
        const data = await res.json();

        statsByYear = data.byYear || {};
        const years = data.years || [];

        if (!years.length) {
            hideLoader();
            alert("No years found in stats.json. Run `npm run build` and reload.");
            return;
        }

        renderYearTabs(years);

        allTimeStats = data.allTime;
        setupFirstListenedSearch();
        renderFirstListened();

        setActiveYear(years[0]);
    } catch (err) {
        console.error(err);
        alert("Error loading stats.json. Check the console.");
    }

    hideLoader();
}

main();
