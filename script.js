// Renders the precomputed stats.json (see build-stats.js). No raw export
// parsing happens here -- that all runs at build time via `npm run build`.

let showAllSongs = false;    // false = top 20, true = up to 100
let showAllArtists = false;  // false = top 10, true = up to 20

let statsByYear = {};
let currentYear = null;

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

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

function monthName(monthNumber) {
    return MONTH_NAMES[monthNumber - 1] || String(monthNumber);
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
        rows
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
    const rows = stats.discoveryByMonth.map((m) => [
        monthName(m.month),
        m.count.toString(),
    ]);

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

// 24-hour heatmap as a plain table, using the same table styling as every
// other section. Each row gets a light background tint (existing Spotify
// green) scaled to how much that hour was listened to, relative to the
// year's peak hour -- numbers first, shading is just a hint.
function renderHeatmap(stats) {
    const container = document.getElementById("hour-heatmap-table");
    container.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["Hour", "Minutes", "% of Day"].forEach((col) => {
        const th = document.createElement("th");
        th.textContent = col;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    const tbody = document.createElement("tbody");
    const maxPercent = Math.max(...stats.hourHeatmap.map((h) => h.percent), 0.0001);

    stats.hourHeatmap.forEach((h) => {
        const tr = document.createElement("tr");
        const intensity = 0.05 + (h.percent / maxPercent) * 0.3;
        tr.style.backgroundColor = `rgba(30, 215, 96, ${intensity.toFixed(3)})`;

        [hourToAmPm(h.hour), Math.round(h.minutes).toString(), `${h.percent.toFixed(1)}%`].forEach((val) => {
            const td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    wrapper.appendChild(table);
    container.appendChild(wrapper);
}

// ---------- all-time (not year-scoped) ----------

function renderFirstListened(allTime) {
    const rows = allTime.firstListenedByArtist.map((entry, idx) => [
        (idx + 1).toString(),
        entry.artist,
        entry.firstDate,
    ]);

    createTable("first-listened-table", ["#", "Artist", "First Heard"], rows);
}

// ---------- tabs + main ----------

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

    document.querySelectorAll(".tab-button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.year === String(year));
    });

    const yearTag = document.getElementById("year-tag");
    if (yearTag) {
        yearTag.textContent = year;
    }

    const stats = statsByYear[year];
    if (!stats) return;

    showAllSongs = false;
    showAllArtists = false;

    renderSummary(year, stats);
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
        renderFirstListened(data.allTime);
        setActiveYear(years[0]);
    } catch (err) {
        console.error(err);
        alert("Error loading stats.json. Check the console.");
    }

    hideLoader();
}

main();
