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
 * @param {string} title
 * @param {...(Node|string|null|undefined|false)} children
 */
export function section(title, ...children) {
  return h("section", { class: "panel" }, h("h2", {}, title), ...children);
}

/**
 * A collapsible section, for the panels that are long but rarely touched.
 *
 * The children are always built. Building them only when open would mean the
 * `toggle` event has to trigger a re-render before there is anything to see,
 * and `<details>` already hides what it holds — cheaper to hand it the rows.
 *
 * @param {string} title
 * @param {boolean} open
 * @param {(open: boolean) => void} onToggle
 * @param {...(Node|string|null|undefined|false)} children
 */
export function foldout(title, open, onToggle, ...children) {
  const details = h("details", { class: "panel", open });
  const real = children.filter((child) => child !== null && child !== undefined && child !== false);
  details.append(h("summary", {}, title), ...real);
  details.addEventListener("toggle", () => onToggle(details.open));
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
 * @param {string} label
 * @param {() => void} onClick
 * @param {string} [title]
 */
export function button(label, onClick, title) {
  return h("button", { type: "button", onclick: onClick, title: title ?? label }, label);
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
