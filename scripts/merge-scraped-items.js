// Merges scripts/output/scraped-items.js into src/data/items.js, keeping
// every existing entry's exact original text untouched and inserting new
// entries alphabetically. Skips (with a warning) any scraped item whose key
// already exists in items.js.
//
// Usage: node scripts/merge-scraped-items.js

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ITEMS_PATH = path.join(ROOT, "src/data/items.js");
const SCRAPED_PATH = path.join(ROOT, "scripts/output/scraped-items.js");

function formatEntry(name, entry) {
  const recipeStr = `[${entry.recipe
    .map(([m, q]) => `[${JSON.stringify(m)}, ${JSON.stringify(q)}]`)
    .join(", ")}]`;
  const powerStr = entry.powerLevel != null ? `, powerLevel: ${entry.powerLevel}` : "";
  return `  ${JSON.stringify(name)}: { category: ${JSON.stringify(
    entry.category
  )}, station: ${JSON.stringify(entry.station || "TODO")}${powerStr},\n    recipe: ${recipeStr} },`;
}

async function main() {
  const source = await readFile(ITEMS_PATH, "utf8");

  const bodyMatch = source.match(/export const ITEMS = \{([\s\S]*)\};\s*$/);
  if (!bodyMatch) throw new Error("Couldn't find `export const ITEMS = { ... };` in items.js");
  const header = source.slice(0, bodyMatch.index) + "export const ITEMS = {\n";
  const body = bodyMatch[1];

  // Entries never contain nested `{}` (only `[]` arrays), so a non-greedy
  // match between the outer braces is safe and preserves original formatting.
  const entryRe = /"((?:[^"\\]|\\.)*)":\s*\{[\s\S]*?\},(?=\s*(?:"|\/\/|$))/g;
  const existing = new Map();
  let m;
  while ((m = entryRe.exec(body))) {
    existing.set(m[1], m[0].trim());
  }
  console.log(`Parsed ${existing.size} existing entries from items.js.`);

  const scrapedMod = await import(new URL(`file://${SCRAPED_PATH.replace(/\\/g, "/")}`).href);
  const scraped = scrapedMod.SCRAPED_ITEMS || {};
  console.log(`Loaded ${Object.keys(scraped).length} candidate entries from scraped-items.js.`);

  let added = 0;
  let skippedDupe = 0;
  for (const [name, entry] of Object.entries(scraped)) {
    if (existing.has(name)) {
      skippedDupe++;
      continue;
    }
    existing.set(name, formatEntry(name, entry));
    added++;
  }

  const sortedKeys = [...existing.keys()].sort();
  const newBody = sortedKeys.map((k) => existing.get(k)).join("\n");

  await writeFile(ITEMS_PATH, `${header}${newBody}\n};\n`);

  console.log(`\nMerged. Added ${added} new item(s), skipped ${skippedDupe} already-present key(s).`);
  console.log(`items.js now has ${existing.size} total items.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
