// A dropdown drawn like the header's role menu (a button and a floating list with a check on the
// chosen item) on top of a native <select>. The select stays in the DOM, hidden, and remains the
// source of truth: callers keep filling its options, reading and writing .value / .selectedIndex,
// toggling .disabled and listening to its "change" event. The button and the list repaint from
// the select whenever any of these change, including option text the language switch rewrites.
import { h } from "./dom.js";
import { icon } from "./icons.js";

let uid = 0;

/**
 * dropdown(select, { variant?, lead? }) -> the wrapper element, which holds the select.
 * variant: "pill" (header, sized to its text, like the role switch) or "field" (form control,
 * full width). lead: an icon name shown in a round badge before the value, like the role avatar.
 * An option with data-short="…" shows that shorter text on the button below 700 px.
 */
export function dropdown(select, { variant = "field", lead = null } = {}) {
  const id = `cqa-dd-${++uid}`;
  const test = select.getAttribute("data-test");
  const label = h("span", { attrs: { id: `${id}-label` }, verbatim: true });
  label.hidden = true;
  const value = h("span", { class: "cqa-dd-value", attrs: { id: `${id}-value` }, verbatim: true });
  const short = h("span", { class: "cqa-dd-short", attrs: { "aria-hidden": "true" }, verbatim: true });
  const button = h(
    "button",
    {
      class: "cqa-dd-btn",
      attrs: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": `${id}-list`, "aria-labelledby": `${id}-label ${id}-value` },
      data: { test: test && `${test}-button` },
    },
    lead ? h("span", { class: "cqa-dd-lead" }, icon(lead, { size: 14 })) : null,
    value,
    short,
    icon("chevron", { size: 14 }),
  );
  const list = h("div", { class: ["cqa-menu", "cqa-dd-list"], attrs: { id: `${id}-list`, role: "listbox", "aria-labelledby": `${id}-label` }, data: { test: test && `${test}-list` }, verbatim: true });
  list.hidden = true;
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  const el = h("div", { class: ["cqa-dd", `cqa-dd--${variant}`, lead && "cqa-dd--lead"] }, label, button, list, select);

  let items = [];
  const optionsKey = () => [...select.options].map((o) => `${o.value}\u0000${o.textContent}\u0000${o.disabled}`).join("\u0001");
  let drawnKey = null;

  function drawItems() {
    drawnKey = optionsKey();
    items = [...select.options].map((option, index) => {
      const text = h("span", { class: "cqa-dd-text" });
      text.textContent = option.textContent;
      const item = h(
        "button",
        { class: "cqa-menu-item", attrs: { type: "button", role: "option", tabindex: "-1", "aria-selected": "false" }, on: { click: () => choose(index) } },
        text,
        icon("check", { size: 14 }),
      );
      item.disabled = option.disabled;
      return item;
    });
    list.replaceChildren(...items);
  }

  function paint() {
    if (optionsKey() !== drawnKey) drawItems();
    label.textContent = select.getAttribute("aria-label") ?? "";
    const at = select.selectedIndex;
    value.textContent = at >= 0 ? select.options[at].textContent : "";
    const brief = at >= 0 ? select.options[at].getAttribute("data-short") : null;
    short.textContent = brief ?? "";
    el.classList.toggle("cqa-dd--short", brief !== null);
    items.forEach((item, i) => item.setAttribute("aria-selected", String(i === at)));
    button.disabled = select.disabled;
    if (select.disabled) close();
  }

  function choose(index) {
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    close();
    button.focus();
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const onOutside = (event) => {
    if (!el.contains(event.target)) close();
  };
  function open() {
    if (select.disabled || items.length === 0) return;
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside);
    const chosen = items[select.selectedIndex];
    (chosen && !chosen.disabled ? chosen : items.find((item) => !item.disabled))?.focus();
  }
  function close() {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside);
  }

  button.addEventListener("click", () => (list.hidden ? open() : close()));
  button.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && list.hidden) {
      event.preventDefault();
      open();
    }
  });
  list.addEventListener("keydown", (event) => {
    const enabled = items.filter((item) => !item.disabled);
    const at = enabled.indexOf(document.activeElement);
    const go = (i) => enabled[(i + enabled.length) % enabled.length]?.focus();
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(-1);
    else return;
    event.preventDefault();
  });
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || list.hidden) return;
    event.stopPropagation(); // this Escape closes the list, not the drawer or dialog behind it
    close();
    button.focus();
  });
  // Safari does not focus a clicked button; without this the focus would leave for the body,
  // the focusout below would close the list, and the click would land on a hidden item.
  list.addEventListener("mousedown", (event) => event.preventDefault());
  el.addEventListener("focusout", (event) => {
    if (!el.contains(event.relatedTarget)) close();
  });

  // Writes to .value and .selectedIndex fire no event; repaint on them too.
  for (const name of ["value", "selectedIndex"]) {
    const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, name);
    Object.defineProperty(select, name, {
      configurable: true,
      get: () => native.get.call(select),
      set: (next) => {
        native.set.call(select, next);
        paint();
      },
    });
  }
  select.addEventListener("change", paint);
  new MutationObserver(paint).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "aria-label"] });
  paint();
  return el;
}
