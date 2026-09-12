# Wrapped
My own version of wrapped powered by my own Spotify listening data!


# My Spotify Wrapped (Self-Hosted)

This project generates a personal, interactive Spotify Wrapped website using the listening data I exported from Spotify. Stats are precomputed at build time from the raw export files; the site itself is static HTML/CSS/JS that just fetches and renders the precomputed result.

## Architecture

- `stats-lib.js` — the actual aggregation engine (normalizing rows, top songs/artists, streaks, platform categorization, the per-entity search index, etc.), with **no file I/O and no Node-specific APIs**, written once and used two ways: `require()`'d by `build-stats.js` at build time for the committed dataset, and `importScripts()`'d by `upload-worker.js` in the browser for a visitor's own uploaded export. Both paths are guaranteed to aggregate identically because they're the same code.
- `build-stats.js` — a thin Node wrapper (no dependencies) that reads every `data*.json` file in the `data/` folder, hands the rows to `stats-lib.js`, and writes two files: `stats.json` (per-year stats plus an all-time section, powering the Dashboard tab) and `search-index.json` (a full per-artist / per-song profile for every scope — All Time and each individual year — powering the Search tab).
- `stats.json` — fetched on every page load; small, so the dashboard stays fast.
- `search-index.json` — much bigger (tens of thousands of per-entity/per-scope profiles), so it's fetched lazily, only the first time the Search tab is opened.
- `upload-worker.js` — a Web Worker that powers the Upload tab: unzips a visitor's own Spotify export (a hand-rolled ZIP central-directory reader plus the browser's native `DecompressionStream` for inflate — no unzip library needed), parses the JSON inside, and calls into `stats-lib.js` to produce a `stats.json`-shaped result. Runs off the main thread so a 50-70MB export doesn't freeze the page. The file never leaves the browser — no network request is ever made with it.
- `index.html` / `styles.css` / `script.js` — pure static rendering layer. `script.js` does no parsing of raw export data itself; it fetches the two precomputed JSON files for the Dashboard/Search tabs, and hands an uploaded file to `upload-worker.js` for the Upload tab, then renders whatever comes back the same way either time (see `createDashboardController` below).

### Adding new data

1. Drop new `data*.json` export files in the `data/` folder (any filename matching `data<number>.json`, not just `data1`–`data11`).
2. Run:
   ```
   npm run build
   ```
   This regenerates `stats.json` and `search-index.json` from every `data*.json` file present in `data/`.
3. Commit `stats.json`, `search-index.json` (and `index.html`/`styles.css`/`script.js` if changed) and deploy. **Do not** commit the raw `data*.json` files — see Privacy below.

## Privacy: raw export files are never deployed

The raw Spotify export contains `ip_addr` for every play event. `build-stats.js` never reads that field into any output-bound object, so it's structurally impossible for it to end up in `stats.json`. On top of that:

- `.gitignore` excludes the entire `data/` folder, so none of the raw export files it contains ever get committed.
- `.vercelignore` excludes the entire `data/` folder from anything uploaded to Vercel.

The only data files that ship to the browser are `stats.json` and `search-index.json`, both derived exclusively from the same PII-free row shape — no IP addresses, no raw per-event data, for the dashboard or for any individual artist/song lookup. The Upload tab holds to this too, just without a build step in between: `upload-worker.js` calls the exact same `recordToRow` (never reads `ip_addr`) before anything else touches an uploaded file, and the file itself is never sent anywhere — everything happens in that one browser tab. The Upload tab's auto-save (see below) only ever writes that same PII-free aggregated shape to IndexedDB — still on-device, never networked.

## Layout

A **Dashboard** / **Search** / **Upload** switcher sits under the header. Dashboard is the original single-page layout, year-scoped by the tabs below it; Search is a lookup tool for any one artist or song in the built-in dataset; Upload is a second, fully independent copy of the Dashboard fed by a visitor's own uploaded export instead. The whole site is responsive down to phone widths — cards, tables (via their own horizontal-scroll wrapper), tabs, and the search inputs all adapt below ~700px and ~420px breakpoints.

### Dashboard tab

Same feel as the original site, just with more sections. Top to bottom:

1. Header (title + year tag) and a year-tab switcher — same as the original, plus an **All Time** tab alongside each individual year
2. Overview (total hours/minutes, unique songs/artists)
3. Top Songs, Top Artists, Top Listening Days — same as the original, tables in a `.card`
4. Longest Listening Streak, Most Obsessed Day, Discovery Rate, Skip Rate, Shuffle vs On-Demand, Platform Breakdown — new stats, each its own `.card`, reusing the same stat-tile/table styling as everything else
5. Listening by Country — same as the original
6. 24-Hour Listening Heatmap — a plain table (hour / minutes / % of day), rows lightly tinted with the existing Spotify green to hint at intensity
7. First Listened — at the very bottom, a searchable, sortable, paginated table of every artist, all-time, sorted earliest to latest by default (25 per page). Not affected by the year switcher, since it spans every year at once; every other section above it is.

No scroll-snap, no full-viewport cards, no sticky nav — everything is a normal `.card` section in normal page flow, and the year switcher just re-renders the year-scoped sections' content in place.

**All Time tab.** Every year-scoped section (everything except First Listened, which was already all-time) has a real all-time equivalent: top songs/artists computed across every year combined, the true longest streak and most-obsessed-day across all history, etc. Discovery Rate becomes a full month-by-month timeline (e.g. "July 2024") instead of a repeating Jan–Dec cycle, since there's no single year to bucket it into.

**Sortable tables.** Every table's column headers are clickable — click to sort, click again to reverse. Numeric-looking columns (including `%` values) sort numerically; everything else sorts alphabetically. The 24-hour heatmap's shading is re-derived from each row after sorting, so it stays correct regardless of order. First Listened's sort applies to the full filtered list before pagination (not just the current page).

### Search tab

Look up the full profile of any artist or song ever logged. A text search matches artist names and song titles (plus, for songs, the artist name); a "Type" filter narrows to Artists or Songs; a "Time period" filter defaults to **All Time** and can be set to any single year — the results list, ranks, and every stat below re-scope to whichever period is selected.

Clicking a result opens a modal (a centered dialog on desktop, a fullscreen sheet on mobile — closes via the X, the backdrop, or Escape) with everything `search-index.json` has for that entity in the selected period:

- Stat tiles: total hours/minutes, play events, rank (e.g. "#12 of 340 artists"), first/last listened, skip rate, shuffle %, and (artists only) unique song count
- Monthly Trend — a real calendar timeline (e.g. "July 2024"), shaded the same way as the 24-hour heatmap
- Top Listening Days, Listening by Country, Platform Breakdown — same shape as their Dashboard equivalents, just scoped to this one entity
- Artists additionally get a sortable "Songs by This Artist" table; songs instead show their artist as a link that jumps straight to that artist's own profile

### Upload tab

Visualize your own Spotify data instead of (well, alongside — it's its own tab) the built-in dataset. Request your "Extended Streaming History" from Spotify's privacy page, drop the `.zip` it emails you into the drop-zone (or click it to pick a file), and `upload-worker.js` unzips, parses, and aggregates it entirely in your browser — no server round trip, ever. Once it's done, the Upload tab shows a **complete second copy of the Dashboard** (year tabs, Overview, Top Songs/Artists, streaks, Discovery Rate, Platform Breakdown, First Listened, all of it) rendered from your own data, side by side with — not replacing — the built-in one on the Dashboard tab, plus its own **mini search** at the bottom: the same year/type-filtered artist/song lookup as the main Search tab (same entity-detail modal, same "Songs by This Artist"/cross-link behavior), just scoped to your upload instead of the built-in dataset. Both the Dashboard-style rendering and the search are the exact same code as the built-in tabs — see `createDashboardController`/`createSearchController` in `script.js` — just fed from a different data source, so there's nothing uploaded data can see or do less of.

Scope, for this first version: music tracks only, same as the Dashboard/Search tabs — podcast episodes and audiobook chapters are recognized (so they don't corrupt aggregation) but excluded from the stats, identically to how the built-in dataset is filtered.

**Saved locally, automatically.** A successful upload is saved to your browser (via IndexedDB, not `localStorage` — see below) so it's still there the next time you open the site, without re-uploading. A "Forget My Data" button (shown once something's saved) deletes it immediately. If your browser doesn't support IndexedDB, the tab still works for the current visit; it just won't persist.

*Why IndexedDB and not `localStorage`?* `localStorage`'s per-origin quota is typically 5-10MB and it's synchronous (blocks the page while reading/writing). This repo's own `search-index.json`, for one real 11-year history, is already 15+ MB — a visitor's own upload (which now also generates an equivalent search index, for the mini search) could just as easily land in that range. IndexedDB has no such practical ceiling for data this size, is asynchronous, and stores plain JS objects directly — no library needed, just a handful of Promise-wrapped calls against the browser's built-in `indexedDB` API.

Needs a browser with `DecompressionStream` support (Chrome, Edge, Firefox, and Safari have all shipped it) since that's what inflates the zip's compressed entries; anything older gets a plain error message rather than a silent failure.

## Statistics

### Per year
- Top songs (merged across versions such as Live, Acoustic, Remastered) and top artists
- Top listening days and a 24-hour listening heatmap
- Longest listening streak (consecutive days with a play)
- Most obsessed day (single song with the most repeat plays in one day)
- Discovery rate (new artists heard for the first time, by month)
- Skip rate (% of plays ended via next-track)
- Shuffle vs. on-demand ratio
- Platform breakdown — bucketed from the raw, often messy `platform` string (e.g. `"Windows 10 (10.0.19044; x64; AppX)"`, `"Partner SCEI sony_tv;ps4;..."`) into iOS / Android / Windows / Mac / Linux / Web / TV / Game Console / Cast / Other, rather than rendered as a fixed three-way split
- Listening activity by country

### All-time
- Everything in "Per year" above, computed across every year combined (own tab), plus:
- First Listened date per artist, across every year combined

### Expandable Tables
- Top songs: shows the top 20 by default, expandable to the top 100
- Top artists: shows the top 10 by default, expandable to the top 20

## Project Structure

```
/
├── stats-lib.js           # shared aggregation engine (Node require() + browser importScripts())
├── build-stats.js         # build-time wrapper around stats-lib.js (npm run build)
├── upload-worker.js       # browser Worker: unzips + aggregates an uploaded export via stats-lib.js
├── package.json
├── stats.json              # generated output, committed, fetched by the Dashboard tab
├── search-index.json        # generated output, committed, lazily fetched by the Search tab
├── index.html
├── styles.css
├── script.js
├── data/                    # raw exports, gitignored entirely -- never committed
│   ├── data1.json
│   ├── data2.json
│   └── ... data<N>.json
├── spotify.jpg               # tab icon
├── .gitignore
├── .vercelignore
└── vercel.json
```

## Obtaining Spotify Data

1. Visit https://www.spotify.com/account/privacy
2. Request the extended streaming history
3. Download the provided JSON files
4. Add them to the `data/` folder as `data<N>.json`
5. Run `npm run build` to regenerate `stats.json` and `search-index.json`

## Technologies Used

- HTML, CSS, JavaScript for the site
- Node.js (no external dependencies) for the build-time precompute step
- Native browser `fetch` for loading `stats.json` / `search-index.json`
- A Web Worker, a hand-rolled ZIP central-directory reader, and the native `DecompressionStream` API for the Upload tab — no unzip or compression library, keeping the project fully dependency-free on both the build and the browser side
- IndexedDB (native browser API, no library) for auto-saving an uploaded dataset across visits

I built this project as a personal way to explore my Spotify listening history and visualize it year by year.
