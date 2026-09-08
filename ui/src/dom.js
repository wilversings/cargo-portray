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

/** @typedef {{ label: string, title: string, checked?: boolean, run: () => void }} MenuItem */

/**
 * How every open menu shuts itself.
 *
 * There is more than one menu in the toolbar, and what has to be remembered
 * outside any of them is only how to close them: a menu left open behind a
 * hidden sidebar, or still holding its outside-click listener after the row
 * was rebuilt, is a menu nobody can reach. Kept in one place so that Escape
 * and a rebuild reach whichever one is open without either having to know
 * which menus exist.
 */
const openMenus = new Set();

/** Shuts every open menu, and says whether there was one to shut. */
export function closeMenus() {
  const any = openMenus.size > 0;
  for (const close of [...openMenus]) close();
  return any;
}

/**
 * A button that drops a short list of choices under it.
 *
 * The button is a drawing, so it spends one square of the row on a set of
 * choices that would have cost a word each — and the choice is only asked for
 * once the reader has said they want to make one. An item that carries
 * `checked` is one of a set the menu is currently showing the state of, and
 * says so where a screen reader can hear it; one that does not is an errand
 * that happens and is over.
 *
 * The list shuts on the way out of every item, on a press anywhere else, and
 * on Escape.
 *
 * @param {Node} glyph
 * @param {string} name what the button is, for the tooltip and the screen reader
 * @param {string} title
 * @param {MenuItem[]} items
 */
export function menu(glyph, name, title, items) {
  const list = h(
    "div",
    { class: "menu-items", role: "menu" },
    ...items.map((item) =>
      h(
        "button",
        {
          type: "button",
          role: item.checked === undefined ? "menuitem" : "menuitemradio",
          "aria-checked": item.checked === undefined ? null : String(item.checked),
          title: item.title,
          onclick: () => {
            setOpen(false);
            item.run();
          },
        },
        item.label,
      ),
    ),
  );
  list.hidden = true;

  const opener = h(
    "button",
    {
      type: "button",
      class: "menu-open",
      "aria-haspopup": "true",
      "aria-expanded": "false",
      // Nothing on the button reads as a word, so the name has to be given.
      "aria-label": name,
      title,
      onclick: () => setOpen(list.hidden),
    },
    glyph,
  );

  const element = h("div", { class: "menu" }, opener, list);

  /** @param {PointerEvent} event */
  function onOutside(event) {
    if (!element.contains(/** @type {Node} */ (event.target))) setOpen(false);
  }

  /** @param {boolean} open */
  function setOpen(open) {
    list.hidden = !open;
    opener.setAttribute("aria-expanded", String(open));
    // Captured, so a press that lands on the diagram shuts the menu before the
    // pan it starts gets going.
    if (open) {
      closeMenus();
      openMenus.add(close);
      document.addEventListener("pointerdown", onOutside, true);
    } else {
      openMenus.delete(close);
      document.removeEventListener("pointerdown", onOutside, true);
    }
  }

  function close() {
    setOpen(false);
  }

  return element;
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
