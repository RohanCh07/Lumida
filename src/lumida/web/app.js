// Lumida web app: plain JavaScript, no build step, served by Lumida itself.
//
// - Talks only to Lumida's own API (/api/v1). The login lives in an HttpOnly cookie that
//   this code can't read; every change also sends the X-Lumida-CSRF header.
// - Every value from the API is put on the page with textContent (the h() helper) or as an
//   SVG attribute (charts.js), never as HTML, so data can't inject markup or scripts.
// - Pages are chosen by the address after "#", e.g. #/s/shop/rules.
// - Layout and look follow the "Luminous Void" screens from Stitch (2026-11-04).

import { SERIES, SEVERITIES, SEV_COLOR, compact, linkMap, lineChart, ring, s, scoreColor, sparkline,
  stackedArea, stackedBars } from "./charts.js";

const API = "/api/v1";
const main = document.getElementById("main");
let me = null; // who is logged in: {email, role, ...}
let newKey = null; // an API key just made, shown once on "My account"
let about = null; // {version, ai_enabled}
let sources = []; // the databases, refreshed on every page
let current = null; // the database the person last looked at

// --- small helpers ---------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "style") el.style.cssText = value; // allowed by the page's security policy
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const enc = encodeURIComponent;
const ROLE_RANK = { viewer: 0, reviewer: 1, admin: 2 };
const can = (role) => me && ROLE_RANK[me.role] >= ROLE_RANK[role];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sum = (obj) => Object.values(obj || {}).reduce((a, b) => a + b, 0);

function when(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ago(iso) {
  if (!iso) return "—";
  const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—");
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—");
const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

function badge(text, kind = "") {
  return h("span", { class: `badge ${kind}` }, text);
}
const sevBadge = (sev) => h("span", { class: `sev sev--${sev}` }, h("i"), sev);
const stBadge = (st) => badge(st, `st-${st}`);

function toast(message, error = false) {
  const el = h("div", { class: `toast${error ? " toast--error" : ""}` }, message);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), error ? 7000 : 3500);
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body, params } = {}) {
  let url = API + path;
  if (params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== "" && v !== null && v !== undefined) q.set(k, v);
    if ([...q].length) url += `?${q}`;
  }
  const headers = { Accept: "application/json" };
  if (method !== "GET") headers["X-Lumida-CSRF"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && path !== "/auth/login") {
    me = null;
    location.hash = "#/login";
    throw new ApiError(401, "please log in");
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : response.statusText;
    throw new ApiError(response.status, detail);
  }
  return data;
}

// A 404 (e.g. no health score before the first run) becomes `fallback`.
const maybe = (promise, fallback = null) => promise.catch((err) => {
  if (err.status === 404) return fallback;
  throw err;
});

// Run an action from a button: disable it meanwhile, report the outcome.
async function act(button, action, done) {
  if (button) button.disabled = true;
  try {
    const result = await action();
    if (done) toast(typeof done === "function" ? done(result) : done);
    await route();
  } catch (err) {
    if (err.status !== 401) toast(err.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function show(...content) {
  main.replaceChildren(...content.flat().filter(Boolean));
  main.focus({ preventScroll: true });
}

// A page title block: small mono kicker, the title, a line under it, actions on the right.
function heading(title, { kicker, lead, actions = [] } = {}) {
  return h("div", { class: "head" },
    h("div", { class: "head__text" },
      kicker ? h("div", { class: "kicker" }, kicker) : null,
      h("h1", {}, title),
      lead ? h("p", { class: "head__lead" }, lead) : null),
    actions.length ? h("div", { class: "row" }, ...actions) : null);
}

function panel(title, sub, ...content) {
  return h("section", { class: "panel" },
    title ? h("div", { class: "panel__head" }, h("div", {}, h("h2", {}, title), sub ? h("p", { class: "panel__sub" }, sub) : null)) : null,
    ...content);
}

function table(columns, rows, empty = "Nothing here yet.") {
  if (!rows.length) return h("div", { class: "empty" }, empty);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, columns.map((c) => h("th", {}, c)))),
    h("tbody", {}, rows.map((cells) => h("tr", {}, cells.map((c) => h("td", {}, c)))))));
}

function select(name, options, value, onchange) {
  return h("select", { name, "aria-label": name, onchange },
    options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
}

function field(id, label, input, hint) {
  return h("div", { class: "field" }, h("label", { for: id }, label), input,
    hint ? h("div", { class: "hint" }, hint) : null);
}

// Health charts start a little below the lowest score, so small changes stay visible.
const scoreFloor = (scores) => (scores.length ? Math.max(0, Math.floor((Math.min(...scores) - 5) / 10) * 10) : 0);

const meter = (score) => h("span", { class: "meter" },
  h("span", { style: `width:${Math.max(0, Math.min(100, score))}%;background:${scoreColor(score)}` }));

const KIND_NAMES = { postgres: "PostgreSQL", mysql: "MySQL", sqlserver: "SQL Server", oracle: "Oracle", snowflake: "Snowflake" };
const CATEGORY = {
  structural: "Structural", relational: "Relationships", column_value: "Values", business_rule: "Business rules",
  time_series: "Loads & freshness", row_outlier: "Unusual rows", cross_system: "Copies disagree",
  semantic: "Personal data", db_health: "DB health",
};
const CAT_COLOR = {
  structural: "#e4e4e7", relational: "#f87171", column_value: "#f5d0a9", business_rule: "#fb923c",
  time_series: "#60a5fa", row_outlier: "#a78bfa", cross_system: "#4ade80", semantic: "#facc15", db_health: "#71717a",
};
const SEV_RANK = Object.fromEntries(SEVERITIES.map((sev, i) => [sev, i]));

// --- icons (simple strokes, drawn here so nothing loads from elsewhere) -------------------

const ICONS = {
  overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  database: "M12 4c4.4 0 8 1.3 8 3v10c0 1.7-3.6 3-8 3s-8-1.3-8-3V7c0-1.7 3.6-3 8-3zM4 7c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  problems: "M12 4l9 16H3zM12 10v4M12 17v.5",
  rules: "M5 6h10M5 12h14M5 18h8M18 4l2 2-2 2",
  links: "M6 6h4v4H6zM14 14h4v4h-4zM14 4h4v4h-4zM10 8l4-2M10 8l4 8",
  questions: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 16.5v.5",
  runs: "M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4M12 8v4l3 2",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 15c2 .6 3 2.2 3 5",
  audit: "M6 3h9l4 4v14H6zM9 10h7M9 14h7M9 18h4",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-6 8-6s8 2 8 6",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  play: "M7 5l12 7-12 7z",
};
const icon = (name, size = 16) => s("svg", { viewBox: "0 0 24 24", width: size, height: size, class: "icon", "aria-hidden": "true" },
  s("path", { d: ICONS[name] }));

// --- jobs ("run now", connection tests, AI work) ---------------------------------------

const JOB_WORDS = { run: "Run", test_connection: "Connection test", propose_rules: "Rule proposals", explain: "Explanations" };
const ACTIVE = new Set(["queued", "running"]);

// Follow a job until it's done, showing its state in `line`; stops if the page changes.
async function watchJob(job, line, done) {
  const render = (j) => line.replaceChildren(h("span", { class: `pipe pipe--${j.status}` },
    h("i"), JOB_WORDS[j.kind] || j.kind, ": ",
    j.status === "queued" ? "waiting to start" : j.status === "running" ? "in progress" : j.status),
  j.status === "failed" && j.error ? h("span", { class: "bad small" }, ` ${j.error}`) : "");
  render(job);
  while (ACTIVE.has(job.status)) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!line.isConnected) return; // the person moved on
    job = await api(`/jobs/${job.id}`);
    render(job);
  }
  if (done) await done(job);
}

function startJob(sourceName, kind, extra = {}) {
  return api(`/sources/${enc(sourceName)}/jobs`, { method: "POST", body: { kind, ...extra } });
}

// A button that starts a job, and a line that follows it; the page reloads when it ends.
function jobButton(sourceName, kind, label, { primary = false, extra = {}, line = h("span", { class: "small" }), iconName } = {}) {
  const button = h("button", { class: `btn${primary ? " btn--primary" : ""}`, type: "button", onclick: async () => {
    button.disabled = true;
    try {
      const job = await startJob(sourceName, kind, extra);
      await watchJob(job, line, async (j) => {
        const ok = j.status === "succeeded";
        toast(ok ? `${JOB_WORDS[kind]} finished` : `${JOB_WORDS[kind]} failed: ${j.error || "see Runs"}`, !ok);
        await route();
      });
    } catch (err) {
      if (err.status !== 401) toast(err.message, true);
    } finally {
      button.disabled = false;
    }
  } }, iconName ? icon(iconName, 14) : null, label);
  return [button, line];
}

// --- the frame: sidebar and top bar ----------------------------------------------------

function currentSource() {
  if (current && sources.some((x) => x.name === current)) return current;
  try { current = localStorage.getItem("lumida.source"); } catch { current = null; }
  if (!current || !sources.some((x) => x.name === current)) current = sources[0]?.name || null;
  return current;
}

function remember(name) {
  current = name;
  try { localStorage.setItem("lumida.source", name); } catch { /* private window */ }
}

// section: which nav item is lit; crumbs: [[text, href?], ...]; actions: top-bar buttons.
function frame(section, crumbs = [], actions = []) {
  const side = document.getElementById("side");
  const top = document.getElementById("top");
  side.hidden = !me;
  top.hidden = !me;
  document.body.classList.toggle("bare", !me);
  if (!me) return;
  const db = currentSource();
  const scoped = (tab) => (db ? `#/s/${enc(db)}/${tab}` : "#/databases");
  const link = ([href, text, key, iconName]) => h("a", { href, class: key === section ? "on" : "",
    "aria-current": key === section ? "page" : null }, icon(iconName), h("span", {}, text));
  document.getElementById("nav-monitor").replaceChildren(...[
    ["#/", "Overview", "overview", "overview"],
    ["#/databases", "Databases", "databases", "database"],
    ["#/problems", "Problems", "problems", "problems"],
    [scoped("rules"), "Rules", "rules", "rules"],
    [scoped("relationships"), "Relationships", "relationships", "links"],
    [scoped("questions"), "Questions", "questions", "questions"],
    [scoped("runs"), "Runs", "runs", "runs"],
  ].map(link));
  const work = [["#/me", "My account", "me", "account"]];
  if (can("admin")) work.unshift(["#/people", "People", "people", "people"], ["#/audit", "Audit log", "audit", "audit"]);
  document.getElementById("nav-work").replaceChildren(...work.map(link));
  document.getElementById("ver").textContent = about?.version ? `v${about.version}` : "";
  document.getElementById("side-foot").replaceChildren(icon("lock", 13), h("span", {}, "Runs on your machines · nothing leaves"));

  const pick = h("select", { "aria-label": "Database", onchange: (e) => {
    if (e.target.value) { remember(e.target.value); location.hash = `#/s/${enc(e.target.value)}`; } else location.hash = "#/";
  } },
  h("option", { value: "" }, "All databases"),
  sources.map((x) => h("option", { value: x.name, selected: crumbs.some(([t]) => t === x.name) }, x.name)));
  document.getElementById("switcher").replaceChildren(h("div", { class: "switcher" }, icon("database", 14), pick));

  document.getElementById("crumb").replaceChildren(...crumbs.flatMap(([text, href], i) => [
    i ? h("span", { class: "top__sep" }, "/") : null,
    href ? h("a", { href }, text) : h("span", { class: "top__here" }, text)]).filter(Boolean));
  const q = h("input", { type: "search", name: "q", placeholder: "Search problems, tables, columns…", "aria-label": "Search problems" });
  const form = document.getElementById("search");
  form.replaceChildren(icon("search", 14), q);
  form.onsubmit = (e) => { e.preventDefault(); location.hash = `#/problems?${new URLSearchParams({ q: q.value })}`; };
  document.getElementById("actions").replaceChildren(...actions);
  const initials = (me.name || me.email).split(/[\s@.]/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
  const menu = h("details", { class: "who" },
    h("summary", { "aria-label": "Account" }, initials),
    h("div", { class: "who__menu" },
      h("div", { class: "who__id" }, h("strong", {}, me.email), h("span", { class: "muted small" }, me.role)),
      h("a", { href: "#/me" }, "My account"),
      h("button", { type: "button", class: "link", onclick: logOut }, "Log out")));
  document.getElementById("who").replaceChildren(menu);
}

async function logOut() {
  try { await api("/auth/logout", { method: "POST" }); } catch { /* already logged out */ }
  me = null;
  location.hash = "#/login";
}

document.getElementById("menu").addEventListener("click", (e) => {
  const open = document.getElementById("side").classList.toggle("side--open");
  e.currentTarget.setAttribute("aria-expanded", String(open));
});

// --- loading what the overview and the problems pages need ---------------------------------

async function loadSources() {
  sources = await api("/sources");
  return sources;
}

// Every database's open problems (or another status), most severe first.
async function allFindings(list, status = "active") {
  const pages = await Promise.all(list.map((x) => api(`/sources/${enc(x.name)}/findings`, { params: { status, limit: 500 } })));
  return pages.flatMap((p) => p.items).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]
    || new Date(b.last_detected_at) - new Date(a.last_detected_at));
}

// Open problems over time, summed across databases: each database's latest count on each day.
function problemsOverTime(histories) {
  const days = [...new Set(histories.flatMap((hist) => hist.health.map((p) => new Date(p.at).toDateString())))]
    .map((d) => new Date(d)).sort((a, b) => a - b);
  return days.map((d) => {
    const end = +d + 86400000;
    const parts = {};
    for (const hist of histories) {
      const upTo = hist.health.filter((p) => +new Date(p.at) < end).at(-1);
      for (const [sev, n] of Object.entries(upTo?.open_findings || {})) parts[sev] = (parts[sev] || 0) + n;
    }
    return { at: d, parts };
  });
}

// --- pages ---------------------------------------------------------------------------------

function loginPage() {
  frame();
  const email = h("input", { id: "email", type: "email", autocomplete: "username", required: true });
  const password = h("input", { id: "password", type: "password", autocomplete: "current-password", required: true });
  const error = h("p", { class: "bad small", role: "alert" });
  const form = h("form", { class: "panel stack", onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      const reply = await api("/auth/login", { method: "POST",
        body: { email: email.value, password: password.value, cookie: true } });
      me = reply.user;
      location.hash = "#/";
    } catch (err) {
      error.textContent = err.message;
    }
  } },
    h("h1", {}, "Log in"),
    field("email", "Email", email),
    field("password", "Password", password),
    error,
    h("button", { class: "btn btn--primary btn--wide", type: "submit" }, "Log in"),
    h("p", { class: "muted small" }, "No account? Ask your Lumida admin."));
  show(h("div", { class: "login" },
    h("div", { class: "brand brand--big" }, h("img", { src: "mark.svg", alt: "", width: 34, height: 34 }), "lumida"),
    form,
    h("p", { class: "login__foot" }, icon("lock", 13), " Runs on your machines · nothing leaves")));
  email.focus();
}

// Overview: every database at a glance.
async function overviewPage() {
  await loadSources();
  frame("overview", [["Overview", "#/"], ["All databases"]]);
  if (!sources.length) return show(welcome());
  const details = await Promise.all(sources.map(async (src) => {
    const n = enc(src.name);
    const [history, health, rules, links] = await Promise.all([
      api(`/sources/${n}/history`, { params: { tables: 0 } }),
      maybe(api(`/sources/${n}/health`)),
      api(`/sources/${n}/rules`, { params: { status: "proposed" } }),
      api(`/sources/${n}/relationships`),
    ]);
    return { src, history, health, rules: rules.length, links: links.filter((r) => r.status === "proposed").length };
  }));
  const findings = await allFindings(sources);

  // KPI tiles
  const scored = sources.filter((x) => x.health_score !== null);
  const overall = scored.length ? scored.reduce((a, x) => a + x.health_score, 0) / scored.length : null;
  const timeline = details.flatMap((d) => d.history.health.map((p) => ({ name: d.src.name, at: new Date(p.at), score: p.score })))
    .sort((a, b) => a.at - b.at);
  const latest = {};
  const fleet = timeline.map((p) => {
    latest[p.name] = p.score;
    const values = Object.values(latest);
    return values.reduce((a, b) => a + b, 0) / values.length;
  });
  const bySev = {};
  for (const src of sources) for (const [sev, n] of Object.entries(src.open_findings)) bySev[sev] = (bySev[sev] || 0) + n;
  const open = sum(bySev);
  const delta = details.reduce((a, d) => {
    const pts = d.history.health;
    return pts.length >= 2 ? a + sum(pts.at(-1).open_findings) - sum(pts.at(-2).open_findings) : a;
  }, 0);
  const proposedRules = details.reduce((a, d) => a + d.rules, 0);
  const proposedLinks = details.reduce((a, d) => a + d.links, 0);
  const ranToday = sources.filter((x) => isToday(x.last_run?.started_at));
  const failed = sources.filter((x) => x.last_run?.status === "failed");

  const healthTile = h("a", { class: "kpi kpi--glow", href: "#/databases" },
    h("div", { class: "kpi__top" }, h("span", { class: "kicker" }, "Overall health"),
      overall === null ? null : badge(overall >= 85 ? "healthy" : overall >= 60 ? "needs attention" : "unhealthy", "badge--soft")),
    h("div", { class: "kpi__value" }, overall === null ? "—" : Math.round(overall), h("small", {}, " / 100")),
    h("p", { class: "kpi__note" }, `Average of ${plural(scored.length, "database")} with a score`),
    fleet.length > 1 ? sparkline(fleet, { width: 240, height: 40, band: false }).svg : null);
  const sevBar = h("div", { class: "sevbar" }, SEVERITIES.filter((sev) => bySev[sev]).map((sev) =>
    h("span", { style: `flex:${bySev[sev]};background:${SEV_COLOR[sev]}`, title: `${bySev[sev]} ${sev}` })));
  const problemsTile = h("a", { class: "kpi", href: "#/problems" },
    h("div", { class: "kpi__top" }, h("span", { class: "kicker" }, "Open problems"),
      delta > 0 ? badge(`+${delta} since last run`, "badge--hot") : delta < 0 ? badge(`${delta} since last run`, "badge--good") : null),
    h("div", { class: "kpi__value" }, open),
    h("p", { class: "kpi__note" }, `Across ${plural(sources.reduce((a, x) => a + x.tables, 0), "table")} watched`),
    open ? sevBar : null,
    h("div", { class: "kpi__legend" }, SEVERITIES.filter((sev) => bySev[sev]).map((sev) => h("span", {}, `${bySev[sev]} ${sev}`))));
  const reviewTarget = sources.find((x) => details.find((d) => d.src === x && (d.rules || d.links)));
  const reviewTile = h("a", { class: "kpi", href: reviewTarget ? `#/s/${enc(reviewTarget.name)}/${details.find((d) => d.src === reviewTarget).rules ? "rules" : "relationships"}` : "#/problems" },
    h("div", { class: "kpi__top" }, h("span", { class: "kicker" }, "Awaiting review")),
    h("div", { class: "kpi__value" }, proposedRules + proposedLinks),
    h("p", { class: "kpi__note" }, `${plural(proposedRules, "rule")} · ${plural(proposedLinks, "link")} proposed`),
    h("span", { class: "kpi__cta" }, proposedRules + proposedLinks ? "Review →" : "Nothing waiting"));
  const runsTile = h("a", { class: "kpi", href: failed[0] ? `#/s/${enc(failed[0].name)}/runs` : "#/databases" },
    h("div", { class: "kpi__top" }, h("span", { class: "kicker" }, "Runs today")),
    h("div", { class: "kpi__value" }, ranToday.filter((x) => x.last_run.status === "succeeded").length, h("small", {}, ` / ${sources.length}`)),
    h("p", { class: "kpi__note" }, "succeeded"),
    failed.length ? h("p", { class: "kpi__warn" }, `${failed.map((x) => x.name).join(", ")} failed`) : null);

  // charts
  const healthBars = h("div", { class: "hbars" }, sources.map((x) => h("a", { class: "hbars__row", href: `#/s/${enc(x.name)}` },
    h("div", { class: "hbars__label" }, h("strong", {}, x.name), h("span", { class: "mono muted" }, KIND_NAMES[x.kind] || x.kind),
      h("span", { class: "hbars__meta mono" }, x.disabled ? "paused" : x.last_run ? `${time(x.last_run.started_at)}${x.last_run.status === "failed" ? " (failed)" : ""}` : "not run",
        h("b", { style: `color:${x.health_score === null ? "#71717a" : scoreColor(x.health_score)}` }, x.health_score === null ? "—" : ` ${Math.round(x.health_score)}/100`))),
    meter(x.health_score ?? 0))));
  const bandLegend = h("div", { class: "legend" },
    [["#f87171", "< 60 unhealthy"], ["#f5d0a9", "60–84 needs attention"], ["#4ade80", "≥ 85 healthy"]].map(([c, t]) =>
      h("span", {}, h("i", { style: `background:${c}` }), t)));
  const series = details.map((d, i) => ({ name: d.src.name, color: SERIES[i % SERIES.length],
    points: d.history.health.map((p) => ({ at: new Date(p.at), y: p.score })) }));
  const seriesLegend = h("div", { class: "legend" }, series.map((x) => h("span", {}, h("i", { style: `background:${x.color}` }), x.name)));

  const cats = Object.keys(CATEGORY).filter((c) => sources.some((x) => x.open_by_category[c]));
  const taxonomy = cats.length ? h("div", { class: "stack" },
    h("div", { class: "legend legend--chips" }, cats.map((c) => h("span", {}, h("i", { style: `background:${CAT_COLOR[c]}` }), CATEGORY[c]))),
    sources.map((x) => {
      const total = sum(x.open_by_category);
      return h("a", { class: "stackrow", href: `#/problems?db=${enc(x.name)}` },
        h("span", { class: "stackrow__label" }, x.name, h("span", { class: "muted mono" }, ` (${total})`)),
        h("span", { class: "stackrow__bar" }, total ? cats.filter((c) => x.open_by_category[c]).map((c) =>
          h("span", { style: `flex:${x.open_by_category[c]};background:${CAT_COLOR[c]}`, title: `${CATEGORY[c]}: ${x.open_by_category[c]}` }))
          : h("span", { class: "stackrow__none" }, "no open problems")));
    })) : h("div", { class: "empty" }, "No open problems in any database.");

  const worst = details.flatMap((d) => (d.health?.tables || []).filter((t) => t.score < 100).map((t) => ({ ...t, source: d.src.name })))
    .sort((a, b) => a.score - b.score).slice(0, 6);
  const worstRows = worst.map((t) => {
    const top = findings.find((f) => f.source === t.source && f.table === t.table);
    return [h("span", { class: "chip" }, t.source), h("code", {}, t.table),
      h("span", { class: "score-cell" }, h("b", { style: `color:${scoreColor(t.score)}` }, Math.round(t.score)), meter(t.score)),
      badge(`${sum(t.open_findings)} open`, "badge--soft"),
      top ? h("a", { href: `#/f/${top.id}`, class: "mono small" }, top.title) : h("span", { class: "muted small" }, "—")];
  });

  const feed = findings.slice(0, 6).map((f) => problemRow(f));
  show(
    heading("All databases", { kicker: h("span", { class: "live" }, h("i"), `${plural(sources.length, "database")} watched`),
      lead: "What's wrong right now, what changed since the last run, and what waits for a person.",
      actions: can("admin") ? [h("a", { class: "btn", href: "#/databases/add" }, "+ Add a database")] : [] }),
    h("div", { class: "kpis" }, healthTile, problemsTile, reviewTile, runsTile),
    h("div", { class: "grid2" },
      panel("Health by database", "0–100, from the last run", healthBars, bandLegend),
      panel("Health over time", "Each run, last 30 days", seriesLegend, lineChart(series, { label: "health over time", yMin: scoreFloor(series.flatMap((x) => x.points.map((p) => p.y))) }))),
    panel("Open problems by kind", `${plural(open, "open problem")} across ${plural(sources.length, "database")}`, taxonomy),
    panel("Worst tables", "Lowest health first",
      table(["Database", "Table", "Score", "Problems", "Top problem"], worstRows, "Every table is at 100.")),
    panel("Latest problems", "Most severe first", feed.length ? h("div", { class: "feed" }, feed) : h("div", { class: "empty" }, "No open problems."),
      feed.length ? h("a", { class: "panel__more", href: "#/problems" }, `See all ${open} →`) : null));
}

function welcome() {
  return h("div", { class: "welcome" },
    h("div", { class: "kicker" }, "Welcome"),
    h("h1", {}, "Point Lumida at your first database"),
    h("p", { class: "head__lead" }, "It reads read-only, learns what normal looks like on the first run, and from the next run on tells you what's wrong, with evidence."),
    can("admin") ? h("a", { class: "btn btn--primary", href: "#/databases/add" }, "+ Add a database")
      : h("p", { class: "muted" }, "Ask an admin to add a database."));
}

// One problem as a feed row.
function problemRow(f) {
  return h("a", { class: "feed__row", href: `#/f/${f.id}` },
    sevBadge(f.severity),
    h("div", { class: "feed__text" }, h("strong", {}, f.title),
      h("span", { class: "mono muted small" }, [f.source, f.table ? (f.column ? `${f.table}.${f.column}` : f.table) : null,
        ago(f.last_detected_at), f.status].filter(Boolean).join(" · "))),
    h("span", { class: "btn btn--small" }, "Investigate"));
}

// --- databases ---------------------------------------------------------------------------

async function databasesPage(adding) {
  await loadSources();
  frame("databases", [["Databases", "#/databases"], adding ? ["Add a database"] : ["All"]]);
  const total = sources.reduce((a, x) => a + x.tables, 0);
  const active = sources.filter((x) => !x.disabled && x.run_at).length;
  const paused = sources.filter((x) => x.disabled).length;
  const rows = sources.map((x) => {
    const trend = x.last_run?.status === "failed" ? badge("failing", "badge--hot") : x.disabled ? badge("paused", "badge--soft") : null;
    return [
      h("a", { href: `#/s/${enc(x.name)}`, class: "dbname" }, h("strong", {}, x.name), trend,
        h("span", { class: "mono muted small" }, x.connection_ref || "")),
      h("span", { class: "chip" }, KIND_NAMES[x.kind] || x.kind),
      x.health_score === null ? h("span", { class: "muted small" }, "after the first run")
        : h("span", { class: "score-cell" }, h("b", { style: `color:${scoreColor(x.health_score)}` }, Math.round(x.health_score)), meter(x.health_score)),
      h("span", { class: "mono" }, x.tables),
      sum(x.open_findings) ? h("a", { href: `#/problems?db=${enc(x.name)}` }, sum(x.open_findings)) : h("span", { class: "muted" }, "0"),
      h("span", { class: "mono small" }, x.run_at ? `daily ${x.run_at} ${x.timezone}` : "not scheduled"),
      x.last_run ? h("span", { class: `pipe pipe--${x.last_run.status}` }, h("i"), `${ago(x.last_run.started_at)}`) : h("span", { class: "muted small" }, "not run yet"),
    ];
  });
  const content = [
    heading("Databases", { kicker: h("span", { class: "live" }, h("i"), "read-only"),
      lead: `${plural(sources.length, "database")} · ${plural(total, "table")} watched · nothing leaves this network`,
      actions: can("admin") ? [h("a", { class: "btn btn--primary", href: "#/databases/add" }, "+ Add a database")] : [] }),
    h("div", { class: "row pills" }, badge(`${active} scheduled`, "badge--soft"), paused ? badge(`${paused} paused`, "badge--soft") : null),
    panel(null, null, table(["Database", "Kind", "Health", "Tables", "Open", "Schedule", "Last run"], rows,
      can("admin") ? "No databases yet. Add the first one." : "No databases yet. Ask an admin to add one.")),
    h("div", { class: "grid3 promises" },
      promise("lock", "Read-only", "A read-only login, read-only transactions and timeouts on every query. Lumida never writes to your databases."),
      promise("runs", "Learns normal", "Each night it measures every table inside the database and compares it with what it learned before."),
      promise("database", "Nothing leaves", "Connection URLs stay in this server's .env. Only counts, statistics and row IDs are kept, here.")),
  ];
  if (!adding) return show(...content);
  show(...content, await addDrawer());
}

const promise = (iconName, title, text) => h("div", { class: "promise" }, icon(iconName, 18), h("h3", {}, title), h("p", {}, text));

const ZONES = ["UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles",
  "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];

async function addDrawer() {
  const connections = await api("/connections");
  const name = h("input", { id: "src-name", required: true, pattern: "[A-Za-z0-9_.-]+", placeholder: "e.g. shop" });
  let kind = "postgres";
  const kinds = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Kind" });
  const connection = h("select", { id: "src-conn" });
  const include = h("input", { id: "src-include", placeholder: "all" });
  const exclude = h("input", { id: "src-exclude", placeholder: "none" });
  const runAt = h("input", { id: "src-run-at", type: "time", value: "03:00" });
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const zone = h("input", { id: "src-zone", value: localZone, list: "zones" });
  const zones = h("datalist", { id: "zones" }, [...new Set([localZone, ...ZONES])].map((z) => h("option", { value: z })));
  const script = h("pre", { class: "code" });
  const testLine = h("div", { class: "small" });
  const error = h("p", { class: "bad small", role: "alert" });

  const fillConnections = () => {
    const matching = connections.filter((c) => c.kind === kind);
    connection.replaceChildren(...(matching.length ? matching.map((c) => h("option", { value: c.name }, c.name))
      : [h("option", { value: "" }, "none of this kind in .env")]));
  };
  const fillScript = async () => { script.textContent = (await api(`/setup-scripts/${kind}`)).script; };
  const drawKinds = () => kinds.replaceChildren(...Object.entries(KIND_NAMES).map(([k, label]) =>
    h("button", { type: "button", role: "radio", "aria-checked": String(k === kind), class: k === kind ? "on" : "",
      onclick: () => { kind = k; drawKinds(); fillConnections(); fillScript(); testLine.replaceChildren(); } },
    icon("database", 16), h("span", {}, label))));
  const list = (input) => input.value.split(",").map((x) => x.trim()).filter(Boolean);
  const scope = () => ({ include_schemas: list(include), exclude_schemas: list(exclude) });

  const test = h("button", { class: "btn", type: "button", onclick: async () => {
    if (!connection.value) { toast("Pick a connection first", true); return; }
    test.disabled = true;
    try {
      const job = await api("/connection-tests", { method: "POST", body: { kind, connection_ref: connection.value, ...scope() } });
      await watchJob(job, testLine, async (j) => {
        if (j.status !== "succeeded") return;
        const schemas = Object.entries(j.result.schemas).map(([sch, n]) => `${sch} (${n})`).join(", ");
        testLine.replaceChildren(h("div", { class: "ok-box" }, h("strong", {}, "Connected read-only. "),
          `Can see ${j.result.tables} tables`, schemas ? ` in ${schemas}.` : ". Nothing to watch: check the schemas and the login's grants."));
      });
    } catch (err) {
      if (err.status !== 401) toast(err.message, true);
    } finally { test.disabled = false; }
  } }, "Test connection");
  const runNow = h("input", { type: "checkbox", id: "src-run-now", checked: true });
  const copy = h("button", { class: "btn btn--small", type: "button", onclick: async () => {
    try { await navigator.clipboard.writeText(script.textContent); toast("Copied"); } catch { toast("Select the text and copy it", true); }
  } }, "Copy SQL");

  const close = () => { location.hash = "#/databases"; };
  const form = h("form", { class: "drawer__body", onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      const added = await api("/sources", { method: "POST", body: {
        name: name.value, kind, connection_ref: connection.value,
        run_at: runAt.value || null, timezone: zone.value || "UTC", ...scope() } });
      if (runNow.checked) await startJob(added.name, "run");
      toast(`${added.name} added${runNow.checked ? "; the first run has started" : ""}`);
      remember(added.name);
      location.hash = `#/s/${enc(added.name)}`;
    } catch (err) {
      if (err.status !== 401) error.textContent = err.message;
    }
  } },
    field("src-name", "Name in Lumida", name),
    h("div", { class: "field" }, h("label", {}, "Kind"), kinds),
    field("src-conn", "Connection (a name from this server's .env)", connection),
    h("div", { class: "note" }, icon("lock", 14), h("span", {}, "Lumida never shows or stores the connection URL here. It stays in .env on this machine; you pick it by name.",
      connections.length ? "" : " No database URLs found in .env yet: add a line like SHOP_DB_URL=postgresql+psycopg://… and restart Lumida.")),
    h("div", { class: "row2" }, field("src-include", "Only these schemas", include, "comma-separated"),
      field("src-exclude", "Leave out these schemas", exclude, "e.g. aide_lab")),
    h("div", { class: "row2" }, field("src-run-at", "Run every night at", runAt, "Empty = no schedule"), field("src-zone", "Time zone", zone), zones),
    h("details", { class: "box" }, h("summary", {}, "Create a read-only login (SQL to run on the database)"),
      h("p", { class: "muted small" }, "Fill in the <placeholders>. It grants reading only."), script, copy),
    h("div", { class: "row" }, test), testLine,
    h("label", { class: "check" }, runNow, h("span", {}, "Run it right after adding (the first run learns what's normal; it doesn't alert)")),
    error,
    h("div", { class: "drawer__foot" }, h("button", { class: "btn", type: "button", onclick: close }, "Cancel"),
      h("button", { class: "btn btn--primary", type: "submit" }, "Add database")));
  drawKinds();
  fillConnections();
  await fillScript();
  const drawer = h("div", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "drawer-title" },
    h("div", { class: "drawer__scrim", onclick: close }),
    h("div", { class: "drawer__panel" },
      h("div", { class: "drawer__head" }, h("div", {}, h("h2", { id: "drawer-title" }, h("span", { class: "dot" }), "Add a database"),
        h("p", { class: "muted small" }, "Lumida connects read-only using a connection from this server's .env.")),
      h("button", { class: "btn btn--ghost", type: "button", "aria-label": "Close", onclick: close }, "✕")),
      form));
  drawer.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  setTimeout(() => name.focus(), 0);
  return drawer;
}

// --- one database --------------------------------------------------------------------------

const TABS = [["", "Overview"], ["problems", "Problems"], ["rules", "Rules"], ["relationships", "Relationships"],
  ["questions", "Questions"], ["runs", "Runs"]];

async function sourcePage(name, tab, query) {
  await loadSources();
  const source = await api(`/sources/${enc(name)}`);
  remember(source.name);
  const section = ["rules", "relationships", "questions", "runs"].includes(tab) ? tab : "databases";
  const status = h("span", { class: "small" });
  const runControls = can("reviewer") ? jobButton(source.name, "run", "Run now", { line: status, iconName: "play" }) : [];
  frame(section, [["Databases", "#/databases"], [source.name, `#/s/${enc(source.name)}`],
    ...(tab ? [[TABS.find(([k]) => k === tab)?.[1] || "Settings"]] : [])], runControls.slice(0, 1));

  const shown = can("admin") ? [...TABS, ["settings", "Settings"]] : TABS;
  const counts = { problems: sum(source.open_findings) };
  const tabs = h("nav", { class: "tabs", "aria-label": "Sections" },
    shown.map(([key, label]) => h("a", { href: `#/s/${enc(name)}${key ? `/${key}` : ""}`, class: key === tab ? "on" : "",
      "aria-current": key === tab ? "page" : null }, label, counts[key] ? h("span", { class: "tabs__n" }, counts[key]) : null)));
  const pages = {
    "": () => sourceOverview(source),
    problems: () => problemsView([source], query, `#/s/${enc(source.name)}/problems`),
    rules: () => rulesTab(source),
    relationships: () => relationshipsTab(source, query),
    questions: () => questionsTab(source),
    runs: () => runsTab(source),
    settings: () => (can("admin") ? settingsTab(source) : h("div", { class: "panel muted" }, "Settings need the admin role.")),
  };
  const body = await (pages[tab] || pages[""])();
  const [latest] = await api(`/sources/${enc(source.name)}/jobs`, { params: { limit: 1 } });
  if (latest && ACTIVE.has(latest.status)) watchJob(latest, status, () => route());
  const run = source.last_run;
  const propose = about.ai_enabled && can("reviewer") ? jobButton(source.name, "propose_rules", "Propose rules (AI)")[0] : null;
  const head = h("section", { class: "dbhead" },
    h("div", { class: "dbhead__main" },
      h("h1", {}, source.name),
      h("div", { class: "row" }, h("span", { class: "chip" }, icon("database", 12), KIND_NAMES[source.kind] || source.kind),
        source.connection_ref ? h("span", { class: "chip mono" }, source.connection_ref) : null,
        source.disabled ? badge("paused", "badge--soft") : null,
        !source.baseline_done ? badge("learning: first run", "badge--soft") : null),
      h("ul", { class: "facts" },
        h("li", {}, run ? `Last run ${when(run.started_at)} · ${run.status}` : "Not run yet"),
        run?.finished_at ? h("li", {}, `Took ${duration(run.started_at, run.finished_at)}`) : null,
        h("li", {}, `${plural(source.tables, "table")} watched`),
        h("li", {}, source.run_at ? `Runs daily at ${source.run_at} (${source.timezone})` : "No nightly schedule"))),
    h("div", { class: "dbhead__score" }, ring(source.health_score, { size: 76 }),
      h("div", {}, h("div", { class: "kicker" }, "Health"),
        h("div", { class: "muted small" }, source.health_score === null ? "after the first run"
          : source.health_score >= 85 ? "healthy" : source.health_score >= 60 ? "needs attention" : "unhealthy"))),
    h("div", { class: "dbhead__actions" }, h("div", { class: "row" }, ...runControls.slice(0, 1), propose), status));
  show(head, tabs, body);
}

function duration(start, end) {
  const secs = Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

async function sourceOverview(source) {
  const n = enc(source.name);
  const [history, health] = await Promise.all([
    api(`/sources/${n}/history`, { params: { tables: 30 } }),
    maybe(api(`/sources/${n}/health`)),
  ]);
  const points = history.health.map((p) => ({ at: new Date(p.at), y: p.score }));
  const scores = points.map((p) => p.y);
  const healthPanel = panel("Health score", `Each run, last ${history.days} days`,
    scores.length ? h("div", { class: "statline" },
      h("b", {}, scores.at(-1).toFixed(1), h("small", {}, " / 100")),
      h("span", { class: "mono muted small" }, `low ${Math.min(...scores).toFixed(1)} · high ${Math.max(...scores).toFixed(1)}`)) : null,
    lineChart([{ name: source.name, color: "#f5d0a9", points }], { area: true, yMin: scoreFloor(scores), label: "health score over time" }));
  const runs = history.health.map((p) => ({ label: new Date(p.at).toLocaleDateString(), short: new Date(p.at).getDate(), parts: p.open_findings }));
  const last = history.health.at(-1)?.open_findings || {};
  const problemsPanel = panel("Open problems at each run", `${plural(runs.length, "run")}`,
    h("div", { class: "legend" }, SEVERITIES.filter((sev) => last[sev]).map((sev) => h("span", {}, h("i", { style: `background:${SEV_COLOR[sev]}` }), `${last[sev]} ${sev}`))),
    stackedBars(runs.slice(-30), [...SEVERITIES].reverse(), SEV_COLOR, { label: "open problems per run" }));

  const tiles = history.tables.slice(0, 9).map((t) => {
    const values = t.points.map((p) => p.rows);
    const spark = sparkline(values);
    const prev = values.at(-2);
    const change = prev === undefined ? null : values.at(-1) - prev;
    return h("div", { class: `tile${spark.out ? " tile--out" : ""}` },
      h("div", { class: "tile__top" }, h("code", {}, t.table),
        spark.out ? badge("unusual change", "badge--hot")
          : change ? h("span", { class: "mono muted small" }, `${change > 0 ? "+" : ""}${compact(change)}`) : null),
      h("div", { class: "tile__value mono" }, t.rows === null ? "—" : t.rows.toLocaleString()),
      spark.svg,
      h("div", { class: "tile__foot mono" }, spark.change === null ? "learning (needs 4 runs)"
        : `usually ${spark.change >= 0 ? "+" : ""}${compact(spark.change)} per run`,
      h("span", {}, plural(values.length, "run"))));
  });
  const fresh = history.tables.filter((t) => t.last_modified_at)
    .sort((a, b) => new Date(a.last_modified_at) - new Date(b.last_modified_at)).slice(0, 8);
  const oldest = fresh.length ? Math.max(...fresh.map((t) => Date.now() - new Date(t.last_modified_at))) : 1;
  const freshPanel = panel("Freshness", "When each table's data last changed (oldest first)",
    fresh.length ? h("div", { class: "fresh" }, fresh.map((t) => {
      const age = Date.now() - new Date(t.last_modified_at);
      const tone = age > 2 * 86400000 ? "#f87171" : age > 86400000 ? "#fb923c" : "#f5d0a9";
      return h("div", { class: "fresh__row" }, h("div", { class: "row between" }, h("code", {}, t.table),
        h("span", { class: "mono small", style: `color:${tone}` }, ago(t.last_modified_at))),
      h("span", { class: "meter meter--thin" }, h("span", { style: `width:${Math.max(4, (age / oldest) * 100)}%;background:${tone}` })));
    })) : h("div", { class: "empty" }, "This database doesn't report when tables change. Answer the deadline questions to track loads."));
  const schemas = health ? Object.entries(health.schemas) : [];
  const schemaPanel = panel("Health by schema", health ? `From the run at ${when(health.computed_at)}` : "After the first run",
    schemas.length ? h("div", { class: "schemas" }, schemas.map(([name, sc]) => h("a", { class: "schema", href: `#/s/${enc(source.name)}/problems?q=${enc(`${name}.`)}` },
      h("div", { class: "row between" }, h("strong", {}, name), h("span", { class: "mono", style: `color:${scoreColor(sc.score)}` }, `${Math.round(sc.score)}`)),
      meter(sc.score),
      h("div", { class: "row between muted small" }, h("span", {}, `${plural(sum(sc.open_findings), "open problem")}`),
        sc.worst_table !== null && sc.worst_table !== undefined ? h("span", {}, `worst table ${Math.round(sc.worst_table)}`) : null))))
      : h("div", { class: "empty" }, "No score yet."));
  return h("div", { class: "stack-lg" },
    h("div", { class: "grid2" }, healthPanel, problemsPanel),
    h("section", {}, h("div", { class: "section-head" }, h("div", {}, h("div", { class: "kicker" }, "Row counts"),
      h("h2", {}, "The biggest tables")), h("p", { class: "muted small" }, "Shaded: where each run was expected to land, from the table's usual change per run. Orange: the latest change was unusual.")),
    tiles.length ? h("div", { class: "tiles" }, tiles) : h("div", { class: "panel empty" }, "No measurements yet: they come with the first run.")),
    h("div", { class: "grid2" }, freshPanel, schemaPanel));
}

// --- problems (all databases, or one) --------------------------------------------------------

const STATUS_TABS = [["active", "Needs attention"], ["open", "Open"], ["confirmed", "Confirmed"], ["rejected", "Rejected"], ["resolved", "Resolved"]];
const PAGE = 25;

async function problemsPage(query) {
  await loadSources();
  frame("problems", [["Problems", "#/problems"], [query.get("db") || "All databases"]]);
  const only = query.get("db") ? sources.filter((x) => x.name === query.get("db")) : sources;
  const body = await problemsView(only, query, "#/problems");
  const open = sum(Object.fromEntries(only.map((x) => [x.name, sum(x.open_findings)])));
  show(heading("Problems", { kicker: `${plural(open, "open problem")} · ${plural(only.length, "database")}`,
    lead: "Everything Lumida found, most severe first. Confirm what's real; reject what isn't, and Lumida remembers." }), body);
}

async function problemsView(list, query, base) {
  const status = query.get("status") || "active";
  const severity = query.get("severity") || "";
  const category = query.get("category") || "";
  const db = query.get("db") || "";
  const q = (query.get("q") || "").trim().toLowerCase();
  const page = Number(query.get("page") || 0);
  const go = (change) => {
    const next = new URLSearchParams({ status, severity, category, db, q, page: 0, ...change });
    for (const [k, v] of [...next]) if (v === "" || (k === "page" && v === "0")) next.delete(k);
    location.hash = `${base}?${next}`;
  };
  const [items, histories] = await Promise.all([
    allFindings(list, status),
    Promise.all(list.map((x) => api(`/sources/${enc(x.name)}/history`, { params: { tables: 0 } }))),
  ]);
  const matching = items.filter((f) => (!severity || f.severity === severity) && (!category || f.category === category)
    && (!q || [f.title, f.table, f.column, f.check_name, f.source].filter(Boolean).join(" ").toLowerCase().includes(q)));
  const bySev = Object.fromEntries(SEVERITIES.map((sev) => [sev, items.filter((f) => f.severity === sev).length]));
  const newest = items.filter((f) => Date.now() - new Date(f.first_detected_at) < 86400000).length;

  const sevTiles = h("div", { class: "sevtiles" }, ["critical", "high", "medium", "low"].map((sev) =>
    h("button", { type: "button", class: `sevtile${severity === sev ? " on" : ""}`, onclick: () => go({ severity: severity === sev ? "" : sev }) },
      h("span", { class: "row between" }, h("span", { class: "kicker", style: `color:${SEV_COLOR[sev]}` }, sev), h("i", { style: `background:${SEV_COLOR[sev]}` })),
      h("b", {}, String(bySev[sev]).padStart(2, "0")))));
  const summary = h("div", { class: "grid-summary" },
    h("section", { class: "panel" }, h("div", { class: "kicker" }, "By severity"),
      h("div", { class: "bignum" }, items.length, h("span", {}, ` ${STATUS_TABS.find(([k]) => k === status)?.[1].toLowerCase() || status}`),
        newest ? badge(`${newest} new in 24 h`, "badge--hot") : null), sevTiles),
    list.length > 1 ? h("section", { class: "panel" }, h("div", { class: "kicker" }, "By database"),
      h("ul", { class: "dblist" }, list.map((x) => h("li", {}, h("a", { href: `${base}?db=${enc(x.name)}` }, h("i", { style: `background:${x.health_score === null ? "#71717a" : scoreColor(x.health_score)}` }), x.name,
        h("span", { class: "muted mono small" }, ` ${KIND_NAMES[x.kind] || x.kind}`)), h("span", { class: "mono small" }, plural(sum(x.open_findings), "problem")))))) : null);

  const over = problemsOverTime(histories);
  const chart = panel("Open problems over time", "Summed across databases, at each night's run",
    h("div", { class: "legend" }, ["critical", "high", "medium", "low"].map((sev) => h("span", {}, h("i", { style: `background:${SEV_COLOR[sev]}` }), sev))),
    stackedArea(over, ["low", "medium", "high", "critical"], SEV_COLOR, { label: "open problems over time" }));

  const tabs = h("div", { class: "seg" }, STATUS_TABS.map(([k, label]) =>
    h("button", { type: "button", class: k === status ? "on" : "", onclick: () => go({ status: k }) }, label)));
  const search = h("input", { type: "search", value: query.get("q") || "", placeholder: "Filter by table, column or words (e.g. orders.customer_id)", "aria-label": "Filter problems",
    onkeydown: (e) => { if (e.key === "Enter") go({ q: e.target.value }); } });
  const filters = h("div", { class: "filters" }, tabs,
    h("div", { class: "row" },
      list.length > 1 || db ? select("database", [["", "All databases"], ...sources.map((x) => [x.name, x.name])], db, (e) => go({ db: e.target.value })) : null,
      select("severity", [["", "All severities"], ...SEVERITIES.map((sev) => [sev, sev])], severity, (e) => go({ severity: e.target.value })),
      select("category", [["", "All kinds"], ...Object.entries(CATEGORY)], category, (e) => go({ category: e.target.value }))),
    h("div", { class: "searchbox" }, icon("search", 14), search));

  const chosen = new Set();
  const shown = matching.slice(page * PAGE, page * PAGE + PAGE);
  const bulk = h("div", { class: "bulk", hidden: true });
  const drawBulk = () => {
    bulk.hidden = !chosen.size;
    const picked = shown.filter((f) => chosen.has(f.id));
    const run = (action, button) => act(button, async () => {
      for (const f of picked) await api(`/findings/${f.id}/review`, { method: "POST", body: { action } });
    }, `${action === "confirm" ? "Confirmed" : "Rejected"} ${plural(picked.length, "problem")}`);
    const confirmB = h("button", { class: "btn btn--small", type: "button", disabled: !picked.every((f) => f.status === "open"),
      onclick: () => run("confirm", confirmB) }, `Confirm (${picked.length})`);
    const rejectB = h("button", { class: "btn btn--small", type: "button", disabled: !picked.every((f) => ["open", "confirmed"].includes(f.status)),
      onclick: () => run("reject", rejectB) }, `Reject (${picked.length})`);
    bulk.replaceChildren(h("span", {}, `${plural(picked.length, "problem")} selected`), h("div", { class: "row" }, confirmB, rejectB));
  };
  const reviewer = can("reviewer");
  const rows = shown.map((f) => [
    reviewer ? h("input", { type: "checkbox", "aria-label": `select ${f.title}`, onchange: (e) => {
      if (e.target.checked) chosen.add(f.id); else chosen.delete(f.id);
      drawBulk();
    } }) : "",
    sevBadge(f.severity),
    h("a", { href: `#/f/${f.id}`, class: `ptitle${f.status === "rejected" ? " ptitle--off" : ""}` }, f.title),
    h("span", { class: "small muted" }, CATEGORY[f.category] || f.category),
    h("span", { class: "mono small" }, h("span", { class: "accent" }, f.source), f.table ? ` · ${f.column ? `${f.table}.${f.column}` : f.table}` : ""),
    h("span", { class: "mono small muted", title: when(f.first_detected_at) }, date(f.first_detected_at)),
    h("span", { class: "mono small" }, ago(f.last_detected_at)),
    stBadge(f.status),
  ]);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE));
  const pager = h("div", { class: "pager" },
    h("span", { class: "muted small mono" }, matching.length ? `${page * PAGE + 1}–${Math.min(matching.length, (page + 1) * PAGE)} of ${matching.length}` : ""),
    h("div", { class: "row" },
      h("button", { class: "btn btn--small", type: "button", disabled: page === 0, onclick: () => go({ page: page - 1 }) }, "Previous"),
      h("span", { class: "mono small" }, `${page + 1} / ${pages}`),
      h("button", { class: "btn btn--small", type: "button", disabled: page + 1 >= pages, onclick: () => go({ page: page + 1 }) }, "Next")));
  return h("div", { class: "stack-lg" }, summary, chart,
    h("section", { class: "panel panel--flush" }, filters, bulk,
      table([reviewer ? "" : null, "Severity", "Problem", "Kind", "Where", "First seen", "Last seen", "Status"].filter((c) => c !== null),
        rows.map((r) => (reviewer ? r : r.slice(1))), "No problems match."), pager));
}

// --- one problem ---------------------------------------------------------------------------

const REVIEWED = { confirm: "Confirmed", reject: "Rejected", resolve: "Marked resolved", reopen: "Reopened" };
const FINDING_ACTIONS = {
  open: [["confirm", "Confirm: it's real"], ["reject", "Reject: not a problem"], ["resolve", "Mark resolved"]],
  confirmed: [["resolve", "Mark resolved"], ["reject", "Reject: not a problem"]],
  rejected: [["reopen", "Reopen"]],
  resolved: [["reopen", "Reopen"]],
};

// Split evidence into numbers to show big, SQL to show as code, ID lists, and the rest.
function evidenceParts(evidence) {
  const numbers = [];
  const sql = [];
  const ids = [];
  const rest = {};
  for (const [key, value] of Object.entries(evidence || {})) {
    const words = key.replaceAll("_", " ");
    if (typeof value === "number") numbers.push([words, value]);
    else if (typeof value === "string" && /^\s*(select|with)\b/i.test(value)) sql.push([words, value]);
    else if (Array.isArray(value) && value.length && value.every((v) => typeof v === "string" || typeof v === "number")) ids.push([words, value]);
    else rest[key] = value;
  }
  return { numbers, sql, ids, rest };
}

async function findingPage(id) {
  await loadSources();
  const f = await api(`/findings/${enc(id)}`);
  remember(f.source);
  frame("problems", [["Problems", "#/problems"], [f.source, `#/s/${enc(f.source)}`], f.table ? [f.table] : null, [f.check_name]].filter(Boolean));
  const note = h("input", { id: "note", placeholder: "Why? (kept in the history and the audit log)", maxlength: 2000, "aria-label": "Review note" });
  const actions = (FINDING_ACTIONS[f.status] || []).map(([action, label], i) => {
    const button = h("button", { type: "button", class: `btn${i === 0 ? " btn--primary" : ""}`, onclick: () => act(button,
      () => api(`/findings/${f.id}/review`, { method: "POST", body: { action, note: note.value || null } }), REVIEWED[action]) }, label);
    return button;
  });
  const review = can("reviewer")
    ? h("section", { class: "panel review" },
      h("div", { class: "review__top" }, h("div", {}, h("h2", {}, "Your review"),
        h("p", { class: "muted small" }, f.reviewed_by ? `Last reviewed by ${f.reviewed_by} · ${when(f.reviewed_at)}` : "Your decision teaches Lumida what's real here, and is recorded in the audit log.")),
      h("div", { class: "row" }, actions)), h("div", { class: "searchbox" }, note))
    : h("section", { class: "panel muted small" }, "Reviewing needs the reviewer role.");

  const ev = evidenceParts(f.evidence);
  const evidence = panel("Evidence", "Measured inside your database; only numbers and row IDs leave it",
    h("p", {}, f.description),
    ev.numbers.length ? h("div", { class: "numbers" }, ev.numbers.map(([k, v]) => h("div", { class: "number" },
      h("span", { class: "kicker" }, k), h("b", { class: "mono" }, Number.isInteger(v) ? v.toLocaleString() : v.toPrecision(4))))) : null,
    ev.sql.map(([k, v]) => h("div", { class: "stack" }, h("div", { class: "row between" }, h("span", { class: "kicker" }, k),
      h("button", { class: "btn btn--small", type: "button", onclick: async () => {
        try { await navigator.clipboard.writeText(v); toast("Copied"); } catch { toast("Select the text and copy it", true); }
      } }, "Copy SQL")), h("pre", { class: "code" }, v))),
    ev.ids.map(([k, v]) => h("div", { class: "stack" }, h("span", { class: "kicker" }, `${k} (${v.length}${v.length >= 20 ? "+" : ""})`),
      h("div", { class: "ids" }, v.slice(0, 40).map((x) => h("code", {}, String(x)))))),
    Object.keys(ev.rest).length ? h("details", { class: "box" }, h("summary", {}, "All details"), h("pre", { class: "code" }, JSON.stringify(ev.rest, null, 2))) : null);

  const e = f.explanation;
  const explanation = e ? h("section", { class: "panel ai" },
    h("div", { class: "panel__head" }, h("h2", {}, "AI explanation"),
      badge(e.confidence !== undefined && e.confidence !== null ? `confidence ${Number(e.confidence).toFixed(2)}` : "AI", "badge--soft")),
    h("p", { class: "muted small" }, "Written by AI from the evidence above. Review before trusting it."),
    h("div", { class: "ai__box" }, h("p", {}, e.summary), e.impact ? h("p", {}, h("strong", {}, "Impact: "), e.impact) : null),
    (e.likely_causes || []).length ? h("div", {}, h("div", { class: "kicker" }, "Possible causes"), h("ul", {}, e.likely_causes.map((c) => h("li", {}, c)))) : null,
    (e.next_steps || []).length ? h("div", {}, h("div", { class: "kicker" }, "What to check"),
      h("ol", { class: "steps" }, e.next_steps.map((c) => h("li", {}, c)))) : null,
    h("p", { class: "muted small mono" }, `${e.provider || "AI"}${e.model ? ` / ${e.model}` : ""}`,
      e.explained_title && e.explained_title !== f.title ? " · written for an earlier version of this problem" : "")) : null;
  const explainButton = about.ai_enabled && can("reviewer") && ["open", "confirmed"].includes(f.status)
    ? h("section", { class: "panel row" }, ...jobButton(f.source, "explain", e ? "Explain again with AI" : "Explain with AI", { extra: { finding_id: f.id } }))
    : null;

  let impact = null;
  if (f.table) {
    const rels = (await api(`/sources/${enc(f.source)}/relationships`)).filter((r) => r.status !== "rejected"
      && (r.from_table === f.table || r.to_table === f.table));
    const map = linkMap(f.table, rels.map((r) => ({ from: r.from_table, to: r.to_table, kind: r.kind })));
    impact = panel("What it touches", rels.length ? `${plural(rels.length, "linked table")}: left, the tables it points to; right, the tables that point to it` : null,
      map || h("div", { class: "empty" }, "No known links to other tables."),
      map ? h("div", { class: "legend" }, h("span", {}, h("i", { class: "line" }), "foreign key"), h("span", {}, h("i", { class: "line line--dash" }), "found by Lumida")) : null);
  }

  const history = panel("History", plural(f.history.length, "event"),
    h("ol", { class: "timeline" }, f.history.map((ev2) => h("li", {},
      h("div", { class: "row between" }, h("strong", {}, ev2.from_status ? `${ev2.from_status} → ${ev2.to_status}` : `found (${ev2.to_status})`),
        h("span", { class: "mono small muted" }, when(ev2.at))),
      h("div", { class: "small muted" }, ev2.by, ev2.note ? ` · “${ev2.note}”` : "")))));

  show(
    h("div", { class: "fhead" },
      h("div", { class: "row" }, sevBadge(f.severity), badge(CATEGORY[f.category] || f.category, "badge--soft"), stBadge(f.status),
        h("span", { class: "mono small muted" }, `first seen ${when(f.first_detected_at)} · last seen ${ago(f.last_detected_at)}`)),
      h("h1", {}, f.title),
      h("div", { class: "row" }, h("a", { class: "chip", href: `#/s/${enc(f.source)}` }, icon("database", 12), f.source),
        f.table ? h("span", { class: "chip mono" }, f.column ? `${f.table}.${f.column}` : f.table) : null,
        h("span", { class: "chip mono" }, f.check_name))),
    review,
    h("div", { class: "grid-detail" },
      h("div", { class: "stack-lg" }, evidence, impact),
      h("div", { class: "stack-lg" }, explanation, explainButton, history)));
}

// --- rules, relationships, questions, runs ---------------------------------------------------

const RULE_ACTIONS = {
  proposed: [["approve", "Approve"], ["reject", "Reject"]],
  active: [["disable", "Disable"]],
  disabled: [["enable", "Enable"]],
  rejected: [["reconsider", "Reconsider"]],
};
const RULE_ORDER = { proposed: 0, active: 1, disabled: 2, rejected: 3 };

async function rulesTab(source) {
  const rules = (await api(`/sources/${enc(source.name)}/rules`)).sort((a, b) => RULE_ORDER[a.status] - RULE_ORDER[b.status]);
  const byStatus = Object.fromEntries(Object.keys(RULE_ORDER).map((k) => [k, rules.filter((r) => r.status === k).length]));
  const rows = rules.map((r) => [
    stBadge(r.status),
    h("details", { class: "rule" }, h("summary", {}, r.name),
      r.rationale ? h("p", { class: "muted small" }, r.rationale) : null,
      h("pre", { class: "code" }, JSON.stringify(r.spec, null, 2))),
    h("span", { class: "small" }, r.origin, r.confidence === null ? "" : h("span", { class: "mono muted" }, ` · ${r.confidence.toFixed(2)}`)),
    can("reviewer") ? h("div", { class: "row" }, (RULE_ACTIONS[r.status] || []).map(([action, label]) => {
      const button = h("button", { type: "button", class: `btn btn--small${action === "approve" ? " btn--primary" : ""}`,
        onclick: () => act(button, () => api(`/rules/${r.id}/review`, { method: "POST", body: { action } }), `${label}: done`) }, label);
      return button;
    })) : "",
  ]);
  const propose = about.ai_enabled && can("reviewer")
    ? h("div", { class: "row" }, ...jobButton(source.name, "propose_rules", "Propose rules with AI"),
      h("span", { class: "muted small" }, "The AI reads the structure and measurements (no row values) and suggests rules for you to review."))
    : null;
  return h("div", { class: "stack-lg" },
    h("div", { class: "statrow" }, [["proposed", "waiting for review"], ["active", "checked every night"], ["disabled", "paused"], ["rejected", "rejected"]].map(([k, text]) =>
      h("div", { class: "stat" }, h("b", {}, byStatus[k]), h("span", {}, text)))),
    panel("Rules", "Approved rules run every night as plain SQL inside your database",
      propose,
      h("div", { class: "row" },
        h("a", { class: "btn btn--small", href: `${API}/sources/${enc(source.name)}/rules/export`, download: `lumida-rules-${source.name}.yaml` }, "Download as YAML"),
        h("span", { class: "muted small" }, "Keep approved rules in git; ", h("code", {}, "lumida check"), " runs them in your CI.")),
      table(["Status", "Rule", "From", ""], rows, "No rules yet. Propose some with AI, or answer the questions.")));
}

async function relationshipsTab(source, query) {
  const all = query.get("all") === "1";
  const rels = await api(`/sources/${enc(source.name)}/relationships`, { params: { include_rejected: all } });
  const proposed = rels.filter((r) => r.status === "proposed").length;
  const rows = rels.map((r) => [
    h("div", { class: "rel" }, h("code", {}, `${r.from_table}(${r.from_columns.join(", ")})`), h("span", { class: "rel__arrow" }, "→"),
      h("code", {}, `${r.to_table}(${r.to_columns.join(", ")})`)),
    r.kind === "declared" ? badge("foreign key", "badge--soft")
      : h("div", { class: "conf" }, h("span", { class: "meter meter--thin" }, h("span", { style: `width:${(r.confidence || 0) * 100}%;background:#f5d0a9` })),
        h("span", { class: "mono small" }, (r.confidence || 0).toFixed(2))),
    h("div", { class: "row chips" }, r.signals.map((sig) => h("span", { class: "chip chip--small" }, sig.replaceAll("_", " "))),
      r.ai_review ? h("span", { class: "chip chip--small" }, `AI: ${r.ai_review.verdict}`) : null),
    stBadge(r.status),
    can("reviewer") && r.status === "proposed" ? h("div", { class: "row" }, [["confirm", "Confirm"], ["reject", "Reject"]].map(([action, label]) => {
      const button = h("button", { type: "button", class: `btn btn--small${action === "confirm" ? " btn--primary" : ""}`, onclick: () => act(button,
        () => api(`/relationships/${r.id}/review`, { method: "POST", body: { action } }), `${label}ed`) }, label);
      return button;
    })) : "",
  ]);
  return panel("Relationships", `${plural(rels.length, "link")} between tables${proposed ? ` · ${proposed} waiting for review` : ""}: declared foreign keys, and links Lumida found from names, values and queries`,
    h("a", { class: "small", href: `#/s/${enc(source.name)}/relationships${all ? "" : "?all=1"}` }, all ? "Hide rejected" : "Show rejected"),
    table(["Link", "Confidence", "Found by", "Status", ""], rows, "No relationships found yet."));
}

async function questionsTab(source) {
  const questions = await api(`/sources/${enc(source.name)}/questions`, { params: { limit: 20 } });
  if (!questions.length) return h("div", { class: "panel empty" }, "No open questions: everything useful has been answered.");
  return h("div", { class: "stack-lg" },
    h("p", { class: "muted" }, "Lumida can't guess these from the data. Your answers become checks, deadlines and importance levels."),
    h("div", { class: "qgrid" }, questions.map((q) => {
      const input = h("input", { value: q.suggested, "aria-label": "answer" });
      const send = (value, button) => act(button,
        () => api(`/sources/${enc(source.name)}/answers`, { method: "POST", body: { key: q.key, value } }),
        (reply) => reply.outcome);
      const answer = h("button", { type: "button", class: "btn btn--primary btn--small", onclick: () => send(input.value, answer) }, "Answer");
      const skip = h("button", { type: "button", class: "btn btn--small", onclick: () => send("?", skip) }, "Don't know");
      return h("section", { class: "panel question" }, h("span", { class: "kicker" }, q.kind.replaceAll("_", " ")), h("h3", {}, q.prompt),
        h("p", { class: "muted small" }, q.hint),
        can("reviewer") ? h("div", { class: "row" }, input, answer, skip) : h("p", { class: "muted small" }, "Answering needs the reviewer role."));
    })));
}

async function runsTab(source) {
  const [runs, jobs] = await Promise.all([
    api(`/sources/${enc(source.name)}/runs`, { params: { limit: 30 } }),
    api(`/sources/${enc(source.name)}/jobs`, { params: { limit: 20 } }),
  ]);
  const longest = Math.max(1, ...runs.filter((r) => r.finished_at).map((r) => new Date(r.finished_at) - new Date(r.started_at)));
  const done = runs.filter((r) => r.status === "succeeded").length;
  return h("div", { class: "stack-lg" },
    h("div", { class: "statrow" },
      h("div", { class: "stat" }, h("b", {}, runs.length), h("span", {}, "recent runs")),
      h("div", { class: "stat" }, h("b", {}, runs.length ? `${Math.round((done / runs.length) * 100)}%` : "—"), h("span", {}, "succeeded")),
      h("div", { class: "stat" }, h("b", {}, runs[0]?.finished_at ? duration(runs[0].started_at, runs[0].finished_at) : "—"), h("span", {}, "last run took"))),
    panel("Runs", "Every night at the scheduled time, or when someone presses Run now",
      table(["Started", "Took", "Status", "Problem"], runs.map((r) => [
        h("span", { class: "mono small" }, when(r.started_at)),
        r.finished_at ? h("div", { class: "dur" }, h("span", { class: "meter meter--thin" },
          h("span", { style: `width:${((new Date(r.finished_at) - new Date(r.started_at)) / longest) * 100}%;background:${r.status === "failed" ? "#f87171" : "#f5d0a9"}` })),
        h("span", { class: "mono small" }, duration(r.started_at, r.finished_at))) : h("span", { class: "muted small" }, "—"),
        stBadge(r.status), h("span", { class: "small bad" }, r.error_message || "")]),
      "No runs yet. Lumida runs every night at the scheduled time, or press Run now.")),
    panel("Asked for in the app", null, table(["Asked", "What", "By", "Status", "Outcome"],
      jobs.map((j) => [h("span", { class: "mono small" }, when(j.requested_at)), JOB_WORDS[j.kind] || j.kind, j.requested_by, stBadge(j.status),
        h("span", { class: "small" }, j.error || (j.result.summary || []).slice(0, 1).join(""))]),
      "Nothing asked for yet.")));
}

// --- a database's settings (admins) -----------------------------------------------------

async function settingsTab(source) {
  const runAt = h("input", { id: "set-run-at", type: "time", value: source.run_at || "" });
  const zone = h("input", { id: "set-zone", value: source.timezone });
  const include = h("input", { id: "set-include", value: (source.include_schemas || []).join(", "), placeholder: "all" });
  const exclude = h("input", { id: "set-exclude", value: (source.exclude_schemas || []).join(", "), placeholder: "none" });
  const list = (input) => input.value.split(",").map((x) => x.trim()).filter(Boolean);
  const save = h("form", { class: "panel stack", onsubmit: (event) => {
    event.preventDefault();
    act(event.submitter, () => api(`/sources/${enc(source.name)}`, { method: "PATCH", body: {
      run_at: runAt.value || null, timezone: zone.value || "UTC",
      include_schemas: list(include), exclude_schemas: list(exclude) } }), "Saved");
  } },
    h("h2", {}, "Schedule and scope"),
    h("div", { class: "row2" }, field("set-run-at", "Run every night at", runAt, "Empty = no schedule"), field("set-zone", "Time zone", zone)),
    h("div", { class: "row2" }, field("set-include", "Only these schemas", include), field("set-exclude", "Leave out these schemas", exclude)),
    h("p", { class: "muted small" }, "Connection: ", h("code", {}, source.connection_ref || "—"), " (in the server's .env)."),
    h("div", {}, h("button", { class: "btn btn--primary", type: "submit" }, "Save")));

  const pause = h("button", { type: "button", class: "btn", onclick: () => act(pause,
    () => api(`/sources/${enc(source.name)}`, { method: "PATCH", body: { paused: !source.disabled } }),
    source.disabled ? "Nightly runs resumed" : "Paused: no nightly runs until you resume") },
  source.disabled ? "Resume nightly runs" : "Pause nightly runs");

  const confirm = h("input", { id: "remove-confirm", placeholder: source.name, autocomplete: "off" });
  const remove = h("button", { type: "button", class: "btn btn--danger", onclick: async () => {
    if (confirm.value !== source.name) { toast(`Type ${source.name} to confirm`, true); return; }
    remove.disabled = true;
    try {
      await api(`/sources/${enc(source.name)}`, { method: "DELETE", params: { confirm: confirm.value } });
      toast(`${source.name} removed`);
      location.hash = "#/databases";
    } catch (err) {
      if (err.status !== 401) toast(err.message, true);
      remove.disabled = false;
    }
  } }, "Remove");

  return h("div", { class: "grid2" },
    save,
    h("div", { class: "stack-lg" },
      h("section", { class: "panel stack" }, h("h2", {}, "Pause"),
        h("p", { class: "muted small" }, source.disabled
          ? "Paused: Lumida doesn't run this database at night. Run now still works."
          : "Stop the nightly runs for a while (e.g. during a migration). Nothing is deleted."),
        h("div", {}, pause)),
      h("section", { class: "panel stack danger" }, h("h2", {}, "Remove"),
        h("p", { class: "muted small" }, "Forget everything Lumida learned about this database: its history, problems, rules and answers. The database itself is never touched. This can't be undone."),
        h("label", { for: "remove-confirm" }, `Type ${source.name} to confirm`), h("div", { class: "row" }, confirm, remove))));
}

// --- people, audit log, my account ---------------------------------------------------------

async function peoplePage() {
  await loadSources();
  frame("people", [["Workspace"], ["People"]]);
  const users = await api("/users");
  const email = h("input", { id: "new-email", type: "email", required: true });
  const name = h("input", { id: "new-name" });
  const role = select("role", [["viewer", "viewer"], ["reviewer", "reviewer"], ["admin", "admin"]], "viewer");
  const password = h("input", { id: "new-password", type: "password", minlength: 12, required: true, autocomplete: "new-password" });
  const add = h("form", { class: "panel stack", onsubmit: (event) => {
    event.preventDefault();
    act(event.submitter, () => api("/users", { method: "POST",
      body: { email: email.value, name: name.value, role: role.value, password: password.value } }), "Account created");
  } },
    h("h2", {}, "Add a person"), field("new-email", "Email", email), field("new-name", "Name", name),
    h("div", { class: "field" }, h("label", {}, "Role"), role,
      h("div", { class: "hint" }, "Viewers read; reviewers also confirm problems and approve rules; admins also manage databases and people.")),
    field("new-password", "First password (12+ characters; tell them to change it)", password),
    h("div", {}, h("button", { class: "btn btn--primary", type: "submit" }, "Create account")));
  const rows = users.map((u) => {
    const self = u.email === me.email;
    const roleSelect = select(`role of ${u.email}`, [["viewer", "viewer"], ["reviewer", "reviewer"], ["admin", "admin"]], u.role,
      (e) => act(e.target, () => api(`/users/${u.id}`, { method: "PATCH", body: { role: e.target.value } }), "Role changed"));
    roleSelect.disabled = self;
    const toggle = h("button", { type: "button", class: `btn btn--small${u.disabled ? "" : " btn--danger"}`, disabled: self,
      onclick: () => act(toggle, () => api(`/users/${u.id}`, { method: "PATCH", body: { disabled: !u.disabled } }),
        u.disabled ? "Enabled" : "Disabled; their sessions ended") }, u.disabled ? "Enable" : "Disable");
    const newPassword = h("input", { type: "password", minlength: 12, autocomplete: "new-password",
      placeholder: "new password", "aria-label": `new password for ${u.email}`, hidden: true });
    const reset = h("button", { type: "button", class: "btn btn--small", onclick: () => {
      if (newPassword.hidden) { newPassword.hidden = false; reset.textContent = "Set password"; newPassword.focus(); return; }
      act(reset, () => api(`/users/${u.id}/password`, { method: "POST", body: { password: newPassword.value } }),
        "Password set; their sessions ended");
    } }, "Reset password");
    return [h("div", {}, h("strong", {}, u.email), h("div", { class: "muted small" }, u.name)), roleSelect,
      u.disabled ? badge("disabled", "st-disabled") : u.locked ? badge("locked", "st-failed") : badge("active", "st-active"),
      h("span", { class: "small mono muted" }, when(u.last_login_at)), h("div", { class: "row" }, toggle, newPassword, reset)];
  });
  show(heading("People", { kicker: plural(users.length, "account"), lead: "Who can log in to this Lumida, and what they may do." }),
    h("div", { class: "grid-side" }, panel(null, null, table(["Person", "Role", "State", "Last login", ""], rows)), add));
}

async function auditPage(query) {
  await loadSources();
  frame("audit", [["Workspace"], ["Audit log"]]);
  const action = query.get("action") || "";
  const offset = Number(query.get("offset") || 0);
  const events = await api("/audit", { params: { action, limit: 50, offset } });
  const go = (change) => { location.hash = `#/audit?${new URLSearchParams({ action, offset: 0, ...change })}`; };
  const filter = select("action", [["", "Everything"], ["auth", "Logins"], ["finding", "Problem reviews"],
    ["rule", "Rules"], ["relationship", "Relationships"], ["question", "Answers"], ["user", "People"], ["key", "API keys"]],
  action, (e) => go({ action: e.target.value }));
  const rows = events.map((e) => [h("span", { class: "small mono" }, when(e.at)), e.actor, h("code", {}, e.action),
    h("span", { class: "small muted" }, Object.entries(e.details).map(([k, v]) => `${k}: ${v}`).join(" · "))]);
  show(heading("Audit log", { kicker: "Who did what, when", lead: "Every login, review and change, kept in Lumida's own database.", actions: [filter] }),
    panel(null, null, table(["When", "Who", "What", "Details"], rows, "Nothing recorded yet."),
      h("div", { class: "pager" }, h("span", {}),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn btn--small", disabled: offset === 0, onclick: () => go({ offset: Math.max(0, offset - 50) }) }, "Newer"),
          h("button", { type: "button", class: "btn btn--small", disabled: events.length < 50, onclick: () => go({ offset: offset + 50 }) }, "Older")))));
}

async function mePage() {
  await loadSources();
  frame("me", [["Workspace"], ["My account"]]);
  const keys = await api("/auth/keys");
  const currentPw = h("input", { id: "pw-current", type: "password", autocomplete: "current-password", required: true });
  const fresh = h("input", { id: "pw-new", type: "password", autocomplete: "new-password", minlength: 12, required: true });
  const passwordForm = h("form", { class: "panel stack", onsubmit: async (event) => {
    event.preventDefault();
    try {
      await api("/auth/password", { method: "POST", body: { current_password: currentPw.value, new_password: fresh.value } });
      toast("Password changed. Please log in again.");
      me = null;
      location.hash = "#/login";
    } catch (err) {
      if (err.status !== 401) toast(err.message, true);
    }
  } },
    h("h2", {}, "Change password"),
    field("pw-current", "Current password", currentPw),
    field("pw-new", "New password (12+ characters)", fresh),
    h("div", {}, h("button", { class: "btn btn--primary", type: "submit" }, "Change password")));
  const label = h("input", { "aria-label": "key label", placeholder: "e.g. jira sync", maxlength: 200 });
  const made = h("div");
  if (newKey) {
    made.append(h("div", { class: "stack" },
      h("p", { class: "small" }, "Your new key. Copy it now: it won't be shown again."),
      h("div", { class: "keybox" }, newKey),
      h("p", { class: "muted small" }, "Send it as Authorization: Bearer <key>.")));
    newKey = null; // shown once
  }
  const create = h("button", { type: "button", class: "btn btn--primary btn--small", onclick: async () => {
    if (!label.value.trim()) { toast("Give the key a name first", true); return; }
    try {
      newKey = (await api("/auth/keys", { method: "POST", body: { label: label.value } })).key;
      await mePage();
    } catch (err) { toast(err.message, true); }
  } }, "Create key");
  const rows = keys.map((k) => {
    const revoke = h("button", { type: "button", class: "btn btn--small btn--danger", onclick: () => act(revoke,
      () => api(`/auth/keys/${k.id}`, { method: "DELETE" }), "Key revoked") }, "Revoke");
    return [k.label, h("span", { class: "mono small" }, when(k.created_at)), h("span", { class: "mono small" }, when(k.last_used_at)), revoke];
  });
  show(heading("My account", { kicker: me.role, lead: me.email }),
    h("div", { class: "grid-side" },
      h("section", { class: "panel stack" }, h("h2", {}, "API keys"),
        h("p", { class: "muted small" }, "For scripts: a key acts as you, with your role, until you revoke it."),
        h("div", { class: "row" }, label, create), made,
        table(["Name", "Created", "Last used", ""], rows, "No keys.")),
      passwordForm));
}

// --- first-run setup (0.4.1) -------------------------------------------------------------
// Shown before anything else while Lumida's memory or its first admin is missing. Every
// step sends the one-time setup code printed where Lumida was started.

let setupDone = false;
let setupCode = "";

async function setupStatus() {
  try {
    const response = await fetch("/api/setup/status", { credentials: "same-origin" });
    return response.ok ? await response.json() : { ready: true };
  } catch {
    return { ready: false, starting: true }; // Lumida is restarting after setup
  }
}

async function setupCall(path, body) {
  const response = await fetch(`/api/setup${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Lumida-Setup-Code": setupCode },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail
      : Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join("; ") : response.statusText;
    throw new ApiError(response.status, detail);
  }
  return data;
}

function setupShell(step, ...content) {
  frame();
  const steps = [["memory", "Lumida's memory"], ["admin", "Your admin account"], ["done", "Start"]];
  return show(h("div", { class: "setup" },
    h("div", { class: "brand brand--big" }, h("img", { src: "mark.svg", alt: "", width: 34, height: 34 }), "lumida"),
    h("h1", {}, "Set up Lumida"),
    h("p", { class: "muted" }, "Everything stays on this machine. Nothing is sent to Lumida's makers."),
    h("ol", { class: "setup__steps" }, steps.map(([key, label]) =>
      h("li", { class: key === step ? "on" : "" }, label))),
    ...content));
}

function codeField() {
  const input = h("input", { id: "setup-code", value: setupCode, placeholder: "1234-5678", autocomplete: "off",
    oninput: (e) => { setupCode = e.target.value.trim(); } });
  return field("setup-code", "Setup code", input, "Printed where Lumida was started (the terminal, or docker compose logs lumida).");
}

async function setupPage(status) {
  if (status.starting || (status.setup_mode && !status.needs_memory && !status.needs_admin)) {
    setupShell("done", h("div", { class: "panel stack" }, h("h2", {}, "Starting Lumida…"),
      h("p", { class: "muted" }, "This takes a few seconds. The page continues by itself.")));
    setTimeout(route, 1500);
    return;
  }
  if (status.needs_memory) return memoryStep(status);
  return adminStep();
}

function memoryStep(status) {
  const error = h("p", { class: "bad small", role: "alert" });
  const result = h("p", { class: "small" });
  const host = h("input", { id: "pg-host", value: "localhost" });
  const port = h("input", { id: "pg-port", value: "5432", inputmode: "numeric" });
  const database = h("input", { id: "pg-db", value: "lumida" });
  const user = h("input", { id: "pg-user", value: "postgres" });
  const password = h("input", { id: "pg-password", type: "password", autocomplete: "off" });
  const existing = () => ({ host: host.value.trim(), port: Number(port.value), database: database.value.trim(),
    user: user.value.trim(), password: password.value });
  const fields = h("div", { class: "setup__fields", hidden: true },
    h("div", { class: "row2" }, field("pg-host", "Host", host), field("pg-port", "Port", port)),
    h("div", { class: "row2" }, field("pg-db", "Database (created if missing)", database), field("pg-user", "User", user)),
    field("pg-password", "Password", password));

  const option = (value, title, hint, disabled = false) => h("label", { class: `choice${disabled ? " choice--off" : ""}` },
    h("input", { type: "radio", name: "memory", value, disabled, onchange: () => { fields.hidden = value !== "existing"; result.textContent = ""; } }),
    h("span", {}, h("strong", {}, title), h("span", { class: "muted small" }, hint)));
  const dockerHint = status.docker ? "Recommended. Lumida starts a private Postgres in Docker (about 20 seconds)."
    : "Needs Docker, which isn't running on this machine. Start Docker Desktop and reload, or use a Postgres you have.";
  const choices = h("div", { class: "stack" },
    option("docker", "Start one for me", dockerHint, !status.docker),
    option("existing", "Use a Postgres I already have", "Any Postgres you can reach, e.g. a spare database on an existing server."),
    option("none", "Without a separate database", "Coming in a later version.", true));
  const chosen = () => (choices.querySelector("input[name=memory]:checked") || {}).value;

  const test = h("button", { class: "btn", type: "button", onclick: async () => {
    error.textContent = ""; result.textContent = "Testing…"; test.disabled = true;
    try {
      const found = await setupCall("/memory/test", existing());
      result.className = `small ${found.ok ? "good" : "bad"}`;
      result.textContent = found.message;
    } catch (err) { result.textContent = ""; error.textContent = err.message; }
    finally { test.disabled = false; }
  } }, "Test connection");
  fields.append(h("div", { class: "row" }, test), result);

  const go = h("button", { class: "btn btn--primary", type: "submit" }, "Continue");
  const form = h("form", { class: "panel stack", onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = "";
    const mode = chosen();
    if (!mode) { error.textContent = "Choose where Lumida keeps what it learns."; return; }
    go.disabled = true;
    go.textContent = mode === "docker" ? "Starting Postgres… (about 20 s)" : "Preparing…";
    try {
      const next = await setupCall("/memory", mode === "docker" ? { mode } : { mode, existing: existing() });
      setupPage(next);
    } catch (err) {
      error.textContent = err.message;
      go.disabled = false; go.textContent = "Continue";
    }
  } },
    codeField(),
    h("h2", {}, "Where should Lumida keep what it learns?"),
    h("p", { class: "muted small" }, "Lumida remembers each table's measurements over time, the problems it found and your decisions. It needs a small Postgres of its own; it never writes to the databases it watches."),
    choices, fields, error, h("div", {}, go));
  setupShell("memory", form);
}

function adminStep() {
  const error = h("p", { class: "bad small", role: "alert" });
  const name = h("input", { id: "admin-name", autocomplete: "name" });
  const email = h("input", { id: "admin-email", type: "email", required: true, autocomplete: "username" });
  const password = h("input", { id: "admin-password", type: "password", minlength: 12, required: true, autocomplete: "new-password" });
  const again = h("input", { id: "admin-again", type: "password", minlength: 12, required: true, autocomplete: "new-password" });
  const go = h("button", { class: "btn btn--primary", type: "submit" }, "Create admin");
  const form = h("form", { class: "panel stack", onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = "";
    if (password.value !== again.value) { error.textContent = "The two passwords differ."; return; }
    go.disabled = true;
    try {
      const next = await setupCall("/admin", { name: name.value, email: email.value, password: password.value });
      toast("Admin created. Log in with it.");
      setupCode = "";
      if (next.ready) { setupDone = true; location.hash = "#/login"; return route(); }
      setupPage({ ...next, starting: true });
    } catch (err) {
      error.textContent = err.message;
      go.disabled = false;
    }
  } },
    codeField(),
    h("h2", {}, "Your admin account"),
    h("p", { class: "muted small" }, "The first person who can log in. Admins add colleagues later under People."),
    field("admin-name", "Name", name), field("admin-email", "Email", email),
    field("admin-password", "Password (12+ characters)", password), field("admin-again", "Password again", again),
    error, h("div", {}, go));
  setupShell("admin", form);
}

// --- routing ---------------------------------------------------------------------------

async function route() {
  const [path, search = ""] = location.hash.replace(/^#/, "").split("?");
  const query = new URLSearchParams(search);
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  document.getElementById("side").classList.remove("side--open");
  if (!setupDone) {
    const status = await setupStatus();
    if (!status.ready) return setupPage(status);
    setupDone = true;
  }
  if (parts[0] === "login") return loginPage();
  if (!me) {
    try {
      me = await api("/auth/me");
    } catch {
      return; // api() has sent us to the login page
    }
  }
  if (!about) about = await api("/about").catch(() => ({ ai_enabled: false }));
  try {
    if (parts.length === 0) return await overviewPage();
    if (parts[0] === "databases") return await databasesPage(parts[1] === "add" && can("admin"));
    if (parts[0] === "add" && can("admin")) return await databasesPage(true);
    if (parts[0] === "problems") return await problemsPage(query);
    if (parts[0] === "s" && parts[1]) return await sourcePage(parts[1], parts[2] || "", query);
    if (parts[0] === "f" && parts[1]) return await findingPage(parts[1]);
    if (parts[0] === "people" && can("admin")) return await peoplePage();
    if (parts[0] === "audit" && can("admin")) return await auditPage(query);
    if (parts[0] === "me") return await mePage();
    frame("", [["Not found"]]);
    show(h("div", { class: "panel empty" }, "Page not found. ", h("a", { href: "#/" }, "Back to the overview")));
  } catch (err) {
    if (err.status === 401) return;
    show(heading("Something went wrong"), h("div", { class: "panel" }, h("p", {}, err.message),
      h("a", { href: "#/" }, "Back to the overview")));
  }
}

window.addEventListener("hashchange", route);
route();
