import {
  planMultiple,
  allItemNames,
  allCategories,
  allStations,
  allPowerLevels,
  getItemDef,
} from "./lib/planner.js";

const itemSearch = document.getElementById("itemSearch");
const categoryFilter = document.getElementById("categoryFilter");
const stationFilter = document.getElementById("stationFilter");
const powerFilter = document.getElementById("powerFilter");
const qtyInput = document.getElementById("qty");
const resultsCount = document.getElementById("resultsCount");
const itemResults = document.getElementById("itemResults");

const planListEl = document.getElementById("planList");
const clearListBtn = document.getElementById("clearListBtn");

const itemMeta = document.getElementById("itemMeta");
const totalsList = document.getElementById("totalsList");
const treeView = document.getElementById("treeView");

const STORAGE_KEY = "dragonwilds-plan-list";
const MAX_RESULTS = 150;

let planList = loadPlanList();

// ---- setup filter dropdowns ----
allCategories().forEach((cat) => addOption(categoryFilter, cat));
allStations().forEach((st) => addOption(stationFilter, st));
allPowerLevels().forEach((pl) => addOption(powerFilter, pl, `Power Level ${pl}`));

function addOption(select, value, label = value) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  select.appendChild(opt);
}

// ---- persistence ----
function loadPlanList() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.name === "string" && getItemDef(e.name));
  } catch {
    return [];
  }
}

function persistPlanList() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(planList));
}

// ---- item picker ----
function matchesFilters(name) {
  const def = getItemDef(name);
  if (!def) return false;
  const q = itemSearch.value.trim().toLowerCase();
  if (q && !name.toLowerCase().includes(q)) return false;
  if (categoryFilter.value && def.category !== categoryFilter.value) return false;
  if (stationFilter.value && def.station !== stationFilter.value) return false;
  if (powerFilter.value && String(def.powerLevel) !== powerFilter.value) return false;
  return true;
}

function renderResults() {
  const matches = allItemNames().filter(matchesFilters);
  itemResults.innerHTML = "";

  matches.slice(0, MAX_RESULTS).forEach((name) => {
    const def = getItemDef(name);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "item-row";
    row.innerHTML = `
      <span class="item-name">${name}</span>
      <span class="item-badges">
        ${def.category ? `<span class="badge cat">${def.category}</span>` : ""}
        ${def.station ? `<span class="badge station">${def.station}</span>` : ""}
        ${def.powerLevel != null ? `<span class="badge pl">PL ${def.powerLevel}</span>` : ""}
      </span>
    `;
    row.addEventListener("click", () => addToList(name));
    itemResults.appendChild(row);
  });

  if (matches.length > MAX_RESULTS) {
    const more = document.createElement("div");
    more.className = "item-row-more";
    more.textContent = `+ ${matches.length - MAX_RESULTS} more — refine your search to narrow it down`;
    itemResults.appendChild(more);
  }

  resultsCount.textContent = `${matches.length} item${matches.length === 1 ? "" : "s"} match${matches.length === 1 ? "es" : ""}`;
}

// ---- plan list (the "cart") ----
function addToList(name) {
  const qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
  const existing = planList.find((e) => e.name === name);
  if (existing) {
    existing.qty += qty;
  } else {
    planList.push({ name, qty });
  }
  persistPlanList();
  renderPlanList();
  recompute();
}

function removeFromList(idx) {
  planList.splice(idx, 1);
  persistPlanList();
  renderPlanList();
  recompute();
}

function updateQty(idx, qty) {
  const clamped = Math.max(1, parseInt(qty, 10) || 1);
  planList[idx].qty = clamped;
  persistPlanList();
  recompute();
}

function renderPlanList() {
  planListEl.innerHTML = "";

  if (!planList.length) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "No items added yet — search above and click an item to add it.";
    planListEl.appendChild(li);
    return;
  }

  planList.forEach((entry, idx) => {
    const def = getItemDef(entry.name);
    const li = document.createElement("li");
    li.className = "plan-list-item";
    li.innerHTML = `
      <span class="pli-name">${entry.name}</span>
      ${def?.powerLevel != null ? `<span class="badge pl">PL ${def.powerLevel}</span>` : ""}
      <input type="number" min="1" value="${entry.qty}" class="pli-qty" data-idx="${idx}" />
      <button type="button" class="pli-remove" data-idx="${idx}" title="Remove from list">×</button>
    `;
    planListEl.appendChild(li);
  });
}

planListEl.addEventListener("change", (e) => {
  if (e.target.classList.contains("pli-qty")) {
    updateQty(Number(e.target.dataset.idx), e.target.value);
  }
});

planListEl.addEventListener("click", (e) => {
  if (e.target.classList.contains("pli-remove")) {
    removeFromList(Number(e.target.dataset.idx));
  }
});

clearListBtn.addEventListener("click", () => {
  planList = [];
  persistPlanList();
  renderPlanList();
  recompute();
});

// ---- tree rendering ----
function renderTree(node, depth = 0) {
  const el = document.createElement("div");
  el.className = "tree-node";
  el.style.marginLeft = `${depth * 18}px`;

  const label = document.createElement("div");
  label.className = "tree-label" + (node.isLeaf ? " leaf" : "");
  label.textContent = `${node.quantity}× ${node.name}` + (node.station ? `  (${node.station})` : "");
  el.appendChild(label);

  node.children?.forEach((child) => {
    el.appendChild(renderTree(child, depth + 1));
  });

  return el;
}

// ---- combined output ----
function recompute() {
  totalsList.innerHTML = "";
  treeView.innerHTML = "";
  itemMeta.innerHTML = "";

  if (!planList.length) return;

  const { trees, totals, stations } = planMultiple(planList);

  itemMeta.innerHTML = `<span>Stations needed: ${stations.length ? stations.join(", ") : "none"}</span>`;

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([mat, total]) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="mname">${mat}</span><span class="qty">${total}×</span>`;
    totalsList.appendChild(li);
  });

  trees.forEach((tree) => {
    const heading = document.createElement("div");
    heading.className = "tree-item-heading";
    heading.textContent = `${tree.quantity}× ${tree.name}`;
    treeView.appendChild(heading);
    treeView.appendChild(renderTree(tree));
  });
}

// ---- events ----
[itemSearch, categoryFilter, stationFilter, powerFilter].forEach((el) => {
  el.addEventListener("input", renderResults);
  el.addEventListener("change", renderResults);
});

itemSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const firstMatch = allItemNames().filter(matchesFilters)[0];
    if (firstMatch) addToList(firstMatch);
  }
});

// ---- init ----
renderResults();
renderPlanList();
recompute();
