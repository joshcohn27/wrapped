# Wrapped

My own version of Spotify Wrapped, built from the extended streaming history export Spotify sends you on request. It shows my listening stats from 2016 to 2026, and anyone else can upload their own export to see the same thing for their data.

Live site: https://wrapped.joshbcohn.com

## Features

**Dashboard.** Pick a year or All Time and every section updates:

- Overview: total hours, total minutes, unique songs, unique artists
- Top songs (top 20, expandable to 100) and top artists (top 10, expandable to 20)
- Top five listening days
- Longest listening streak
- Most obsessed day: the one song replayed the most in a single day
- Discovery rate: artists heard for the first time, by month
- Skip rate and shuffle vs on-demand
- Platform breakdown and listening by country
- 24-hour listening heatmap
- First Listened: every artist with the date I first heard them, searchable and paginated

Every table sorts when you click a column header.

**Search.** Look up any artist or song, filtered by type and by time period (All Time or a single year). Clicking a result opens its full profile: listening time, play count, rank, first and last listened, skip rate, shuffle percentage, monthly trend, top days, countries, and platforms. Artist profiles also list their songs, and song profiles link back to the artist.

**Upload.** Drop in the `.zip` Spotify emails you and get the same dashboard and search for your own data. The file is unzipped and processed in your browser and is never sent anywhere. The result is saved in your browser's IndexedDB so it is still there next visit, and a Forget My Data button deletes it.

The layout works down to phone widths.

## Tech stack

- HTML, CSS, and plain JavaScript. No framework and no npm dependencies.
- Node.js for the build script, standard library only.
- Browser APIs for the Upload tab: a Web Worker, `DecompressionStream` for unzipping, and IndexedDB for saving.

## How the data flows

1. Raw Spotify export files live in `data/` as `data1.json`, `data2.json`, and so on. That folder is gitignored.
2. `npm run build` runs `build-stats.js`, which reads every `data<number>.json` file and passes the records to `stats-lib.js`.
3. `stats-lib.js` does all the aggregation. It keeps only music plays (podcasts and audiobooks are dropped), merges versions of the same song (Live, Remastered, and so on), and ranks by listening time.
4. The build writes two files, both committed:
   - `stats.json`: per-year and all-time stats for the Dashboard. Loaded on every page view.
   - `search-index.json`: a profile for every artist and song, for every year and all-time. It is about 16 MB, so it is only loaded the first time the Search tab is opened.
5. `script.js` fetches those files and renders them. It does no parsing of raw data itself.

The Upload tab skips the build step. `upload-worker.js` reads the zip, finds the `Streaming_History_Audio_*.json` and `Streaming_History_Video_*.json` files inside, and runs them through the same `stats-lib.js`, so uploaded data is aggregated exactly like mine.

The raw export includes an IP address for every play. `stats-lib.js` never reads that field, so it cannot end up in either output file.

## Running it locally

There is nothing to install. `package.json` has no dependencies and one script:

```
npm run build
```

That regenerates `stats.json` and `search-index.json` from whatever is in `data/`. You only need it when the raw data changes, since both output files are already committed.

There is no dev script. Serve the repo root with any static file server, for example:

```
python -m http.server 8080
```

Opening `index.html` directly as a file will not work, because the page fetches its JSON and starts a Web Worker.

To add new data, drop more `data<number>.json` files into `data/`, run the build, and commit the two regenerated JSON files. Do not commit the raw export files.

## Configuration

No environment variables, API keys, or other secrets are needed. The only input is the export files in `data/`.

## Deployment

Hosted on Vercel at wrapped.joshbcohn.com. Vercel serves the repo as a static directory and does not run the build, so the committed `stats.json` and `search-index.json` are what goes live. `.vercelignore` keeps `data/` and `build-stats.js` out of the deploy.
