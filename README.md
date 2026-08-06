# tasteoff

A phone-first web app for judging food competitions. Judges score dishes on their
own phones (seeing only blind codes); scores stream to a live organizer dashboard
that ranks teams two ways — **Scaled** (all judges) and **Min-Max** (drop each
dish's high & low) — matching the HouBBQ Throwdown scoring workbook exactly.

- **Front-end:** static HTML/JS/CSS (no build step) → hosted on GitHub Pages.
- **Backend:** Firebase (Firestore) with silent anonymous auth.
- **Offline-first PWA:** installs to the home screen; judges can score with no
  signal and scores sync automatically (Firestore offline cache).
- **Event-agnostic:** all criteria, weights, judges, teams, and codes come from
  the in-app admin screen. HouBBQ 2026 is just the first saved event.

## One-time Firebase setup (free Spark plan)

The web config is already wired into `firebase.js`. You just need to flip two
toggles in the [Firebase console](https://console.firebase.google.com/) for
project **judging-app-dd929**:

1. **Enable Anonymous sign-in**
   Authentication → Get started → Sign-in method → **Anonymous** → Enable → Save.

2. **Create Firestore + apply the rules**
   - Firestore Database → Create database → location `nam5 (US)` → **Production mode**.
   - Firestore Database → **Rules** tab → paste the contents of
     [`firestore.rules`](firestore.rules) → **Publish**.

That's it — no billing, no card. (Photos on the judge form would need Storage,
which requires the paid Blaze plan; deferred to a later version.)

## Try it with zero setup

Open `index.html` and click **"Try the demo"** — it runs the full app (HouBBQ
2026 sample) entirely in memory, no Firebase needed. Great for a walkthrough.

## Deploy to GitHub Pages

```bash
git init && git add . && git commit -m "tasteoff v1"
gh repo create Compo-CF/tasteoff --public --source=. --push
```

Then in the repo: **Settings → Pages → Source: Deploy from a branch → `main` / root**.
Live at `https://compo-cf.github.io/tasteoff/`.

## Running an event

1. **Set up the event in a spreadsheet (recommended).** Open the app → **Set up
   event** → download **`TasteOff-Template.xlsx`**. It has four tabs — **Event,
   Criteria, Judges, Teams** — pre-filled with HouBBQ 2026 as an example. Edit it
   in Google Sheets or Excel (event name, criteria + weights, judges → table,
   restaurant roster, blind codes, dish descriptions), then import it:
   - **Google Sheet:** share it "Anyone with the link → Viewer", paste the link,
     click **Import URL**; or
   - **File:** **Upload** the `.xlsx`/`.csv`.

   The in-app forms below the import panel still work for quick tweaks — including
   **Auto-fill codes & serve times** — but you never have to type the whole event in.
   Set admin/results passcodes and **Save event.**
2. **Judge links & QR** → print/display the Table A and Table B QR codes at each
   table. Judges scan → pick their name → score.
3. Open the **Results** dashboard (passcode) on your laptop to watch live. Toggle
   **reveal team names** only when you're ready to announce. **Export CSV** for records.

### Seed HouBBQ 2026 directly

Open `seed.html` and click the button to write the HouBBQ Throwdown 2026 event
(6 criteria, 5 judges, 13 teams + real blind codes) straight to Firestore.

## Files

| File | Purpose |
|------|---------|
| `index.html` | app shell + PWA registration |
| `app.js` | router + Admin / Judge / Results views |
| `scoring.js` | pure scoring engine (Scaled + Min-Max), ported from the workbook |
| `firebase.js` | Firebase init, anon auth, Firestore data layer, demo mode |
| `sample-event.js` | HouBBQ 2026 data (single source for seed + demo) |
| `import-sheet.js` | parse an uploaded file / Google Sheet into an event |
| `TasteOff-Template.xlsx` | the event setup template (Event/Criteria/Judges/Teams) |
| `seed-houbbq.js` / `seed.html` | one-click Firestore seed |
| `firestore.rules` | security rules to paste into the console |
| `sw.js` / `manifest.webmanifest` | offline PWA |
| `vendor/qrcode.js` | local QR generator (works offline) |

## Scoring math (matches the workbook)

Each criterion `i` has weight `wᵢ` (weights sum to 1.0) and a scale factor
`SFᵢ = wᵢ × 6 × 1.2`. A judge scores each criterion 1–5 in 0.5 steps.

- **Scaled** dish total = `Σᵢ SFᵢ × Σⱼ(scoreᵢⱼ)` (all judges)
- **Min-Max** dish total = `Σᵢ SFᵢ × (Σⱼ scoreᵢⱼ − maxⱼ − minⱼ)` (drop hi & low per criterion)
