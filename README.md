# Wrapped
My own version of wrapped powered by my own Spotify listening data!


# My Spotify Wrapped (Self-Hosted)

This project generates a personal, interactive Spotify Wrapped website using the listening data I exported from Spotify. It processes multiple JSON files, automatically groups plays by year, and displays detailed listening statistics entirely in the browser. Everything is computed client-side using only HTML, CSS, and JavaScript.

## Features

### Multi-Year Support
- Automatically detects all years present in my exported data  
- Tabbed interface for switching between years  
- Each year renders its own statistics independently

### Listening Statistics
- Top songs (merged across versions such as Live, Acoustic, Remastered)  
- Top artists  
- Top listening days  
- Peak listening hours (AM/PM)  
- Listening activity by country

### Expandable Tables
- Top songs: shows the top 20 by default, expandable to the top 100  
- Top artists: shows the top 10 by default, expandable to the top 20

### Loading Overlay
A loading screen appears while all JSON data files are fetched and processed.

### Fully Client-Side
The website runs on HTML, CSS, and JavaScript only. No backend server, no frameworks, and no API keys.

## Project Structure

/
├── index.html
├── styles.css
├── script.js
├── data1.json
├── data2.json
├── data3.json
├── data4.json
└── spotify.jpg (tab icon)

I am currently using four Spotify data files.

## Obtaining Spotify Data

1. Visit https://www.spotify.com/account/privacy  
2. Request the extended streaming history  
3. Download the provided JSON files  
4. Add them to this project and rename them if needed  
5. Update the list of files in `DATA_FILES` in `script.js`  
   Example:
```js
const DATA_FILES = ["data1.json", "data2.json", "data3.json", "data4.json"];
```

This is currently running on a server at: people.rit.edu/~jbc6612/wrapped


## Technologies Used

- HTML  
- CSS  
- JavaScript  
- Native browser `fetch` for loading JSON  
- All processing and rendering performed client-side

I built this project as a personal way to explore my Spotify listening history and visualize it year by year.






