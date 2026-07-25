// Renders the precomputed stats.json (see build-stats.js). No raw export
// parsing happens here -- that all runs at build time via `npm run build`.

let showAllSongs = false;    // false = top 20, true = up to 100
let showAllArtists = false;  // false = top 10, true = up to 20

let statsByYear = {};
let currentYear = null;

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

function hourToShortLabel(hour) {
    const h = Number(hour);
    const suffix = h < 12 ? "a" : "p";
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return `${h12}${suffix}`;
}

function formatMinutesToHoursMinutes(totalMinutes) {
    const hours = totalMinutes / 60;
    return {
        hours,
        hoursText: `${hours.toFixed(2)} hours`,
        minutesText: `${Math.round(totalMinutes)} minutes`,
    };
}

function nightOwlLabel(hour) {
    if (hour >= 22 || hour < 5) return "Night Owl";
    if (hour >= 5 && hour < 11) return "Early Bird";
    if (hour >= 11 && hour < 17) return "Midday Listener";
    return "Evening Listener";
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

function renderStatBars(containerId, items) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "stat-bars";

    items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "stat-bar-row";

        const label = document.createElement("div");
        label.className = "stat-bar-label";
        const labelText = document.createElement("span");
        labelText.textContent = item.label;
        const pctText = document.createElement("span");
        pctText.textContent = `${item.percent.toFixed(1)}%`;
        label.appendChild(labelText);
        label.appendChild(pctText);

        const track = document.createElement("div");
        track.className = "stat-bar-track";
        const fill = document.createElement("div");
        fill.className = "stat-bar-fill";
        fill.style.width = `${Math.min(100, Math.max(0, item.percent)).toFixed(1)}%`;
        track.appendChild(fill);

        row.appendChild(label);
        row.appendChild(track);
        wrap.appendChild(row);
    });

    container.appendChild(wrap);
}

// ---------- PART 1: story mode ----------

function buildStoryCards(year, stats) {
    const total = formatMinutesToHoursMinutes(stats.totalMinutes);
    const topSong = stats.topSongs[0];
    const topArtist = stats.topArtists[0];
    const topSongTotal = topSong ? formatMinutesToHoursMinutes(topSong.totalMinutes) : null;
    const topArtistTotal = topArtist ? formatMinutesToHoursMinutes(topArtist.totalMinutes) : null;
    const peakHourEntry = stats.hourHeatmap[stats.peakHour];
    const peakHourMinutes = peakHourEntry ? peakHourEntry.minutes : 0;
    const maxDiscovery = Math.max(1, ...stats.discoveryByMonth.map((m) => m.count));

    const cards = [
        {
            eyebrow: `Your ${year} Wrapped`,
            big: String(year),
            sub: `${total.hoursText} of music listened this year`,
        },
        topSong && {
            eyebrow: "Your Top Song",
            big: topSong.normalizedTitle,
            sub: `${topSong.displayArtist} • ${topSong.playEvents} plays • ${topSongTotal.hoursText}`,
        },
        topArtist && {
            eyebrow: "Your Top Artist",
            big: topArtist.artist,
            sub: `${topArtistTotal.hoursText} listened this year`,
        },
        {
            eyebrow: nightOwlLabel(stats.peakHour),
            big: hourToAmPm(stats.peakHour),
            sub: `Your peak listening hour — ${Math.round(peakHourMinutes)} minutes logged`,
        },
        {
            eyebrow: "Longest Streak",
            big: `${stats.longestStreak.days} Day${stats.longestStreak.days === 1 ? "" : "s"}`,
            sub: stats.longestStreak.startDate
                ? `${stats.longestStreak.startDate} through ${stats.longestStreak.endDate}, back to back`
                : "Not enough data for a streak",
        },
        stats.mostObsessedDay && {
            eyebrow: "Most Obsessed Day",
            big: stats.mostObsessedDay.song,
            sub: `${stats.mostObsessedDay.playCount} plays in a single day — ${stats.mostObsessedDay.date}`,
        },
        {
            eyebrow: "Discovery",
            big: `${stats.newArtistCount} New Artists`,
            sub: `Found for the first time in ${year}`,
            bars: stats.discoveryByMonth.map((m) => ({
                height: Math.max(4, (m.count / maxDiscovery) * 90),
                title: `Month ${m.month}: ${m.count} new artists`,
            })),
        },
        {
            eyebrow: `That's a Wrap on ${year}`,
            big: `${stats.uniqueSongCount} Songs`,
            sub: `${stats.uniqueArtistCount} artists kept you company this year`,
        },
    ].filter(Boolean);

    return cards;
}

function renderStoryMode(year, stats) {
    const container = document.getElementById("story-mode");
    container.innerHTML = "";

    const cards = buildStoryCards(year, stats);

    cards.forEach((card, idx) => {
        const section = document.createElement("div");
        section.className = `story-card story-card--${idx % 8}`;

        const eyebrow = document.createElement("div");
        eyebrow.className = "story-eyebrow";
        eyebrow.textContent = card.eyebrow;

        const big = document.createElement("div");
        big.className = "story-big";
        big.textContent = card.big;

        const sub = document.createElement("div");
        sub.className = "story-sub";
        sub.textContent = card.sub;

        section.appendChild(eyebrow);
        section.appendChild(big);
        section.appendChild(sub);

        if (card.bars) {
            const barsWrap = document.createElement("div");
            barsWrap.className = "discovery-bars";
            card.bars.forEach((bar) => {
                const barEl = document.createElement("div");
                barEl.className = "discovery-bar";
                barEl.style.height = `${bar.height}px`;
                barEl.title = bar.title;
                barsWrap.appendChild(barEl);
            });
            section.appendChild(barsWrap);
        }

        if (idx < cards.length - 1) {
            const hint = document.createElement("div");
            hint.className = "story-hint";
            hint.textContent = "Scroll ↓";
            section.appendChild(hint);
        }

        container.appendChild(section);
    });

    container.scrollTo({ top: 0 });
}

function isStoryModeActive() {
    const el = document.getElementById("story-mode");
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const viewportCenter = window.innerHeight / 2;
    return rect.top <= viewportCenter && rect.bottom >= viewportCenter;
}

function scrollStoryBy(direction) {
    const container = document.getElementById("story-mode");
    if (!container) return;
    container.scrollBy({ top: direction * container.clientHeight, behavior: "smooth" });
}

function setupStoryKeyboardNav() {
    window.addEventListener("keydown", (e) => {
        if (!isStoryModeActive()) return;

        if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "PageDown") {
            e.preventDefault();
            scrollStoryBy(1);
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "PageUp") {
            e.preventDefault();
            scrollStoryBy(-1);
        }
    });
}

// ---------- PART 2: first listened timeline (all-time) ----------

function renderTimeline(allTime) {
    const container = document.getElementById("timeline-list");
    container.innerHTML = "";

    allTime.firstListenedByArtist.forEach((entry) => {
        const row = document.createElement("div");
        row.className = "timeline-row";

        const date = document.createElement("div");
        date.className = "timeline-date";
        date.textContent = entry.firstDate;

        const artist = document.createElement("div");
        artist.className = "timeline-artist";
        artist.textContent = entry.artist;

        row.appendChild(date);
        row.appendChild(artist);
        container.appendChild(row);
    });
}

// ---------- PART 3: dashboard ----------

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

function renderHeatmap(stats) {
    const container = document.getElementById("hour-heatmap");
    container.innerHTML = "";

    const grid = document.createElement("div");
    grid.className = "heatmap-grid";

    const maxPercent = Math.max(...stats.hourHeatmap.map((h) => h.percent), 0.0001);

    stats.hourHeatmap.forEach((h) => {
        const cell = document.createElement("div");
        cell.className = "heatmap-cell";
        const intensity = 0.08 + (h.percent / maxPercent) * 0.85;
        cell.style.setProperty("--intensity", intensity.toFixed(3));
        cell.textContent = hourToShortLabel(h.hour);
        cell.title = `${hourToAmPm(h.hour)}: ${Math.round(h.minutes)} min (${h.percent.toFixed(1)}%)`;
        grid.appendChild(cell);
    });

    container.appendChild(grid);
}

function renderSkipRate(stats) {
    renderStatBars("skip-rate-content", [
        { label: "Skipped (next-track button)", percent: stats.skipRatePercent },
        { label: "Played through / other end reason", percent: 100 - stats.skipRatePercent },
    ]);
}

function renderShuffleRatio(stats) {
    renderStatBars("shuffle-ratio-content", [
        { label: "Shuffle", percent: stats.shuffleRatio.shufflePercent },
        { label: "On-Demand", percent: stats.shuffleRatio.onDemandPercent },
    ]);
}

function renderPlatformBreakdown(stats) {
    renderStatBars("platform-breakdown-content", [
        { label: "Mobile", percent: stats.platformBreakdown.mobile },
        { label: "Desktop", percent: stats.platformBreakdown.desktop },
        { label: "Other", percent: stats.platformBreakdown.other },
    ]);
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

    renderStoryMode(year, stats);
    renderTopDays(stats);
    renderTopSongs(stats);
    renderTopArtists(stats);
    renderByCountry(stats);
    renderHeatmap(stats);
    renderSkipRate(stats);
    renderShuffleRatio(stats);
    renderPlatformBreakdown(stats);
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
        renderTimeline(data.allTime);
        setupStoryKeyboardNav();
        setActiveYear(years[0]);
    } catch (err) {
        console.error(err);
        alert("Error loading stats.json. Check the console.");
    }

    hideLoader();
}

main();
