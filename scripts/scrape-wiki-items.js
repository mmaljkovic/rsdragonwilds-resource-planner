// Scrapes https://dragonwilds.runescape.wiki for craftable items via the
// MediaWiki API (no HTML scraping — the wiki exposes wikitext directly).
//
// Usage:
//   node scripts/scrape-wiki-items.js [CategoryName]
//
// Defaults to "Artisan" (i.e. Category:Artisan). Run with e.g.
//   node scripts/scrape-wiki-items.js Weapons
// to scrape a different category.
//
// After the category crawl, it also runs a leaf-resolution pass: every
// material name referenced by a recipe (in items.js or in what was just
// scraped) that isn't itself a known item gets looked up directly on the
// wiki by exact page title, regardless of what category it's filed under.
// If that page has its own {{Recipe}}, it gets pulled in too, and its own
// ingredients are checked the same way — repeating until nothing new turns
// up. This is what catches things like ore/log/thread pages that feed into
// bars and other basic materials but live outside Category:Artisan.
//
// Output:
//   scripts/output/scraped-items.js   — new items formatted like items.js,
//                                        ready to review and paste in.
//   scripts/output/scrape-report.md   — pages skipped/ambiguous, for manual follow-up.
//
// This only extracts items with a `{{Recipe}}` template (i.e. actually
// craftable). Pages already present as a key in src/data/items.js are
// skipped so the output only contains new candidates.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const API = "https://dragonwilds.runescape.wiki/api.php";
const UA = "dragonwilds-planner-scraper/1.0 (personal item-database tooling)";

const categoryArg = process.argv[2] || "Artisan";
const CATEGORY = `Category:${categoryArg}`;

async function apiGet(params) {
  const url = new URL(API);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`API request failed: ${res.status} ${url}`);
  return res.json();
}

async function getCategoryMembers(category) {
  const titles = [];
  let cmcontinue;
  do {
    const data = await apiGet({
      action: "query",
      list: "categorymembers",
      cmtitle: category,
      cmlimit: "500",
      ...(cmcontinue ? { cmcontinue } : {}),
    });
    for (const m of data.query.categorymembers) {
      if (m.ns === 0) titles.push(m.title);
    }
    cmcontinue = data.continue?.cmcontinue;
  } while (cmcontinue);
  return titles;
}

// Map<title, { content: string|null, missing: boolean }>. `missing` means
// the title doesn't exist on the wiki at all (as opposed to existing but
// having no {{Recipe}} template, which is a normal "it's a raw resource" case).
async function queryPages(titles) {
  const data = await apiGet({
    action: "query",
    prop: "revisions",
    rvslots: "main",
    rvprop: "content",
    titles: titles.join("|"),
  });
  const out = new Map();
  const pages = data.query?.pages || {};
  for (const page of Object.values(pages)) {
    const content = page.revisions?.[0]?.slots?.main?.["*"] ?? null;
    out.set(page.title, { content, missing: "missing" in page });
  }
  return out;
}

async function getWikitextBatch(titles) {
  const pages = await queryPages(titles);
  const out = new Map();
  for (const [title, info] of pages) {
    if (info.content != null) out.set(title, info.content);
  }
  return out;
}

// Extracts all top-level {{Name ...}} template blocks by brace-depth counting
// (so nested templates/links inside don't confuse the boundary).
function findTemplates(wikitext, name) {
  const results = [];
  const startRe = new RegExp(`\\{\\{\\s*${name}\\s*[|}]`, "ig");
  let m;
  while ((m = startRe.exec(wikitext))) {
    const start = m.index;
    let depth = 0;
    let i = start;
    while (i < wikitext.length) {
      if (wikitext.startsWith("{{", i)) {
        depth++;
        i += 2;
        continue;
      }
      if (wikitext.startsWith("}}", i)) {
        depth--;
        i += 2;
        if (depth === 0) break;
        continue;
      }
      i++;
    }
    results.push(wikitext.slice(start, i));
    startRe.lastIndex = i;
  }
  return results;
}

// Parses `{{Name | key = value | key2 = value2 | anon }}` into an object,
// splitting on top-level pipes only (respects nested {{}} and [[]]).
function parseTemplateParams(templateText) {
  const bodyStart = templateText.indexOf("|");
  const inner =
    bodyStart === -1
      ? ""
      : templateText.slice(bodyStart + 1, templateText.length - 2);
  const parts = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let current = "";
  let i = 0;
  while (i < inner.length) {
    if (inner.startsWith("{{", i)) {
      braceDepth++;
      current += "{{";
      i += 2;
      continue;
    }
    if (inner.startsWith("}}", i)) {
      braceDepth--;
      current += "}}";
      i += 2;
      continue;
    }
    if (inner.startsWith("[[", i)) {
      bracketDepth++;
      current += "[[";
      i += 2;
      continue;
    }
    if (inner.startsWith("]]", i)) {
      bracketDepth--;
      current += "]]";
      i += 2;
      continue;
    }
    if (inner[i] === "|" && braceDepth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = "";
      i++;
      continue;
    }
    current += inner[i];
    i++;
  }
  if (current.length) parts.push(current);

  const params = {};
  let anonIndex = 1;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    if (eqIdx > -1) {
      const key = part.slice(0, eqIdx).trim().toLowerCase();
      const value = part.slice(eqIdx + 1).trim();
      params[key] = value;
    } else {
      params[`__anon${anonIndex++}`] = part;
    }
  }
  return params;
}

// Strips [[Link|Display]] / [[Link]] wiki markup down to a plain name.
function stripLink(s) {
  if (!s) return s;
  return s
    .replace(/\[\[([^|\]]+)\|[^\]]+\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .trim();
}

function extractInfobox(wikitext, name) {
  const templates = findTemplates(wikitext, name);
  return templates.length ? parseTemplateParams(templates[0]) : null;
}

// Strips all top-level {{...}} template blocks (by brace-depth, so nested
// templates inside don't leak through) leaving just the surrounding prose.
function stripAllTemplates(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith("{{", i)) { depth++; i += 2; }
        else if (text.startsWith("}}", i)) { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

// The opening descriptive paragraph (e.g. "The '''X''' is a [[Power level]]
// 3 One-Handed Melee Weapon...") — everything before the first section
// heading, with the leading infobox/external templates stripped out.
// (A naive "everything up to the first `=`" regex breaks here: infobox
// parameters like `|name = X` contain `=` within the first couple lines,
// long before the actual prose.)
function extractIntroText(wikitext) {
  const headingIdx = wikitext.search(/\n==[^=\n]/);
  const region = headingIdx === -1 ? wikitext.slice(0, 2000) : wikitext.slice(0, headingIdx);
  return stripAllTemplates(region);
}

function guessCategory(itemInfobox, weaponInfobox, introText) {
  // The wiki's infobox field for this has been renamed before (was `type`,
  // now `item_type`) — check both so a future rename doesn't silently
  // regress everything back to "Unsorted".
  const type = itemInfobox?.item_type || itemInfobox?.type || "";
  const isOneHanded = /one-handed/i.test(introText);
  const isTwoHanded = /two-handed/i.test(introText);

  if (/melee weapon/i.test(type)) {
    if (isTwoHanded) return "Melee2H";
    if (isOneHanded) return "Melee1H";
    return weaponInfobox ? "Melee1H" : "Melee";
  }
  if (/ranged weapon/i.test(type)) return "Ranged";
  if (/magic weapon|staff/i.test(type)) return "Magic";
  if (/(processed material|^material$|^bar$)/i.test(type)) return "Material";
  if (/armour/i.test(type)) return "Armour";
  if (/ammunition|arrow|bolt/i.test(type)) return "Ammo";
  if (/potion/i.test(type)) return "Potion";
  if (/tool/i.test(type)) return "Tool";
  return type || "Unsorted";
}

function extractPowerLevel(wikitext, weaponInfobox) {
  if (weaponInfobox?.power) {
    const n = Number(weaponInfobox.power);
    if (!Number.isNaN(n)) return n;
  }
  const m = wikitext.match(/\[\[Power level\]\]\s*(\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

function extractRecipes(wikitext) {
  return findTemplates(wikitext, "Recipe").map(parseTemplateParams);
}

function recipeToItemsJs(recipeParams) {
  const materials = [];
  for (let n = 1; n <= 12; n++) {
    const mat = recipeParams[`mat${n}`];
    if (!mat) continue;
    const qtyRaw = recipeParams[`mat${n}qty`];
    const qty = qtyRaw ? Number(qtyRaw) : 1;
    materials.push([stripLink(mat), Number.isNaN(qty) ? qtyRaw : qty]);
  }
  return {
    station: recipeParams.facility ? stripLink(recipeParams.facility) : null,
    recipe: materials,
  };
}

async function loadExistingItems() {
  const url = new URL(`file://${path.join(ROOT, "src/data/items.js").replace(/\\/g, "/")}`);
  const mod = await import(url.href);
  return mod.ITEMS || {};
}

// Every material name referenced by any recipe in the given item map.
function referencedMaterials(itemMap) {
  const refs = new Set();
  for (const def of Object.values(itemMap)) {
    for (const [matName] of def.recipe || []) refs.add(matName);
  }
  return refs;
}

// Parses one page's wikitext into a scraped-item entry, or null if it has
// no {{Recipe}} template (not craftable — a raw/gathered resource, or a
// non-item overview page).
function wikitextToEntry(title, wikitext) {
  const recipes = extractRecipes(wikitext);
  if (!recipes.length) return null;

  const itemInfobox = extractInfobox(wikitext, "Infobox Item");
  const weaponInfobox = extractInfobox(wikitext, "Infobox Weapon");
  const introText = extractIntroText(wikitext);

  const primary = recipeToItemsJs(recipes[0]);
  return {
    name: title,
    category: guessCategory(itemInfobox, weaponInfobox, introText),
    station: primary.station,
    powerLevel: extractPowerLevel(wikitext, weaponInfobox),
    recipe: primary.recipe,
    alternateRecipeCount: recipes.length - 1,
    wikiType: (itemInfobox?.item_type || itemInfobox?.type || "").trim() || null,
  };
}

// Follows recipe ingredients that aren't a known item yet out to the wiki,
// by exact page title, regardless of category — repeating on whatever new
// ingredients those pages themselves reference. Stops when nothing new
// turns up (or the safety caps below are hit).
async function resolveLeafMaterials(knownNames, initialFrontier) {
  const discovered = [];
  const confirmedRaw = [];
  const notFoundOnWiki = [];
  const visited = new Set(knownNames);

  let frontier = [...initialFrontier].filter((n) => !visited.has(n));
  frontier.forEach((n) => visited.add(n));

  const MAX_ITERATIONS = 8;
  const MAX_TOTAL_LOOKUPS = 3000;
  let totalLookups = 0;
  let iteration = 0;

  while (frontier.length && iteration < MAX_ITERATIONS && totalLookups < MAX_TOTAL_LOOKUPS) {
    iteration++;
    console.log(`Leaf-resolution pass ${iteration}: looking up ${frontier.length} referenced material(s)...`);
    const nextFrontier = new Set();

    const BATCH = 50;
    for (let i = 0; i < frontier.length; i += BATCH) {
      const batch = frontier.slice(i, i + BATCH);
      totalLookups += batch.length;
      const pages = await queryPages(batch);

      for (const title of batch) {
        const info = pages.get(title);
        if (!info || info.missing || info.content == null) {
          notFoundOnWiki.push(title);
          continue;
        }
        const entry = wikitextToEntry(title, info.content);
        if (!entry) {
          confirmedRaw.push(title);
          continue;
        }
        discovered.push(entry);
        visited.add(title);
        for (const [matName] of entry.recipe) {
          if (!visited.has(matName)) nextFrontier.add(matName);
        }
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    frontier = [...nextFrontier];
  }

  return { discovered, confirmedRaw, notFoundOnWiki };
}

function formatEntry(name, entry) {
  const recipeStr = `[${entry.recipe
    .map(([m, q]) => `[${JSON.stringify(m)}, ${JSON.stringify(q)}]`)
    .join(", ")}]`;
  const powerStr =
    entry.powerLevel != null ? `, powerLevel: ${entry.powerLevel}` : "";
  return `  ${JSON.stringify(name)}: { category: ${JSON.stringify(
    entry.category
  )}, station: ${JSON.stringify(entry.station || "TODO")}${powerStr},\n    recipe: ${recipeStr} },`;
}

async function main() {
  let existingItems = {};
  try {
    existingItems = await loadExistingItems();
    console.log(`Loaded ${Object.keys(existingItems).length} existing items from items.js.`);
  } catch (err) {
    console.log(`Could not load src/data/items.js — not filtering existing items. (${err.message})`);
  }
  const existingKeys = new Set(Object.keys(existingItems));

  console.log(`Fetching category members of ${CATEGORY}...`);
  const titles = await getCategoryMembers(CATEGORY);
  console.log(`Found ${titles.length} pages (namespace 0).`);

  const results = [];
  const skippedNoRecipe = [];
  const skippedExisting = [];

  const BATCH = 50;
  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    console.log(
      `Fetching wikitext ${i + 1}-${Math.min(i + BATCH, titles.length)} of ${titles.length}...`
    );
    const wikitextByTitle = await getWikitextBatch(batch);

    for (const title of batch) {
      if (existingKeys.has(title)) {
        skippedExisting.push(title);
        continue;
      }
      const wikitext = wikitextByTitle.get(title);
      if (!wikitext) continue;

      const entry = wikitextToEntry(title, wikitext);
      if (!entry) {
        skippedNoRecipe.push(title);
        continue;
      }
      results.push(entry);
    }

    // Be polite to the wiki's API.
    await new Promise((r) => setTimeout(r, 250));
  }

  // ---- leaf-resolution pass ----
  // Find every material referenced by a recipe (existing or freshly
  // scraped) that isn't itself a known item, and look those up directly.
  const knownNames = new Set([...existingKeys, ...results.map((r) => r.name)]);
  const scrapedAsMap = Object.fromEntries(results.map((r) => [r.name, r]));
  const allReferenced = new Set([
    ...referencedMaterials(existingItems),
    ...referencedMaterials(scrapedAsMap),
  ]);
  const initialFrontier = [...allReferenced].filter((n) => !knownNames.has(n));

  console.log(`\nStarting leaf-resolution: ${initialFrontier.length} referenced material(s) with no known recipe yet.`);
  const { discovered, confirmedRaw, notFoundOnWiki } = await resolveLeafMaterials(
    knownNames,
    initialFrontier
  );
  console.log(
    `Leaf-resolution found ${discovered.length} new craftable material(s), ` +
      `confirmed ${confirmedRaw.length} as raw/gathered, ${notFoundOnWiki.length} not found on the wiki.`
  );
  results.push(...discovered);

  const outDir = path.join(ROOT, "scripts/output");
  await mkdir(outDir, { recursive: true });

  const jsLines = [
    "// Auto-generated by scripts/scrape-wiki-items.js — review before merging into items.js!",
    "// `category` and `station` are best-effort guesses (search for TODO/Unsorted) — check them.",
    "// Items with multiple recipe variants on the wiki (e.g. alternate crafting materials)",
    "// only have their first/primary recipe included here; see the report for which ones.",
    "",
    "export const SCRAPED_ITEMS = {",
    ...results
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => formatEntry(r.name, r)),
    "};",
    "",
  ];
  await writeFile(path.join(outDir, "scraped-items.js"), jsLines.join("\n"));

  const report = [
    `# Scrape report for ${CATEGORY}`,
    "",
    `- Total pages in category: ${titles.length}`,
    `- Already present in items.js (skipped): ${skippedExisting.length}`,
    `- No {{Recipe}} template found in-category (not craftable / drop-only, skipped): ${skippedNoRecipe.length}`,
    `- New candidate items written to scraped-items.js: ${results.length}`,
    `  (of which ${discovered.length} came from the leaf-resolution pass, outside ${CATEGORY})`,
    "",
    "## Items with an ambiguous/unsorted category — check these manually",
    ...results
      .filter((r) => r.category === "Unsorted" || r.category === "Melee")
      .map((r) => `- ${r.name} (wiki type: ${r.wikiType || "unknown"})`),
    "",
    "## Items with alternate recipes on the wiki (only first was kept)",
    ...results
      .filter((r) => r.alternateRecipeCount > 0)
      .map((r) => `- ${r.name} (${r.alternateRecipeCount} alternate recipe(s))`),
    "",
    `## Confirmed raw/gathered materials (have a wiki page, but no {{Recipe}} — correctly left undefined) — ${confirmedRaw.length}`,
    ...confirmedRaw.sort().map((t) => `- ${t}`),
    "",
    `## Referenced materials not found on the wiki at all (check spelling/redirects) — ${notFoundOnWiki.length}`,
    ...notFoundOnWiki.sort().map((t) => `- ${t}`),
    "",
    "## Pages in-category with no Recipe template (skipped entirely)",
    ...skippedNoRecipe.map((t) => `- ${t}`),
    "",
  ];
  await writeFile(path.join(outDir, "scrape-report.md"), report.join("\n"));

  console.log(`\nDone. ${results.length} new items written to scripts/output/scraped-items.js`);
  console.log(`See scripts/output/scrape-report.md for a summary and items to double-check.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
