// Renders precomputed stats: stats.json for the built-in Dashboard tab (see
// build-stats.js), or a Web Worker's output for the Upload tab (see
// upload-worker.js). No raw export parsing happens here directly -- both
// paths go through the shared aggregation code in stats-lib.js.

const FIRST_LISTENED_PAGE_SIZE = 25;
const ALL_TIME_KEY = "all";

// Search tab state. search-index.json is fetched lazily (only once the
// Search tab is actually opened) since it's much bigger than stats.json.
let dashboardYears = [];
let searchIndexData = null;
let searchIndexPromise = null;
let searchArtistMap = new Map();
let searchSongMap = new Map();
let searchQuery = "";
let searchYearFilter = ALL_TIME_KEY;
let searchTypeFilter = "all";
let searchSelected = null; // { type: "artist" | "song", key }
const SEARCH_RESULTS_LIMIT = 50;

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

function debounce(fn, waitMs) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), waitMs);
    };
}

function formatMinutesToHoursMinutes(totalMinutes) {
    const hours = totalMinutes / 60;
    return {
        hours,
        hoursText: `${hours.toFixed(2)} hours`,
        minutesText: `${Math.round(totalMinutes)} minutes`,
    };
}

// platformBreakdown is a { [category]: percent } map with however many
// categories stats-lib.js's categorizePlatform actually produced for this
// row set (not a fixed Mobile/Desktop/Other shape) -- shared by the
// dashboard's Platform Breakdown table and the Search tab's entity detail.
function platformBreakdownRows(platformBreakdown) {
    return Object.entries(platformBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([category, percent]) => [category, `${percent.toFixed(1)}%`]);
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

// ---------- dashboard (year-scoped rendering, one factory per instance) ----------
// Wrapped in a factory (rather than the module-level functions + state this
// used to be) so the exact same rendering/sorting/show-more/pagination
// behavior can power two fully independent instances: the built-in
// Dashboard tab (fed from stats.json) and the Upload tab's own dashboard
// (fed from a Web Worker's output for a visitor's uploaded export). `ids`
// maps each logical section to its actual container id, so the two
// instances never touch each other's DOM or share any state.
function createDashboardController(ids) {
    let showAllSongs = false; // false = top 20, true = up to 100
    let showAllArtists = false; // false = top 10, true = up to 20
    let statsByYear = {};
    let years = [];
    let currentYear = null;
    let allTimeStats = null;
    let firstListenedSearch = "";
    let firstListenedPage = 1;
    let firstListenedSortColIndex = null;
    let firstListenedSortDirection = 1;

    function renderSummary(year, stats) {
        const { totalMinutes, uniqueSongCount, uniqueArtistCount } = stats;
        const total = formatMinutesToHoursMinutes(totalMinutes);

        renderStatTiles(ids.summary, [
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

        createTable(ids.topDays, ["#", "Date", "Hours", "Minutes"], rows, { unsortableColumns: [0] });
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
            ids.topSongs,
            ["#", "Song", "Artist", "Hours", "Minutes", "Play Events"],
            rows,
            { unsortableColumns: [0] }
        );

        const container = document.getElementById(ids.topSongs);
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
            ids.topArtists,
            ["#", "Artist", "Hours", "Minutes", "Unique Songs", "Play Events"],
            rows,
            { unsortableColumns: [0] }
        );

        const container = document.getElementById(ids.topArtists);
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
            ids.byCountry,
            ["#", "Country", "Hours", "Minutes", "% of Total"],
            rows,
            { unsortableColumns: [0] }
        );
    }

    function renderLongestStreak(stats) {
        const streak = stats.longestStreak;
        renderStatTiles(ids.longestStreak, [
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
            renderStatTiles(ids.mostObsessedDay, [
                { label: "Most Obsessed Day", value: "No data" },
            ]);
            return;
        }

        renderStatTiles(ids.mostObsessedDay, [
            { label: "Song", value: day.song },
            { label: "Artist", value: day.artist },
            { label: "Date", value: day.date },
            { label: "Plays That Day", value: day.playCount.toString() },
        ]);
    }

    function renderDiscoveryRate(stats) {
        const rows = stats.discoveryByMonth.map((m) => [m.label, m.count.toString()]);

        createTable(ids.discoveryRate, ["Month", "New Artists"], rows);
    }

    function renderSkipRate(stats) {
        renderStatTiles(ids.skipRate, [
            { label: "Skipped (next-track button)", value: `${stats.skipRatePercent.toFixed(1)}%` },
            { label: "Played Through / Other", value: `${(100 - stats.skipRatePercent).toFixed(1)}%` },
        ]);
    }

    function renderShuffleRatio(stats) {
        renderStatTiles(ids.shuffleRatio, [
            { label: "Shuffle", value: `${stats.shuffleRatio.shufflePercent.toFixed(1)}%` },
            { label: "On-Demand", value: `${stats.shuffleRatio.onDemandPercent.toFixed(1)}%` },
        ]);
    }

    function renderPlatformBreakdown(stats) {
        const rows = platformBreakdownRows(stats.platformBreakdown);
        createTable(ids.platformBreakdown, ["Platform", "% of Plays"], rows);
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

        createTable(ids.heatmap, ["Hour", "Minutes", "% of Day"], rows, {
            getRowStyle: (row) => {
                const percent = parseFloat(row[2]);
                const intensity = 0.05 + (percent / maxPercent) * 0.3;
                return `background-color: rgba(30, 215, 96, ${intensity.toFixed(3)})`;
            },
        });
    }

    // ---------- all-time (not year-scoped): First Listened ----------

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

        createTable(ids.firstListenedTable, ["#", "Artist", "First Heard"], rows, {
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
        const container = document.getElementById(ids.firstListenedPagination);
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
        const input = document.getElementById(ids.firstListenedSearchInput);
        input.addEventListener("input", (e) => {
            firstListenedSearch = e.target.value.trim();
            firstListenedPage = 1;
            renderFirstListened();
        });
    }

    // ---------- year tabs + orchestration ----------

    function renderYearTabs() {
        const container = document.getElementById(ids.yearTabs);
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

        document.querySelectorAll(`#${ids.yearTabs} .tab-button`).forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.year === String(year));
        });

        const isAllTime = year === ALL_TIME_KEY;
        const stats = isAllTime ? allTimeStats : statsByYear[year];
        if (!stats) return;

        const yearTag = document.getElementById(ids.yearTag);
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

    // Loads a stats.json-shaped payload ({ years, byYear, allTime }) into
    // this instance and renders it. Returns false if there's no data to
    // show (e.g. an uploaded file with zero valid rows), true otherwise.
    function load(data) {
        statsByYear = data.byYear || {};
        years = data.years || [];
        allTimeStats = data.allTime || null;

        if (!years.length || !allTimeStats) return false;

        renderYearTabs();
        setupFirstListenedSearch();
        renderFirstListened();
        setActiveYear(years[0]);
        return true;
    }

    return { load, setActiveYear, get years() { return years; } };
}

// ---------- search tab ----------

function setupViewTabs() {
    document.querySelectorAll("#view-tabs .tab-button").forEach((btn) => {
        btn.addEventListener("click", () => setActiveView(btn.dataset.view));
    });
}

function setActiveView(view) {
    document.querySelectorAll("#view-tabs .tab-button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.view === view);
    });
    document.getElementById("dashboard-view").hidden = view !== "dashboard";
    document.getElementById("search-view").hidden = view !== "search";
    document.getElementById("upload-view").hidden = view !== "upload";

    if (view === "search") {
        ensureSearchIndexLoaded();
    }
}

// Fetches search-index.json once, the first time the Search tab is opened
// (it's a much bigger payload than stats.json, so the dashboard's initial
// load never pays for it).
function ensureSearchIndexLoaded() {
    if (searchIndexData || searchIndexPromise) return searchIndexPromise;

    const resultsContainer = document.getElementById("search-results");
    resultsContainer.innerHTML = "";
    const loading = document.createElement("p");
    loading.className = "section-subtitle";
    loading.textContent = "Loading search index...";
    resultsContainer.appendChild(loading);

    searchIndexPromise = fetch("search-index.json")
        .then((res) => {
            if (!res.ok) throw new Error(`Failed to load search-index.json: ${res.status}`);
            return res.json();
        })
        .then((data) => {
            searchIndexData = data;
            searchArtistMap = new Map(data.artists.map((a) => [a.name, a]));
            searchSongMap = new Map(data.songs.map((s) => [s.key, s]));
            renderSearchYearFilter();
            renderSearchResults();
        })
        .catch((err) => {
            console.error(err);
            resultsContainer.innerHTML = "";
            const errEl = document.createElement("p");
            errEl.className = "section-subtitle";
            errEl.textContent = "Error loading search index. Check the console.";
            resultsContainer.appendChild(errEl);
        });

    return searchIndexPromise;
}

function renderSearchYearFilter() {
    const container = document.getElementById("search-year-filter");
    container.innerHTML = "";

    const allBtn = document.createElement("button");
    allBtn.className = "tab-button" + (searchYearFilter === ALL_TIME_KEY ? " active" : "");
    allBtn.textContent = "All Time";
    allBtn.dataset.scope = ALL_TIME_KEY;
    allBtn.addEventListener("click", () => setSearchYearFilter(ALL_TIME_KEY));
    container.appendChild(allBtn);

    dashboardYears.forEach((year) => {
        const scope = String(year);
        const btn = document.createElement("button");
        btn.className = "tab-button" + (searchYearFilter === scope ? " active" : "");
        btn.textContent = scope;
        btn.dataset.scope = scope;
        btn.addEventListener("click", () => setSearchYearFilter(scope));
        container.appendChild(btn);
    });
}

function setSearchYearFilter(scope) {
    searchYearFilter = scope;
    document.querySelectorAll("#search-year-filter .tab-button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.scope === scope);
    });
    renderSearchResults();
    if (searchSelected) renderEntityDetail(searchSelected.type, searchSelected.key);
}

function setupSearchTypeFilter() {
    document.querySelectorAll("#search-type-filter .tab-button").forEach((btn) => {
        btn.addEventListener("click", () => {
            searchTypeFilter = btn.dataset.type;
            document.querySelectorAll("#search-type-filter .tab-button").forEach((b) => {
                b.classList.toggle("active", b === btn);
            });
            renderSearchResults();
        });
    });
}

function setupSearchInput() {
    const input = document.getElementById("search-input");
    const onInput = debounce((value) => {
        searchQuery = value.trim().toLowerCase();
        renderSearchResults();
    }, 150);
    input.addEventListener("input", (e) => onInput(e.target.value));
}

// Matches artists/songs against the query + type filter, restricted to
// entities that actually have data in the selected scope, ranked by total
// listening time in that scope, capped so a huge/no-op query still renders
// instantly.
function renderSearchResults() {
    const container = document.getElementById("search-results");
    container.innerHTML = "";

    if (!searchIndexData) return;

    const scope = searchYearFilter;
    const needle = searchQuery;
    const results = [];

    if (searchTypeFilter !== "song") {
        for (const artist of searchIndexData.artists) {
            const profile = artist.byScope[scope];
            if (!profile) continue;
            if (needle && !artist.name.toLowerCase().includes(needle)) continue;
            results.push({
                type: "artist",
                key: artist.name,
                name: artist.name,
                sub: "Artist",
                totalMinutes: profile.totalMinutes,
            });
        }
    }

    if (searchTypeFilter !== "artist") {
        for (const song of searchIndexData.songs) {
            const profile = song.byScope[scope];
            if (!profile) continue;
            if (
                needle &&
                !song.title.toLowerCase().includes(needle) &&
                !song.artist.toLowerCase().includes(needle)
            ) {
                continue;
            }
            results.push({
                type: "song",
                key: song.key,
                name: song.title,
                sub: `Song · ${song.artist}`,
                totalMinutes: profile.totalMinutes,
            });
        }
    }

    results.sort((a, b) => b.totalMinutes - a.totalMinutes);
    const totalMatches = results.length;
    const visible = results.slice(0, SEARCH_RESULTS_LIMIT);

    if (!visible.length) {
        const empty = document.createElement("p");
        empty.className = "section-subtitle";
        empty.textContent = needle
            ? "No artists or songs match your search for this time period."
            : "No listening data for this time period.";
        container.appendChild(empty);
        return;
    }

    const list = document.createElement("div");
    list.className = "search-results-list";

    visible.forEach((item) => {
        const btn = document.createElement("button");
        btn.className = "search-result-item";
        if (searchSelected && searchSelected.type === item.type && searchSelected.key === item.key) {
            btn.classList.add("active");
        }

        const main = document.createElement("div");
        main.className = "search-result-main";

        const nameEl = document.createElement("span");
        nameEl.className = "search-result-name";
        nameEl.textContent = item.name;

        const subEl = document.createElement("span");
        subEl.className = "search-result-sub";
        subEl.textContent = item.sub;

        main.appendChild(nameEl);
        main.appendChild(subEl);

        const statEl = document.createElement("span");
        statEl.className = "search-result-stat";
        statEl.textContent = `${formatMinutesToHoursMinutes(item.totalMinutes).hours.toFixed(1)} hrs`;

        btn.appendChild(main);
        btn.appendChild(statEl);
        btn.addEventListener("click", () => selectSearchEntity(item.type, item.key));

        list.appendChild(btn);
    });

    container.appendChild(list);

    if (totalMatches > SEARCH_RESULTS_LIMIT) {
        const hint = document.createElement("p");
        hint.className = "hint-text";
        hint.textContent = `Showing the top ${SEARCH_RESULTS_LIMIT} of ${totalMatches} matches by listening time. Refine your search to narrow it down.`;
        container.appendChild(hint);
    }
}

function openEntityModal() {
    document.getElementById("entity-modal-overlay").hidden = false;
    document.body.classList.add("modal-open");
}

function closeEntityModal() {
    document.getElementById("entity-modal-overlay").hidden = true;
    document.body.classList.remove("modal-open");
}

// Wires the modal's close affordances once at startup: the X button,
// clicking the dimmed backdrop, and Escape -- same behavior on desktop
// (centered dialog) and mobile (fullscreen sheet).
function setupEntityModal() {
    document.getElementById("entity-modal-close").addEventListener("click", closeEntityModal);
    document.getElementById("entity-modal-overlay").addEventListener("click", (e) => {
        if (e.target.id === "entity-modal-overlay") closeEntityModal();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !document.getElementById("entity-modal-overlay").hidden) {
            closeEntityModal();
        }
    });
}

function selectSearchEntity(type, key) {
    searchSelected = { type, key };
    renderSearchResults(); // re-render so the clicked row picks up "active"
    renderEntityDetail(type, key);
    openEntityModal();
}

// Renders the full profile for one artist or song into the entity modal:
// stat tiles, monthly trend, top days, country/platform breakdown, plus
// songs-by-artist (artist) or a link back to the artist (song). Reuses the
// same createTable / renderStatTiles helpers as the year dashboard above.
function renderEntityDetail(type, key) {
    const entry = type === "artist" ? searchArtistMap.get(key) : searchSongMap.get(key);
    if (!entry) return;

    const container = document.getElementById("search-detail");
    container.innerHTML = "";
    container.scrollTop = 0;

    const scope = searchYearFilter;
    const scopeLabel = scope === ALL_TIME_KEY ? "All Time" : scope;
    const profile = entry.byScope[scope];

    const header = document.createElement("div");
    header.className = "entity-detail-header";
    const h2 = document.createElement("h2");
    h2.textContent = type === "artist" ? entry.name : entry.title;
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    pill.textContent = type === "artist" ? "Artist" : "Song";
    header.appendChild(h2);
    header.appendChild(pill);
    container.appendChild(header);

    const subtitle = document.createElement("p");
    subtitle.className = "section-subtitle";
    if (type === "song") {
        subtitle.appendChild(document.createTextNode("by "));
        const artistLink = document.createElement("button");
        artistLink.className = "entity-artist-link";
        artistLink.textContent = entry.artist;
        artistLink.addEventListener("click", () => selectSearchEntity("artist", entry.artist));
        subtitle.appendChild(artistLink);
        subtitle.appendChild(document.createTextNode(` · Showing: ${scopeLabel}`));
    } else {
        subtitle.textContent = `Showing: ${scopeLabel}`;
    }
    container.appendChild(subtitle);

    if (!profile) {
        const empty = document.createElement("p");
        empty.className = "section-subtitle";
        empty.textContent = `No plays logged for ${scopeLabel}.`;
        container.appendChild(empty);
        return;
    }

    const fm = formatMinutesToHoursMinutes(profile.totalMinutes);
    const tiles = [
        { label: "Total Listening Time", value: fm.hoursText },
        { label: "Total Minutes", value: fm.minutesText },
        { label: "Play Events", value: profile.playEvents.toString() },
        {
            label: `Rank (${scopeLabel})`,
            value: `#${profile.rank} of ${profile.totalInScope} ${type === "artist" ? "artists" : "songs"}`,
        },
    ];
    if (type === "artist") {
        tiles.push({ label: "Unique Songs", value: profile.uniqueSongs.toString() });
    }
    tiles.push(
        { label: "First Listened", value: profile.firstDate },
        { label: "Last Listened", value: profile.lastDate },
        { label: "Skip Rate", value: `${profile.skipRatePercent.toFixed(1)}%` },
        { label: "Shuffle %", value: `${profile.shuffleRatio.shufflePercent.toFixed(1)}%` }
    );

    const tilesDiv = document.createElement("div");
    tilesDiv.id = "entity-tiles";
    tilesDiv.className = "summary-grid";
    container.appendChild(tilesDiv);
    renderStatTiles("entity-tiles", tiles);

    appendEntitySection(container, "Monthly Trend", "entity-monthly-trend");
    const maxTrendMinutes = Math.max(...profile.monthlyTrend.map((m) => m.minutes), 0.0001);
    const trendRows = profile.monthlyTrend.map((m) => [m.label, Math.round(m.minutes).toString()]);
    createTable("entity-monthly-trend", ["Month", "Minutes"], trendRows, {
        getRowStyle: (row) => {
            const minutes = parseFloat(row[1]);
            const intensity = 0.05 + (minutes / maxTrendMinutes) * 0.3;
            return `background-color: rgba(30, 215, 96, ${intensity.toFixed(3)})`;
        },
    });

    appendEntitySection(container, "Top Listening Days", "entity-top-days");
    const dayRows = profile.topDays.map((d, idx) => {
        const dfm = formatMinutesToHoursMinutes(d.minutes);
        return [(idx + 1).toString(), d.date, dfm.hours.toFixed(2), Math.round(d.minutes).toString()];
    });
    createTable("entity-top-days", ["#", "Date", "Hours", "Minutes"], dayRows, { unsortableColumns: [0] });

    appendEntitySection(container, "Listening by Country", "entity-country");
    const countryTotal = profile.byCountry.reduce((sum, c) => sum + c.minutes, 0) || 1;
    const countryRows = profile.byCountry.map((c, idx) => {
        const cfm = formatMinutesToHoursMinutes(c.minutes);
        const percent = ((c.minutes / countryTotal) * 100).toFixed(1) + "%";
        return [(idx + 1).toString(), c.country, cfm.hours.toFixed(2), Math.round(c.minutes).toString(), percent];
    });
    createTable("entity-country", ["#", "Country", "Hours", "Minutes", "% of Total"], countryRows, {
        unsortableColumns: [0],
    });

    appendEntitySection(container, "Platform Breakdown", "entity-platform");
    createTable("entity-platform", ["Platform", "% of Plays"], platformBreakdownRows(profile.platformBreakdown));

    if (type === "artist" && profile.songs.length) {
        appendEntitySection(container, "Songs by This Artist", "entity-artist-songs");
        const songRows = profile.songs.map((s, idx) => {
            const sfm = formatMinutesToHoursMinutes(s.totalMinutes);
            return [(idx + 1).toString(), s.title, sfm.hours.toFixed(2), Math.round(s.totalMinutes).toString(), s.playEvents.toString()];
        });
        createTable(
            "entity-artist-songs",
            ["#", "Song", "Hours", "Minutes", "Play Events"],
            songRows,
            { unsortableColumns: [0] }
        );
    }
}

// Appends a "<h3>title</h3><div id=containerId>" block to an entity detail
// card -- createTable/renderStatTiles fill in the div right after.
function appendEntitySection(container, title, containerId) {
    const section = document.createElement("div");
    section.className = "entity-detail-section";

    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);

    const div = document.createElement("div");
    div.id = containerId;
    section.appendChild(div);

    container.appendChild(section);
}

// ---------- upload tab ----------
// Visualizing a visitor's own Spotify export, entirely client-side: the
// zip is unzipped/parsed/aggregated inside upload-worker.js (a Web Worker,
// so a 50-70MB export doesn't freeze the page), which posts back a
// stats.json-shaped payload that gets handed to `uploadDashboard` -- a
// second, independent instance of the exact same createDashboardController
// factory the built-in Dashboard tab uses (see DASHBOARD_IDS/UPLOAD_IDS
// below). The file itself never leaves the browser.

function setUploadStatus(message) {
    const el = document.getElementById("upload-status");
    const errEl = document.getElementById("upload-error");
    errEl.hidden = true;
    if (!message) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    el.textContent = message;
}

function setUploadError(message) {
    const el = document.getElementById("upload-error");
    const statusEl = document.getElementById("upload-status");
    statusEl.hidden = true;
    el.hidden = false;
    el.textContent = message;
}

function handleUploadedFile(file) {
    if (!file) return;

    if (!/\.zip$/i.test(file.name)) {
        setUploadError("That doesn't look like a .zip file. Upload the file Spotify emailed you, unmodified.");
        return;
    }

    setUploadStatus("Starting...");
    document.getElementById("upload-dashboard").hidden = true;
    document.getElementById("upload-placeholder").hidden = false;

    const worker = new Worker("upload-worker.js");

    worker.onmessage = (e) => {
        const msg = e.data || {};

        if (msg.type === "progress") {
            setUploadStatus(msg.message);
            return;
        }

        if (msg.type === "error") {
            setUploadError(msg.message);
            worker.terminate();
            return;
        }

        if (msg.type === "done") {
            const loaded = uploadDashboard.load(msg.stats);
            if (!loaded) {
                setUploadError("No valid listening data found in that file.");
                worker.terminate();
                return;
            }

            const { validRows, recordsParsed, filesMatched, failedFiles } = msg.meta;
            let summary = `Loaded ${validRows.toLocaleString()} plays from ${filesMatched} file` +
                `${filesMatched === 1 ? "" : "s"} (${recordsParsed.toLocaleString()} records parsed).`;
            if (failedFiles.length) {
                summary += ` ${failedFiles.length} file${failedFiles.length === 1 ? "" : "s"} could not be read and were skipped.`;
            }
            setUploadStatus(summary);

            document.getElementById("upload-placeholder").hidden = true;
            document.getElementById("upload-dashboard").hidden = false;
            worker.terminate();
        }
    };

    worker.onerror = (e) => {
        setUploadError(`Something went wrong reading that file: ${e.message || "unknown error"}.`);
        worker.terminate();
    };

    worker.postMessage({ file });
}

function setupUploadTab() {
    const dropzone = document.getElementById("upload-dropzone");
    const fileInput = document.getElementById("upload-file-input");

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInput.click();
        }
    });

    dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("dragover");
    });
    dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        handleUploadedFile(file);
    });

    fileInput.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        handleUploadedFile(file);
        fileInput.value = ""; // allow re-selecting the same file next time
    });
}

// ---------- tabs + main ----------

// Every container id createDashboardController touches, for the built-in
// Dashboard tab. The Upload tab's dashboard reuses the exact same factory
// with every id prefixed "upload-" instead (see index.html, where that
// second copy of the dashboard markup lives) -- see UPLOAD_IDS below.
const DASHBOARD_IDS = {
    yearTag: "year-tag",
    yearTabs: "year-tabs",
    summary: "summary-content",
    topDays: "top-days-table",
    topSongs: "top-songs-table",
    topArtists: "top-artists-table",
    byCountry: "by-country-table",
    longestStreak: "longest-streak-content",
    mostObsessedDay: "most-obsessed-day-content",
    discoveryRate: "discovery-rate-table",
    skipRate: "skip-rate-content",
    shuffleRatio: "shuffle-ratio-content",
    platformBreakdown: "platform-breakdown-table",
    heatmap: "hour-heatmap-table",
    firstListenedSearchInput: "first-listened-search",
    firstListenedTable: "first-listened-table",
    firstListenedPagination: "first-listened-pagination",
};

const UPLOAD_IDS = Object.fromEntries(
    Object.entries(DASHBOARD_IDS).map(([key, id]) => [key, `upload-${id}`])
);

let builtInDashboard = null;
let uploadDashboard = null;

async function main() {
    showLoader();

    try {
        const res = await fetch("stats.json");
        if (!res.ok) {
            throw new Error(`Failed to load stats.json: ${res.status}`);
        }
        const data = await res.json();

        builtInDashboard = createDashboardController(DASHBOARD_IDS);
        const loaded = builtInDashboard.load(data);

        if (!loaded) {
            hideLoader();
            alert("No years found in stats.json. Run `npm run build` and reload.");
            return;
        }

        dashboardYears = builtInDashboard.years;
        uploadDashboard = createDashboardController(UPLOAD_IDS);

        setupViewTabs();
        setupSearchTypeFilter();
        setupSearchInput();
        setupEntityModal();
        setupUploadTab();
    } catch (err) {
        console.error(err);
        alert("Error loading stats.json. Check the console.");
    }

    hideLoader();
}

main();
