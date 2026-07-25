# Wrapped
My own version of wrapped powered by my own Spotify listening data!


# My Spotify Wrapped (Self-Hosted)

This project generates a personal, interactive Spotify Wrapped website using the listening data I exported from Spotify. Stats are precomputed at build time from the raw export files; the site itself is static HTML/CSS/JS that just fetches and renders the precomputed result.

## Architecture

- `build-stats.js` — a Node script (no dependencies) that reads every `data*.json` file in the project root, normalizes and aggregates it, and writes a single `stats.json` containing per-year stats plus an all-time section.
- `stats.json` — the only data file the browser ever fetches. Committed to the repo so the site works without a build step at deploy time.
- `index.html` / `styles.css` / `script.js` — pure static rendering layer. `script.js` does no parsing of raw export data; it only fetches `stats.json` and renders it.

### Adding new data

1. Drop new `data*.json` export files in the project root (any filename matching `data<number>.json`, not just `data1`–`data4`).
2. Run:
   ```
   npm run build
   ```
   This regenerates `stats.json` from every `data*.json` file present.
3. Commit `stats.json` (and `index.html`/`styles.css`/`script.js` if changed) and deploy. **Do not** commit the raw `data*.json` files — see Privacy below.

## Privacy: raw export files are never deployed

The raw Spotify export contains `ip_addr` for every play event. `build-stats.js` never reads that field into any output-bound object, so it's structurally impossible for it to end up in `stats.json`. On top of that:

- `.gitignore` excludes `data*.json` going forward, so new export files never get committed. (`data1.json` was already tracked before this rule existed and stays in history — it isn't retroactively removed.)
- `.vercelignore` excludes `data*.json` from anything uploaded to Vercel, so even the already-tracked `data1.json` is never part of a deployment.

The only data file that ships to the browser is `stats.json`, which contains aggregated listening stats — no IP addresses, no raw per-event data.

## Layout

The page is a single scroll made of three parts:

1. **Story mode** — a sequence of full-viewport cards (cold open, top song, top artist, peak listening hour, longest streak, most obsessed day, discovery, closing stats), navigated by scroll-snap or arrow keys. Re-renders when you switch years.
2. **First Listened timeline** — a vertical, all-time list of every artist sorted by the day I first heard them. Not affected by the year switcher, since it spans every year at once.
3. **Dashboard** — the detailed view: expandable top songs/artists tables, top listening days, by-country breakdown, a 24-hour listening heatmap, skip rate, shuffle ratio, and platform breakdown, with a sticky jump-nav (Songs / Artists / Habits / Patterns). Respects the year switcher.

A slim fixed topbar at the top holds the year switcher and stays accessible across all three parts.

## Statistics

### Per year
- Top songs (merged across versions such as Live, Acoustic, Remastered) and top artists
- Top listening days and a 24-hour listening heatmap
- Longest listening streak (consecutive days with a play)
- Most obsessed day (single song with the most repeat plays in one day)
- Discovery rate (new artists heard for the first time, by month)
- Skip rate (% of plays ended via next-track)
- Shuffle vs. on-demand ratio
- Platform breakdown (mobile / desktop / other)
- Listening activity by country

### All-time
- First Listened date per artist, across every year combined

### Expandable Tables
- Top songs: shows the top 20 by default, expandable to the top 100
- Top artists: shows the top 10 by default, expandable to the top 20

## Project Structure

```
/
├── build-stats.js       # build-time precompute script (npm run build)
├── package.json
├── stats.json            # generated output, committed, the only thing the browser fetches
├── index.html
├── styles.css
├── script.js
├── data1.json             # raw export (tracked already; new ones are gitignored)
├── spotify.jpg             # tab icon
├── .gitignore
├── .vercelignore
└── vercel.json
```

## Obtaining Spotify Data

1. Visit https://www.spotify.com/account/privacy
2. Request the extended streaming history
3. Download the provided JSON files
4. Add them to this project root as `data<N>.json`
5. Run `npm run build` to regenerate `stats.json`

## Technologies Used

- HTML, CSS, JavaScript for the site
- Node.js (no external dependencies) for the build-time precompute step
- Native browser `fetch` for loading `stats.json`

I built this project as a personal way to explore my Spotify listening history and visualize it year by year.
