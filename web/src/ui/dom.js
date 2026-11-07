// DOM building for the whole UI. Text goes in through textContent or text nodes only, never as
// HTML, and styles only through el.style, so everything built here survives a strict CSP.

const SVG_NS = "http://www.w3.org/2000/svg";
const PROPS = new Set(["class", "text", "attrs", "data", "on", "style"]);

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.append(child); // a string or number becomes a Text node, a Node is moved in
  }
}

function setAttrs(el, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    // Inline styles and handlers are what a strict CSP forbids; use props.style and props.on.
    if (name === "style" || /^on/i.test(name)) throw new TypeError(`dom: attribute "${name}" is not allowed`);
    el.setAttribute(name, value === true ? "" : String(value));
  }
}

const kebab = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * h(tag, props?, ...children)
 * props: class (string | array, falsy items dropped), text, attrs {name: value}, data {name: value}
 * (becomes data-name), on {event: handler}, style {property: value} ("--x" sets a custom property).
 * children: strings, numbers, nodes, arrays of them; null, undefined and booleans are skipped.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props !== undefined && props !== null) {
    if (typeof props !== "object" || props instanceof Node || Array.isArray(props)) {
      throw new TypeError("dom: h() props must be a plain object; pass children after it");
    }
    for (const key of Object.keys(props)) {
      if (!PROPS.has(key)) throw new TypeError(`dom: unknown prop "${key}"`);
    }
    const { class: className, text, attrs, data, on, style } = props;
    if (className) el.className = Array.isArray(className) ? className.filter(Boolean).join(" ") : String(className);
    if (text !== undefined && text !== null) el.textContent = String(text);
    if (attrs) setAttrs(el, attrs);
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && value !== undefined && value !== false) el.setAttribute(`data-${kebab(key)}`, String(value));
      }
    }
    if (on) {
      for (const [event, handler] of Object.entries(on)) el.addEventListener(event, handler);
    }
    if (style) {
      for (const [property, value] of Object.entries(style)) {
        if (property.startsWith("--")) el.style.setProperty(property, String(value));
        else el.style[property] = value;
      }
    }
  }
  append(el, children);
  return el;
}

// svg(tag, attrs, ...children): an SVG element in the SVG namespace; `attrs` as in h().attrs.
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) setAttrs(el, attrs);
  append(el, children);
  return el;
}

// Empties an element.
export function clear(el) {
  el.replaceChildren();
  return el;
}
