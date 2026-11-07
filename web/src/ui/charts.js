import { h, svg } from "./dom.js";
// Hand-drawn SVG/HTML charts for the report tabs. No library: static, strict-CSP safe (geometry is
// attributes, motion is CSS keyed on `.is-in`, which the page sets after the charts are attached).
// Every chart is decoration over a table that stays on the page, so charts hide from assistive tech.

const TAU = Math.PI * 2;
const pct = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 10;
const f1 = (n) => Math.round(n * 100) / 100;
const reduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A white card with a title and an optional one-line note. */
export function chartCard(title, note, ...children) {
  return h("section", { class: "cqa-chart" },
    h("h3", { class: "cqa-chart-title", text: title }),
    note ? h("p", { class: "cqa-chart-note", text: note }) : null, ...children);
}

/** Number that counts up to `to` once; reduced motion (or a missing rAF) shows the end at once. */
export function countUp(el, to, format) {
  el.textContent = format(to);
  if (reduced() || !globalThis.requestAnimationFrame) return;
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 900);
    el.textContent = format(to * (1 - (1 - k) ** 3));
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
    else el.textContent = format(to);
  };
  requestAnimationFrame(step);
}

/** Arc over a track, `value` 0..1. */
export function ring(value, label) {
  return h("div", { class: "cqa-ring", data: { tip: label }, style: { "--v": pct(value) } },
    svg("svg", { viewBox: "0 0 120 120", "aria-hidden": "true", focusable: "false" },
      svg("circle", { class: "cqa-ring-track", cx: 60, cy: 60, r: 50, pathLength: 100 }),
      svg("circle", { class: "cqa-ring-arc", cx: 60, cy: 60, r: 50, pathLength: 100, transform: "rotate(-90 60 60)" })));
}

/**
 * Horizontal bars on faint tracks. rows: [{label, value 0..1|null, text, tip, hot, verbatim}].
 * `ref` (0..1) draws a dashed reference line across every track.
 */
export function hbars(rows, { ref = null } = {}) {
  return h("div", { class: "cqa-hb", attrs: { "aria-hidden": "true" } }, rows.map((r, i) => {
    const track = h("span", { class: "cqa-hb-track" },
      typeof r.value === "number" ? h("span", { class: "cqa-hb-fill", style: { "--w": pct(r.value) } }) : null,
      typeof ref === "number" ? h("span", { class: "cqa-hb-ref", style: { left: `${pct(ref)}%` } }) : null);
    return h("div", { class: ["cqa-hb-row", r.hot && "is-hot"], data: { tip: r.tip }, style: { "--i": i } },
      h("span", { class: "cqa-hb-label", text: r.label, verbatim: r.verbatim }), track,
      h("span", { class: "cqa-hb-val", text: r.text }));
  }));
}

/** Radar of `rows` [{label, value 0..1, tip}] with four hairline rings. Needs three or more rows. */
export function radar(rows) {
  const n = rows.length, c = 110, R = 78;
  const at = (k, v) => [c + Math.sin((TAU * k) / n) * R * v, c - Math.cos((TAU * k) / n) * R * v];
  const poly = (v) => rows.map((_, k) => at(k, v(k)).map(f1).join(",")).join(" ");
  return h("div", { class: "cqa-radar", attrs: { "aria-hidden": "true" } }, svg("svg", { viewBox: "0 0 220 220", focusable: "false" },
    [0.25, 0.5, 0.75, 1].map((v) => svg("polygon", { class: "cqa-radar-ring", points: poly(() => v) })),
    rows.map((_, k) => svg("line", { class: "cqa-radar-axis", x1: c, y1: c, x2: at(k, 1)[0], y2: at(k, 1)[1] })),
    svg("g", { class: "cqa-radar-data" },
      svg("polygon", { class: "cqa-radar-area", points: poly((k) => rows[k].value) }),
      rows.map((r, k) => { const [x, y] = at(k, r.value); return svg("circle", { class: "cqa-radar-dot", cx: f1(x), cy: f1(y), r: 4 }); }),
      rows.map((r, k) => { const [x, y] = at(k, 1); return svg("circle", { class: "cqa-radar-hit", cx: f1(x), cy: f1(y), r: 16, "data-tip": r.tip }); })),
    rows.map((r, k) => { const [x, y] = at(k, 1.17); return svg("text", { class: "cqa-radar-label", x: f1(x), y: f1(y), "text-anchor": "middle", "dominant-baseline": "middle", "data-i18n-verbatim": "" }, r.label); })));
}

/** Donut of `slices` [{value, tip, tone 0..4}] with `center` text and `caption` under it. */
export function donut(slices, center, caption) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  let from = 0;
  const arcs = total ? slices.map((s) => {
    const len = (s.value / total) * 100, el = svg("circle", { class: `cqa-donut-arc tone-${s.tone}`, cx: 60, cy: 60, r: 44, pathLength: 100,
      "stroke-dasharray": `${f1(Math.max(0, len - (slices.length > 1 ? 1.2 : 0)))} ${f1(100 - len + (slices.length > 1 ? 1.2 : 0))}`, "stroke-dashoffset": f1(-from), "data-tip": s.tip });
    from += len;
    return el;
  }) : [];
  return h("div", { class: "cqa-donut" }, svg("svg", { viewBox: "0 0 120 120", "aria-hidden": "true", focusable: "false" },
    svg("circle", { class: "cqa-donut-track", cx: 60, cy: 60, r: 44, pathLength: 100 }),
    svg("g", { class: "cqa-donut-arcs", transform: "rotate(-90 60 60)" }, arcs)),
  h("div", { class: "cqa-donut-center" }, h("span", { class: "cqa-donut-num", text: center }), caption ? h("span", { class: "cqa-donut-cap", text: caption }) : null));
}

/** One stacked bar: parts [{value, tip, tone 0..2}]. */
export function stack(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return h("div", { class: "cqa-stack", attrs: { "aria-hidden": "true" } }, parts.filter((p) => p.value > 0).map((p, i) =>
    h("span", { class: `cqa-stack-part tone-${p.tone}`, data: { tip: p.tip }, style: { "--w": pct(p.value / total), "--i": i } })));
}

/** Legend of coloured dots: items [{tone, text}] using the same tone-N colours as donut and stack. */
export const legend = (items) => h("ul", { class: "cqa-legend" }, items.map((x) =>
  h("li", {}, h("span", { class: `cqa-dot tone-${x.tone}` }), h("span", { text: x.text, verbatim: x.verbatim }))));

/** Count matrix: rows and columns [{key,label}], counts Map "row|col" -> n, tip(row, col, n). */
export function matrix(rows, cols, counts, tip) {
  const max = Math.max(1, ...counts.values());
  return h("div", { class: "cqa-table-scroll", attrs: { "aria-hidden": "true" } }, h("table", { class: "cqa-matrix" },
    h("thead", {}, h("tr", {}, h("th"), cols.map((c) => h("th", { attrs: { scope: "col" }, text: c.label })))),
    h("tbody", {}, rows.map((r) => h("tr", {}, h("th", { attrs: { scope: "row" }, text: r.label }), cols.map((c) => {
      const n = counts.get(`${r.key}|${c.key}`) ?? 0;
      return h("td", { class: ["cqa-matrix-cell", n ? `lvl-${Math.ceil((4 * n) / max)}` : "is-zero"], data: n ? { tip: tip(r, c, n) } : {}, text: n ? String(n) : "·" });
    }))))));
}

/** Shows `data-tip` (HTML or SVG element) in one floating label while the pointer is over it. */
export function tooltips(root) {
  const tip = h("div", { class: "cqa-tip", attrs: { role: "presentation" } });
  tip.hidden = true;
  root.append(tip);
  root.addEventListener("pointermove", (e) => {
    const text = e.target.closest?.("[data-tip]")?.getAttribute("data-tip");
    tip.hidden = !text;
    if (!text) return;
    tip.textContent = text;
    const box = root.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, e.clientX - box.left), box.width - 8)}px`;
    tip.style.top = `${e.clientY - box.top - 14}px`;
  });
  root.addEventListener("pointerleave", () => { tip.hidden = true; });
  return tip;
}
