# Digital Fasting · Ode to Minecraft (PWA)

Offline-first tracker: seven daily scores plus bonus points, a running total toward 5,300, charts, streaks, and a PIN-protected parent mode. All totals are calculated by the app.

## Run it
A PWA needs HTTPS (or localhost) for install and offline support. Easiest free options:

- **Try locally:** `python3 -m http.server 8080` in this folder, then open http://localhost:8080
- **Host for all devices (free):** drag this folder onto Netlify Drop, or push it to GitHub Pages / Cloudflare Pages. Open the HTTPS link on each device.

## Install
- **Android (Chrome):** menu → Install app
- **iPad (Safari):** Share → Add to Home Screen
- **Windows (Edge/Chrome):** install icon in the address bar

## Parent mode
First tap of the lock creates a 4–8 digit PIN and shows a one-time recovery code. Write it down. Editing saved scores, rules, goal and imports need the PIN; it auto-locks after inactivity.

## First run on a new device
1. Open the app, tap the lock, create the PIN and save the recovery code.
2. Settings → Import file… and choose your private backup (`my-data.json`). Keep that file out of this repository.

## Data
Stored on each device (IndexedDB). Phone, iPad and PC do not sync. Use Settings → Export JSON / Import to move data.

## Free open-source libraries (vendored in /vendor)
Alpine.js (reactivity) · Dexie (storage) · Chart.js (charts) · anime.js (animation) · canvas-confetti (celebrations)

After changing any file, bump `CACHE` in `sw.js` so devices pick up the update.
