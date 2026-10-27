"use strict";

// Lunch Quiz: loads question files per category group on demand,
// shuffles them once per visit and renders cards in batches as you scroll.

const BATCH_SIZE = 20;
const DIFFICULTY_HUES = { "Easy": 140, "Medium": 205, "Hard": 38, "Very Hard": 0, "PhD": 280 };
const REPORT_REASONS = { update: "Fact update", remove: "Remove" };

// localStorage can be missing or blocked (private mode), so every access is guarded.
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ }
  },
};

// Reports used to be a plain list of IDs; upgrade those to { reason, comment } entries.
function loadReports() {
  const saved = store.get("lq.reports", null);
  if (saved && typeof saved === "object") return new Map(Object.entries(saved));
  const legacy = store.get("lq.reported", []);
  return new Map(legacy.map((id) => [id, { reason: "remove", comment: "" }]));
}

const state = {
  difficulties: [],
  groups: [],
  groupOfCategory: new Map(),
  loaded: new Map(),          // group id -> question array
  byId: new Map(),            // question id -> question
  selectedDifficulties: new Set(store.get("lq.difficulties", [])),
  selectedCategories: new Set(store.get("lq.categories", [])),
  asked: new Set(store.get("lq.asked", [])),
  skipped: new Set(store.get("lq.skipped", [])),
  reports: loadReports(),     // question id -> { reason, comment }
  showAnswers: store.get("lq.showAnswers", true),
  order: new Map(),           // question id -> random sort key for this visit
  pool: [],                   // filtered, shuffled questions for the current view
  rendered: 0,
  reporting: null,            // { card, q, doneText } while the report dialog is open
};

const $ = (id) => document.getElementById(id);
const els = {
  stats: $("stats"),
  cards: $("cards"),
  sentinel: $("sentinel"),
  empty: $("empty"),
  filters: $("filters"),
  filtersBtn: $("filtersBtn"),
  difficultyChips: $("difficultyChips"),
  groupChips: $("groupChips"),
  clearFilters: $("clearFilters"),
  answersToggle: $("answersToggle"),
  shuffleBtn: $("shuffleBtn"),
  resetBtn: $("resetBtn"),
  skippedBtn: $("skippedBtn"),
  skippedDialog: $("skippedDialog"),
  skippedList: $("skippedList"),
  restoreSkipped: $("restoreSkipped"),
  reportedBtn: $("reportedBtn"),
  reportedDialog: $("reportedDialog"),
  reportedList: $("reportedList"),
  copyReported: $("copyReported"),
  restoreReported: $("restoreReported"),
  reportDialog: $("reportDialog"),
  reportForm: $("reportForm"),
  reportQuestion: $("reportQuestion"),
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") node.style.cssText = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function saveSelections() {
  store.set("lq.difficulties", [...state.selectedDifficulties]);
  store.set("lq.categories", [...state.selectedCategories]);
}

function saveProgress() {
  store.set("lq.asked", [...state.asked]);
  store.set("lq.skipped", [...state.skipped]);
  store.set("lq.reports", Object.fromEntries(state.reports));
}

function isSetAside(id) {
  return state.asked.has(id) || state.skipped.has(id) || state.reports.has(id);
}

// ---------- Data loading ----------

async function loadCategories() {
  const res = await fetch("data/categories.json");
  if (!res.ok) throw new Error(`categories.json: ${res.status}`);
  const data = await res.json();
  state.difficulties = data.difficulties;
  state.groups = data.groups;
  for (const group of state.groups) {
    for (const cat of group.categories) state.groupOfCategory.set(cat, group);
  }
  // Drop saved selections that no longer exist in the taxonomy.
  for (const cat of [...state.selectedCategories]) {
    if (!state.groupOfCategory.has(cat)) state.selectedCategories.delete(cat);
  }
  for (const d of [...state.selectedDifficulties]) {
    if (!state.difficulties.includes(d)) state.selectedDifficulties.delete(d);
  }
}

function neededGroups() {
  if (state.selectedCategories.size === 0) return state.groups;
  return state.groups.filter((g) => g.categories.some((c) => state.selectedCategories.has(c)));
}

async function ensureLoaded(groups) {
  const missing = groups.filter((g) => !state.loaded.has(g.id));
  await Promise.all(missing.map(async (group) => {
    try {
      const res = await fetch(`data/questions/${group.id}.json`);
      const questions = res.ok ? await res.json() : [];
      state.loaded.set(group.id, questions);
      for (const q of questions) state.byId.set(q.id, q);
    } catch {
      state.loaded.set(group.id, []);
    }
  }));
}

// The Skipped and Reported lists can show questions from any group.
function ensureAllLoaded() {
  return ensureLoaded(state.groups);
}

// ---------- Pool & ordering ----------

function sortKey(id) {
  if (!state.order.has(id)) state.order.set(id, Math.random());
  return state.order.get(id);
}

function buildPool() {
  const diffs = state.selectedDifficulties;
  const cats = state.selectedCategories;
  state.pool = neededGroups()
    .flatMap((g) => state.loaded.get(g.id) || [])
    .filter((q) => !isSetAside(q.id))
    .filter((q) => diffs.size === 0 || diffs.has(q.difficulty))
    .filter((q) => cats.size === 0 || cats.has(q.category))
    .sort((a, b) => sortKey(a.id) - sortKey(b.id));
}

async function refresh() {
  els.stats.textContent = "Loading…";
  await ensureLoaded(neededGroups());
  buildPool();
  els.cards.replaceChildren();
  state.rendered = 0;
  renderMore();
  updateStats();
}

// ---------- Cards ----------

function badge(text, hue) {
  return el("span", { class: "badge", style: `--h:${hue}`, text });
}

function renderCard(q, index) {
  const group = state.groupOfCategory.get(q.category);
  const card = el("li", { class: "card", "data-id": q.id });

  const doneText = el("span");
  const undo = el("button", { type: "button", class: "link", text: "Undo", onclick: () => undoDone(card, q) });

  card.append(...[
    el("div", { class: "card-top" }, [
      el("span", { class: "card-num", text: `#${index + 1}` }),
      badge(q.difficulty, DIFFICULTY_HUES[q.difficulty] ?? 30),
      badge(q.category, group ? group.hue : 30),
    ]),
    el("p", { class: "question", text: q.question }),
    el("p", { class: "answer" }, [
      el("span", { class: "answer-label", text: "Answer" }),
      document.createTextNode(q.answer),
    ]),
    q.asOf ? el("p", { class: "as-of", text: `Correct as of ${q.asOf}` }) : null,
    el("div", { class: "card-actions" }, [
      el("button", {
        type: "button", class: "btn report", title: "Flag a fact to update, or a question to remove",
        text: "⚑ Report", onclick: () => openReportForm(card, q, doneText),
      }),
      el("button", {
        type: "button", class: "btn", title: "Skip for now (find it again under Skipped)",
        text: "Skip", onclick: () => markDone(card, q, "skipped", doneText),
      }),
      el("button", {
        type: "button", class: "btn primary", text: "✓ Asked",
        onclick: () => markDone(card, q, "asked", doneText),
      }),
    ]),
    el("div", { class: "done-row" }, [doneText, undo]),
  ].filter(Boolean));
  return card;
}

function renderMore() {
  const next = state.pool.slice(state.rendered, state.rendered + BATCH_SIZE);
  const frag = document.createDocumentFragment();
  next.forEach((q, i) => frag.append(renderCard(q, state.rendered + i)));
  els.cards.append(frag);
  state.rendered += next.length;

  // On tall screens one batch may not reach the sentinel's trigger zone, so keep going.
  if (state.rendered < state.pool.length && els.sentinel.getBoundingClientRect().top < window.innerHeight + 600) {
    requestAnimationFrame(renderMore);
  }

  const nothing = state.pool.length === 0;
  els.empty.hidden = !nothing;
  if (nothing) {
    els.empty.textContent = state.asked.size + state.skipped.size > 0
      ? "You've been through every question that matches these filters. Change the filters, check Skipped, or press Reset."
      : "No questions match these filters yet.";
  }
}

function markDone(card, q, kind, doneText) {
  state[kind].add(q.id);
  saveProgress();
  doneText.textContent = kind === "asked" ? "Asked ✓" : "Skipped";
  card.classList.add("done");
  updateStats();
}

function undoDone(card, q) {
  state.asked.delete(q.id);
  state.skipped.delete(q.id);
  state.reports.delete(q.id);
  saveProgress();
  card.classList.remove("done");
  updateStats();
}

function updateStats() {
  const left = state.pool.filter((q) => !isSetAside(q.id)).length;
  const parts = [`${left} to go`, `${state.asked.size} asked`];
  if (state.skipped.size) parts.push(`${state.skipped.size} skipped`);
  els.stats.textContent = parts.join(" · ");
  els.skippedBtn.textContent = `Skipped (${state.skipped.size})`;
  els.reportedBtn.textContent = `Reported (${state.reports.size})`;
}

// ---------- Report form ----------

function openReportForm(card, q, doneText) {
  state.reporting = { card, q, doneText };
  els.reportForm.reset();
  els.reportQuestion.textContent = q.question;
  els.reportDialog.showModal();
}

// Handled on submit (not the dialog's close event) so the choice is read before the form resets.
function onReportSubmit(event) {
  const pending = state.reporting;
  state.reporting = null;
  if (!pending || event.submitter?.value !== "report") return;
  const data = new FormData(els.reportForm);
  const reason = data.get("reason") || "remove";
  const comment = String(data.get("comment") || "").trim();
  state.reports.set(pending.q.id, { reason, comment });
  saveProgress();
  pending.doneText.textContent = `Reported: ${REPORT_REASONS[reason]}`;
  pending.card.classList.add("done");
  updateStats();
}

// ---------- Filters ----------

function chip(text, hue, pressed, onclick, extraClass = "") {
  return el("button", {
    type: "button", class: `chip ${extraClass}`.trim(), style: `--h:${hue}`,
    "aria-pressed": String(pressed), text, onclick,
  });
}

function renderFilters() {
  els.difficultyChips.replaceChildren(...state.difficulties.map((d) =>
    chip(d, DIFFICULTY_HUES[d] ?? 30, state.selectedDifficulties.has(d), () => {
      toggle(state.selectedDifficulties, d);
      onFiltersChanged();
    })));

  els.groupChips.replaceChildren(...state.groups.map((group) => {
    const selected = group.categories.filter((c) => state.selectedCategories.has(c)).length;
    const all = selected === group.categories.length;
    const groupChip = chip(group.name, group.hue, all, () => {
      for (const c of group.categories) {
        if (all) state.selectedCategories.delete(c);
        else state.selectedCategories.add(c);
      }
      onFiltersChanged();
    }, `group-chip${selected > 0 && !all ? " partial" : ""}`);

    return el("div", { class: "group" }, [
      groupChip,
      el("div", { class: "chips" }, group.categories.map((c) =>
        chip(c, group.hue, state.selectedCategories.has(c), () => {
          toggle(state.selectedCategories, c);
          onFiltersChanged();
        }))),
    ]);
  }));

  // A fully selected group counts as one filter rather than one per subcategory.
  const active = state.selectedDifficulties.size + state.groups.reduce((sum, g) => {
    const n = g.categories.filter((c) => state.selectedCategories.has(c)).length;
    return sum + (n === g.categories.length ? 1 : n);
  }, 0);
  els.filtersBtn.replaceChildren(document.createTextNode("Filters"));
  if (active > 0) els.filtersBtn.append(el("span", { class: "count", text: String(active) }));
}

function toggle(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

function onFiltersChanged() {
  saveSelections();
  renderFilters();
  refresh();
}

// ---------- Skipped & Reported lists ----------

async function openSkipped() {
  await ensureAllLoaded();
  const ids = [...state.skipped];
  els.skippedList.replaceChildren(...(ids.length
    ? ids.map((id) => {
        const q = state.byId.get(id);
        const item = el("li", {}, [
          el("span", { text: q ? q.question : id }),
          el("button", {
            type: "button", class: "link", text: "Bring back",
            onclick: () => {
              state.skipped.delete(id);
              saveProgress();
              item.remove();
              refresh();
            },
          }),
        ]);
        return item;
      })
    : [el("li", { text: "Nothing skipped." })]));
  els.skippedDialog.showModal();
}

function reportLine(id) {
  const report = state.reports.get(id);
  const q = state.byId.get(id);
  const comment = report.comment ? `: ${report.comment}` : "";
  return `${id} [${REPORT_REASONS[report.reason] || report.reason}]${comment}${q ? ` (Q: ${q.question})` : ""}`;
}

async function openReported() {
  await ensureAllLoaded();
  const ids = [...state.reports.keys()];
  els.reportedList.replaceChildren(...(ids.length
    ? ids.map((id) => {
        const report = state.reports.get(id);
        const q = state.byId.get(id);
        return el("li", {}, [
          el("span", { class: "badge", style: `--h:${report.reason === "update" ? 205 : 0}`, text: REPORT_REASONS[report.reason] || report.reason }),
          el("code", { text: ` ${id} ` }),
          el("span", { text: q ? q.question : "" }),
          report.comment ? el("span", { class: "report-comment", text: report.comment }) : null,
        ]);
      })
    : [el("li", { text: "Nothing reported." })]));
  els.reportedDialog.showModal();
}

// ---------- Wiring ----------

function applyAnswersVisibility() {
  document.body.classList.toggle("hide-answers", !state.showAnswers);
  els.answersToggle.checked = state.showAnswers;
}

function wire() {
  els.filtersBtn.addEventListener("click", () => {
    const open = els.filters.hidden;
    els.filters.hidden = !open;
    els.filtersBtn.setAttribute("aria-expanded", String(open));
  });

  els.clearFilters.addEventListener("click", () => {
    state.selectedDifficulties.clear();
    state.selectedCategories.clear();
    onFiltersChanged();
  });

  els.answersToggle.addEventListener("change", () => {
    state.showAnswers = els.answersToggle.checked;
    store.set("lq.showAnswers", state.showAnswers);
    applyAnswersVisibility();
  });

  els.shuffleBtn.addEventListener("click", () => {
    state.order.clear();
    refresh();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  els.resetBtn.addEventListener("click", () => {
    if (!confirm("Start fresh? Every question you've asked or skipped will come back. Reported questions stay hidden.")) return;
    state.asked.clear();
    state.skipped.clear();
    saveProgress();
    state.order.clear();
    refresh();
    window.scrollTo({ top: 0 });
  });

  els.reportForm.addEventListener("submit", onReportSubmit);

  els.skippedBtn.addEventListener("click", openSkipped);
  els.restoreSkipped.addEventListener("click", () => {
    state.skipped.clear();
    saveProgress();
    els.skippedDialog.close();
    refresh();
  });

  els.reportedBtn.addEventListener("click", openReported);

  els.copyReported.addEventListener("click", async () => {
    const text = [...state.reports.keys()].map(reportLine).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      els.copyReported.textContent = "Copied";
    } catch {
      prompt("Copy this report:", text);
    }
    setTimeout(() => { els.copyReported.textContent = "Copy report"; }, 1500);
  });

  els.restoreReported.addEventListener("click", () => {
    state.reports.clear();
    saveProgress();
    els.reportedDialog.close();
    refresh();
  });

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.rendered < state.pool.length) renderMore();
  }, { rootMargin: "600px" }).observe(els.sentinel);
}

async function init() {
  saveProgress(); // persists the upgraded report format straight away
  applyAnswersVisibility();
  wire();
  try {
    await loadCategories();
  } catch (err) {
    els.stats.textContent = "Couldn't load the question bank.";
    console.error(err);
    return;
  }
  renderFilters();
  await refresh();
}

init();
