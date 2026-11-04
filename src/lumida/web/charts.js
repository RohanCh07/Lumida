// Small SVG charts for the web app: no library, nothing loaded from elsewhere (the page's
// security policy allows only Lumida's own files). Every chart takes plain numbers that came
// from the API and is drawn with createElementNS, so no value is ever parsed as markup.
// Hover hints use <title> elements, which browsers show as tooltips.

const NS = "http://www.w3.org/2000/svg";

export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const tip = (text) => s("title", {}, text);
const day = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const compact = (n) => (n === null || n === undefined ? "—"
  : Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n));

// Severity and score colours, the same tokens as app.css.
export const SEV_COLOR = { critical: "#f87171", high: "#fb923c", medium: "#facc15", low: "#60a5fa", info: "#71717a" };
export const SEVERITIES = ["critical", "high", "medium", "low", "info"];
export const SERIES = ["#f5d0a9", "#ffffff", "#fb923c", "#f87171", "#60a5fa", "#a78bfa", "#4ade80", "#a1a1aa"];
export const scoreColor = (score) => (score >= 85 ? "#4ade80" : score >= 60 ? "#f5d0a9" : "#f87171");

function frame(width, height, label) {
  return s("svg", { viewBox: `0 0 ${width} ${height}`, class: "chart", role: "img", "aria-label": label,
    preserveAspectRatio: "xMidYMid meet" });
}

function empty(width, height, text) {
  return s("svg", { viewBox: `0 0 ${width} ${height}`, class: "chart" },
    s("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "chart__empty" }, text));
}

// Lines over time. series: [{name, color, points: [{at: Date, y}]}]
export function lineChart(series, { width = 640, height = 220, yMin = 0, yMax = 100, area = false,
  label = "line chart", emptyText = "Not enough runs yet" } = {}) {
  const all = series.flatMap((x) => x.points);
  if (!all.length) return empty(width, height, emptyText);
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const t0 = Math.min(...all.map((p) => +p.at));
  const t1 = Math.max(...all.map((p) => +p.at));
  const span = Math.max(t1 - t0, 1);
  const x = (at) => pad.l + ((+at - t0) / span) * (width - pad.l - pad.r) || pad.l;
  const y = (v) => pad.t + (1 - (v - yMin) / Math.max(yMax - yMin, 1e-9)) * (height - pad.t - pad.b);
  const svg = frame(width, height, label);
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    svg.append(s("line", { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), class: "chart__grid" }),
      s("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end", class: "chart__axis" }, compact(v)));
  }
  const ticks = t1 === t0 ? [t0] : [t0, t0 + span / 2, t1];
  ticks.forEach((t, i) => svg.append(s("text", { x: x(t), y: height - 6, class: "chart__axis",
    "text-anchor": ticks.length === 1 ? "middle" : ["start", "middle", "end"][i] }, day(new Date(t)))));
  for (const line of series) {
    const pts = line.points;
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
    if (area && pts.length > 1) {
      svg.append(s("path", { d: `${d}L${x(pts.at(-1).at)},${y(yMin)}L${x(pts[0].at)},${y(yMin)}Z`,
        fill: line.color, "fill-opacity": 0.08 }));
    }
    svg.append(s("path", { d, fill: "none", stroke: line.color, "stroke-width": 1.6, "stroke-linejoin": "round" }));
    for (const p of pts) {
      svg.append(s("circle", { cx: x(p.at), cy: y(p.y), r: pts.length > 40 ? 1.6 : 2.6, fill: line.color, class: "chart__dot" },
        tip(`${line.name} · ${day(p.at)} · ${Math.round(p.y * 10) / 10}`)));
    }
  }
  return svg;
}

// Stacked columns. bars: [{label, parts: {key: n}}]; keys in stacking order (bottom first).
export function stackedBars(bars, keys, colors, { width = 640, height = 200, label = "bar chart",
  emptyText = "No runs yet" } = {}) {
  if (!bars.length) return empty(width, height, emptyText);
  const pad = { l: 30, r: 8, t: 10, b: 22 };
  const totals = bars.map((b) => keys.reduce((a, k) => a + (b.parts[k] || 0), 0));
  const max = Math.max(1, ...totals);
  const slot = (width - pad.l - pad.r) / bars.length;
  const bw = Math.max(3, Math.min(28, slot * 0.62));
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  const svg = frame(width, height, label);
  for (const v of [0, max / 2, max]) {
    svg.append(s("line", { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), class: "chart__grid" }),
      s("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end", class: "chart__axis" }, Math.round(v)));
  }
  bars.forEach((bar, i) => {
    const cx = pad.l + slot * i + slot / 2;
    let base = 0;
    for (const k of keys) {
      const v = bar.parts[k] || 0;
      if (!v) continue;
      svg.append(s("rect", { x: cx - bw / 2, y: y(base + v), width: bw, height: Math.max(1, y(base) - y(base + v)),
        fill: colors[k], rx: 1.5 }, tip(`${bar.label} · ${k}: ${v}`)));
      base += v;
    }
    if (bars.length <= 16 || i % Math.ceil(bars.length / 8) === 0) {
      svg.append(s("text", { x: cx, y: height - 6, "text-anchor": "middle", class: "chart__axis" }, bar.short || bar.label));
    }
  });
  return svg;
}

// Stacked areas over time. points: [{at: Date, parts: {key: n}}]
export function stackedArea(points, keys, colors, { width = 900, height = 180, label = "area chart",
  emptyText = "Not enough runs yet" } = {}) {
  if (points.length < 2) return empty(width, height, emptyText);
  const pad = { l: 30, r: 10, t: 10, b: 24 };
  const t0 = +points[0].at;
  const span = Math.max(+points.at(-1).at - t0, 1);
  const max = Math.max(1, ...points.map((p) => keys.reduce((a, k) => a + (p.parts[k] || 0), 0)));
  const x = (at) => pad.l + ((+at - t0) / span) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  const svg = frame(width, height, label);
  for (const v of [0, max / 2, max]) {
    svg.append(s("line", { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), class: "chart__grid" }),
      s("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end", class: "chart__axis" }, Math.round(v)));
  }
  const below = points.map(() => 0);
  for (const k of keys) {
    const top = points.map((p, i) => below[i] + (p.parts[k] || 0));
    const up = points.map((p, i) => `${x(p.at).toFixed(1)},${y(top[i]).toFixed(1)}`);
    const down = points.map((p, i) => `${x(p.at).toFixed(1)},${y(below[i]).toFixed(1)}`).reverse();
    svg.append(s("polygon", { points: [...up, ...down].join(" "), fill: colors[k], "fill-opacity": 0.22,
      stroke: colors[k], "stroke-width": 1.2, "stroke-opacity": 0.8 }, tip(k)));
    top.forEach((v, i) => { below[i] = v; });
  }
  points.forEach((p, i) => {
    svg.append(s("circle", { cx: x(p.at), cy: y(below[i]), r: 2.4, class: "chart__dot", fill: "#f5d0a9" },
      tip(`${day(p.at)} · ${below[i]} open`)));
  });
  [points[0], points.at(-1)].forEach((p, i) => svg.append(s("text", { x: x(p.at), y: height - 6,
    "text-anchor": i ? "end" : "start", class: "chart__axis" }, day(p.at))));
  return svg;
}

// A tiny line. With `band`, a shaded envelope shows where each run was expected to land,
// from how much the value usually changes per run (so steady growth is normal), and the
// latest point turns orange when its change was unusual. The envelope is a picture, not
// a check: Lumida's own volume checks decide what becomes a problem.
export const BAND_SIGMAS = 3; // how many standard deviations of the usual change count as normal
export const BAND_MIN_SHARE = 0.01; // never narrower than 1% of the value

export function sparkline(values, { width = 220, height = 44, band = true } = {}) {
  if (!values.length) return { svg: empty(width, height, "no measurements yet"), out: false, change: null };
  const last = values.at(-1);
  const changes = values.slice(1).map((v, i) => v - values[i]);
  const earlier = changes.slice(0, -1);
  let envelope = null;
  let change = null;
  if (band && earlier.length >= 2) {
    change = earlier.reduce((a, b) => a + b, 0) / earlier.length;
    const sd = Math.sqrt(earlier.reduce((a, b) => a + (b - change) ** 2, 0) / earlier.length);
    envelope = values.slice(1).map((_, i) => {
      const expected = values[i] + change;
      const tol = Math.max(BAND_SIGMAS * sd, Math.abs(values[i]) * BAND_MIN_SHARE, 1);
      return [expected - tol, expected + tol];
    });
  }
  const all = [...values, ...(envelope || []).flat()];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || Math.max(1, Math.abs(max) * 0.05);
  const x = (i) => (values.length === 1 ? width / 2 : 3 + (i / (values.length - 1)) * (width - 6));
  const y = (v) => 4 + (1 - (v - min) / span) * (height - 8);
  const out = envelope !== null && (last < envelope.at(-1)[0] || last > envelope.at(-1)[1]);
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, class: "spark", "aria-hidden": "true" });
  if (envelope) {
    const up = envelope.map(([, hi], i) => `${x(i + 1).toFixed(1)},${y(hi).toFixed(1)}`);
    const down = envelope.map(([lo], i) => `${x(i + 1).toFixed(1)},${y(lo).toFixed(1)}`).reverse();
    svg.append(s("polygon", { points: [...up, ...down].join(" "), class: "spark__band" }));
  }
  svg.append(s("path", { d: values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(""),
    fill: "none", stroke: out ? "#fb923c" : "#f5d0a9", "stroke-width": 1.5 }));
  svg.append(s("circle", { cx: x(values.length - 1), cy: y(last), r: 2.8, fill: out ? "#fb923c" : "#f5d0a9" }));
  return { svg, out, change };
}

// A score ring, 0-100.
export function ring(score, { size = 64 } = {}) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const v = score === null || score === undefined ? 0 : Math.max(0, Math.min(100, score));
  return s("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: "ring", role: "img",
    "aria-label": score === null || score === undefined ? "no score yet" : `health ${Math.round(v)} of 100` },
  s("circle", { cx: size / 2, cy: size / 2, r, class: "ring__track" }),
  s("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: scoreColor(v), "stroke-width": 4,
    "stroke-linecap": "round", "stroke-dasharray": `${(c * v) / 100} ${c}`,
    transform: `rotate(-90 ${size / 2} ${size / 2})` }),
  s("text", { x: size / 2, y: size / 2 + 5, "text-anchor": "middle", class: "ring__text" },
    score === null || score === undefined ? "—" : Math.round(v)));
}

// The tables linked to one table: parents on the left, children on the right.
// links: [{from, to, label, kind}] where from/to are "schema.table".
export function linkMap(center, links, { width = 640 } = {}) {
  const parents = [...new Set(links.filter((l) => l.from === center).map((l) => l.to))];
  const children = [...new Set(links.filter((l) => l.to === center).map((l) => l.from))];
  if (!parents.length && !children.length) return null;
  const rows = Math.max(parents.length, children.length, 1);
  const height = Math.max(120, rows * 46 + 24);
  const bw = 170;
  const bh = 30;
  const svg = frame(width, height, `tables linked to ${center}`);
  const box = (x, yy, text, cls) => s("g", {},
    s("rect", { x, y: yy, width: bw, height: bh, rx: 6, class: `map__box ${cls}` }),
    s("text", { x: x + bw / 2, y: yy + bh / 2 + 4, "text-anchor": "middle", class: "map__text" },
      text.length > 24 ? `${text.slice(0, 23)}…` : text), tip(text));
  const cx = (width - bw) / 2;
  const cy = (height - bh) / 2;
  const place = (list) => list.map((name, i) => ({ name, y: ((i + 0.5) * height) / list.length - bh / 2 }));
  const edge = (x1, y1, x2, y2, kind) => s("path", { d: `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`,
    class: `map__edge${kind === "declared" ? "" : " map__edge--inferred"}` });
  for (const p of place(parents)) {
    const kind = links.find((l) => l.from === center && l.to === p.name)?.kind;
    svg.append(edge(10 + bw, p.y + bh / 2, cx, cy + bh / 2, kind), box(10, p.y, p.name, ""));
  }
  for (const c of place(children)) {
    const kind = links.find((l) => l.to === center && l.from === c.name)?.kind;
    svg.append(edge(cx + bw, cy + bh / 2, width - 10 - bw, c.y + bh / 2, kind), box(width - 10 - bw, c.y, c.name, ""));
  }
  svg.append(box(cx, cy, center, "map__box--center"));
  return svg;
}
