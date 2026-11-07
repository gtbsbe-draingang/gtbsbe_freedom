// Inline SVG icons: 24x24 strokes in currentColor, so they follow the text colour and the theme.
import { svg } from "./dom.js";

const SHAPES = {
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4 }],
    ["path", { d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }],
  ],
  moon: [["path", { d: "M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" }]],
  user: [
    ["circle", { cx: 12, cy: 8, r: 4 }],
    ["path", { d: "M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" }],
  ],
  chevron: [["path", { d: "m6 9 6 6 6-6" }]],
  list: [["path", { d: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" }]],
  close: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
  check: [["path", { d: "m5 12.5 4.5 4.5L19 7.5" }]],
  alert: [
    ["path", { d: "M12 3.5 2.5 20h19L12 3.5Z" }],
    ["path", { d: "M12 10v4.5M12 17.5h.01" }],
  ],
  info: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["path", { d: "M12 11v5.5M12 7.5h.01" }],
  ],
};

export const iconNames = Object.keys(SHAPES);

// icon("sun", { size: 16 }) -> a decorative <svg> (aria-hidden); put a label on its button.
export function icon(name, { size = 16 } = {}) {
  const shapes = SHAPES[name];
  if (!shapes) throw new TypeError(`icons: unknown icon ${JSON.stringify(name)}`);
  return svg(
    "svg",
    {
      class: "cqa-icon",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    ...shapes.map(([tag, attrs]) => svg(tag, attrs)),
  );
}
