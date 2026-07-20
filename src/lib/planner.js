import { ITEMS } from "../data/items.js";

/**
 * Recursively expand an item's recipe into:
 *  - a nested `tree` (for display: shows the craft-by-craft breakdown)
 *  - a flat `totals` map of every raw/leaf material name -> total quantity
 *
 * A "leaf" is any material name that doesn't exist as a key in ITEMS
 * (i.e. we have no recipe for it, so it's treated as something you go
 * gather/buy directly).
 */
export function planItem(itemName, quantity = 1, _seen = new Set()) {
  const def = ITEMS[itemName];
  const totals = {};

  if (!def) {
    // Unknown item entirely — nothing to plan.
    return { name: itemName, quantity, station: null, powerLevel: null, children: [], totals: {}, isLeaf: true };
  }

  // Guard against accidental circular recipes.
  if (_seen.has(itemName)) {
    return { name: itemName, quantity, station: def.station, powerLevel: def.powerLevel, children: [], totals: {}, circular: true };
  }
  const seen = new Set(_seen);
  seen.add(itemName);

  const children = def.recipe.map(([matName, matQty]) => {
    const neededQty = matQty * quantity;
    const matDef = ITEMS[matName];

    if (matDef) {
      // Recurse: this material is itself craftable.
      const sub = planItem(matName, neededQty, seen);
      mergeTotals(totals, sub.totals);
      return sub;
    } else {
      // Raw/leaf material — no further recipe known.
      addTotal(totals, matName, neededQty);
      return { name: matName, quantity: neededQty, station: null, powerLevel: null, children: [], totals: { [matName]: neededQty }, isLeaf: true };
    }
  });

  return {
    name: itemName,
    quantity,
    station: def.station,
    powerLevel: def.powerLevel,
    children,
    totals,
  };
}

function addTotal(totals, name, qty) {
  totals[name] = (totals[name] || 0) + qty;
}

function mergeTotals(target, source) {
  for (const [name, qty] of Object.entries(source)) {
    addTotal(target, name, qty);
  }
}

/** Flattened, sorted list of every station touched while crafting this item and its sub-components. */
export function stationsInvolved(tree) {
  const stations = new Set();
  (function walk(node) {
    if (node.station) stations.add(node.station);
    node.children.forEach(walk);
  })(tree);
  return [...stations];
}

export function allItemNames() {
  return Object.keys(ITEMS).sort();
}

export function getItemDef(name) {
  return ITEMS[name];
}

export function allCategories() {
  return [...new Set(Object.values(ITEMS).map((d) => d.category).filter(Boolean))].sort();
}

export function allStations() {
  return [...new Set(Object.values(ITEMS).map((d) => d.station).filter(Boolean))].sort();
}

export function allPowerLevels() {
  return [...new Set(Object.values(ITEMS).map((d) => d.powerLevel).filter((v) => v != null))].sort(
    (a, b) => a - b
  );
}

/**
 * Plans a whole shopping-list worth of items at once.
 * `entries` is an array of { name, qty }. Returns each item's individual
 * tree (so per-item breakdowns can still be shown) plus one combined
 * totals map and combined station list across everything requested.
 */
export function planMultiple(entries) {
  const totals = {};
  const stations = new Set();

  const trees = entries.map(({ name, qty }) => {
    const tree = planItem(name, qty);
    mergeTotals(totals, tree.totals);
    stationsInvolved(tree).forEach((s) => stations.add(s));
    return tree;
  });

  return { trees, totals, stations: [...stations].sort() };
}
