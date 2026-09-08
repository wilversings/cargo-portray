// Small helpers so the panels read like markup instead of like DOM calls.

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      element.className = String(value);
    } else if (key === "checked" || key === "disabled" || key === "selected") {
      element[key] = Boolean(value);
    } else if (key === "value") {
      element.value = String(value);
    } else {
      element.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

/**
 * Panels folded shut, by title.
 *
 * Which panels are open is display-only — it says nothing about what is drawn,
 * so it stays out of the URL and out of the filter state, and lives here
 * instead so that a rebuilt sidebar comes back the way it was left.
 *
 * Appearance starts folded: it is a standing preference, set once, and the
 * longest panel of the lot.
 */
const folded = new Set(["Appearance"]);

/**
 * A panel, collapsed by clicking its heading.
 *
 * The children are always built. Building them only when open would mean the
 * `toggle` event has to trigger a re-render before there is anything to see,
 * and `<details>` already hides what it holds — cheaper to hand it the rows.
 *
 * @param {string} title
 * @param {...(Node|string|null|undefined|false)} children
 */
export function section(title, ...children) {
  // A title carrying a count — `Hidden (3)` — names the same panel however
  // many things are in it.
  const key = title.replace(/\s*\(.*\)$/, "");
  const details = h("details", { class: "panel", open: !folded.has(key) });
  const real = children.filter((child) => child !== null && child !== undefined && child !== false);
  details.append(h("summary", {}, h("span", { class: "panel-title" }, title)), ...real);
  details.addEventListener("toggle", () => {
    if (details.open) folded.delete(key);
    else folded.add(key);
  });
  return details;
}

/**
 * @param {string} label
 * @param {boolean} checked
 * @param {(checked: boolean) => void} onChange
 * @param {string} [swatch]
 */
export function checkbox(label, checked, onChange, swatch) {
  const input = h("input", {
    type: "checkbox",
    checked,
    onchange: (event) => onChange(event.target.checked),
  });
  return h(
    "label",
    { class: "check" },
    input,
    swatch ? h("span", { class: "swatch", style: `background:${swatch}` }) : null,
    h("span", {}, label),
  );
}

/**
 * The label may be an icon instead of a word, in which case there is nothing
 * on the button for a screen reader to read: the `title` becomes the name as
 * well as the tooltip, and the `icon` class squares the box off, the way
 * `toggle` does for the switches.
 *
 * @param {string|Node} label
 * @param {() => void} onClick
 * @param {string} [title]
 */
export function button(label, onClick, title) {
  const drawn = typeof label !== "string";
  const name = title ?? (drawn ? "" : label);
  return h(
    "button",
    {
      type: "button",
      class: drawn ? "icon" : null,
      "aria-label": drawn ? name : null,
      onclick: onClick,
      title: name,
    },
    label,
  );
}

/**
 * A button that is either on or off, and says which — `aria-pressed` is what a
 * screen reader reads it by, and what the stylesheet colours it by.
 *
 * The label may be an icon, in which case there is nothing on the button for a
 * screen reader to read: the `title` becomes the name as well as the tooltip,
 * so a switch that shows only a padlock still announces what it does.
 *
 * @param {string|Node} label
 * @param {boolean} pressed
 * @param {() => void} onClick
 * @param {string} [title]
 */
export function toggle(label, pressed, onClick, title) {
  const name = title ?? (typeof label === "string" ? label : "");
  return h(
    "button",
    {
      type: "button",
      "aria-pressed": String(pressed),
      "aria-label": typeof label === "string" ? null : name,
      onclick: onClick,
      title: name,
    },
    label,
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An icon, as strokes on a 24-unit grid.
 *
 * Drawn here rather than fetched: an icon set is a dependency, and two
 * switches' worth of outline is a dozen path commands. Everything about how it
 * looks — the size, the weight, the colour it inherits — is in the stylesheet;
 * these are only the shapes. `createElementNS`, because an `<svg>` built with
 * `createElement` is an unknown HTML element that draws nothing.
 *
 * @param {...string} paths
 */
export function icon(...paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  // The button carries the name; the drawing inside it is not a second thing
  // to read out.
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * @param {string} value
 * @param {string[]} options
 * @param {(value: string) => void} onChange
 */
export function select(value, options, onChange) {
  return h(
    "select",
    { onchange: (event) => onChange(event.target.value) },
    ...options.map((option) => h("option", { value: option, selected: option === value }, option)),
  );
}

/**
 * @param {string} value
 * @param {(value: string) => void} onChange
 */
export function colorInput(value, onChange) {
  return h("input", {
    type: "color",
    class: "color",
    value,
    oninput: (event) => onChange(event.target.value),
  });
}
