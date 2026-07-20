# Dragonwilds Resource Planner

A tiny client-side tool for [RuneScape: Dragonwilds](https://dragonwilds.runescape.wiki/):
pick craftable items + quantities and get one combined raw-material shopping
list, computed recursively from a plain-JS recipe database. Everything runs
in the browser — your plan list is saved to `localStorage`, nothing is sent
to a server.

## Getting started

```
npm install
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:5173`). Search or
filter for an item (by name, category, station, or power level), click it to
add it to your plan list with the quantity you set, and repeat for as many
items as you're planning to craft. The combined shopping list and per-item
recipe breakdown update automatically.

## Project layout

```
src/
  data/items.js     <- the recipe database (~500 items)
  lib/planner.js    <- pure recursive planning logic, no DOM. Easy to unit test.
  main.js           <- wires the DOM to the planner (filters, plan list, output)
  style.css
index.html

scripts/
  scrape-wiki-items.js     <- pulls craftable items from the wiki's API
  merge-scraped-items.js   <- merges scraper output into src/data/items.js
```

## Updating the item database from the wiki

`src/data/items.js` is scraped from the
[Dragonwilds wiki](https://dragonwilds.runescape.wiki/) via its MediaWiki
API (no HTML scraping — the wiki exposes wikitext directly). To pull in
anything new the wiki has added:

```
node scripts/scrape-wiki-items.js          # defaults to Category:Artisan
node scripts/scrape-wiki-items.js Weapons  # or scrape a different category
```

This does two passes:

1. Crawls the given category for pages with a `{{Recipe}}` template.
2. **Leaf-resolution**: any ingredient referenced by a recipe (old or new)
   that isn't itself a known item gets looked up directly by exact page
   title, regardless of what category it's filed under, repeating on
   whatever *that* page references — until nothing new turns up. This is
   what catches ore/log/thread-type pages that feed into bars and other
   basic materials but live outside the main category.

It writes `scripts/output/scraped-items.js` (new candidates, gitignored —
regenerate any time) and `scripts/output/scrape-report.md`, which flags:
- items with an ambiguous guessed category,
- items with alternate recipes on the wiki (only the first is kept),
- confirmed raw/gathered materials (correctly left out of the database),
- anything referenced but not found on the wiki (usually a typo — worth checking).

Review the report, then merge the candidates in:

```
node scripts/merge-scraped-items.js
```

This inserts new entries alphabetically into `src/data/items.js`, leaving
every existing entry's exact formatting untouched, and skips anything
whose key is already present.

## Adding items by hand

Copy an existing entry in `src/data/items.js` and fill in `category`,
`station`, `powerLevel` (optional), and `recipe` — an array of
`[materialName, quantity]` pairs. If `materialName` matches another key in
this file, the planner recurses into it automatically; otherwise it's
treated as a raw/gathered resource. No other code needs to change.

## Deploying

This is a static Vite app with no backend — `npm run build` outputs to
`dist/`. It deploys with zero configuration on [Vercel](https://vercel.com)
(import the GitHub repo, framework preset "Vite" is auto-detected) or any
other static host (GitHub Pages, Netlify, etc).
