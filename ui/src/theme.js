// Which light the page is read in.
//
// A standing preference, like the colours and the sidebar's width, so it lives
// in localStorage and never in the link: a view is something you share, and
// the person you share it with reads it in their own light.
//
// Three values, not two. "System" is the default and the only one that can
// change under the page, so it is a *choice* that resolves to a *theme* —
// everything that draws asks for the resolved one.
//
// The stylesheet is the other half of this: its tokens are `light-dark()`
// pairs under `color-scheme`, so before this module has run the browser has
// already painted the page in the operating system's light. That is why there
// is no inline script in `index.html` and no flash of the wrong colours.

const STORAGE_KEY = "portray.theme.v1";

/** @typedef {"light"|"dark"} Theme */
/** @typedef {"light"|"dark"|"system"} ThemeChoice */

/** In the order they are offered, which is dark and light around the default. */
export const THEME_CHOICES = /** @type {const} */ (["light", "dark", "system"]);

/** @param {unknown} value @returns {value is ThemeChoice} */
function isChoice(value) {
  return value === "light" || value === "dark" || value === "system";
}

/** @returns {ThemeChoice} */
export function loadTheme() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return isChoice(saved) ? saved : "system";
  } catch {
    // Storage is off; the operating system is the only preference there is.
    return "system";
  }
}

/** @param {ThemeChoice} choice */
export function saveTheme(choice) {
  try {
    if (choice === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private browsing, a full quota — the choice just will not persist.
  }
}

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** @param {ThemeChoice} choice @returns {Theme} */
export function resolveTheme(choice) {
  if (choice === "light" || choice === "dark") return choice;
  return systemPrefersDark() ? "dark" : "light";
}

/**
 * Names the theme on the root element, which is what the stylesheet's
 * `color-scheme` — and through it every `light-dark()` token, every native
 * control and every scrollbar — is switched by. "System" names nothing, so
 * the media query stays in charge and the page keeps following the machine.
 *
 * @param {ThemeChoice} choice
 */
export function applyTheme(choice) {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

/**
 * Calls back when the operating system's light changes. Only meaningful while
 * the choice is "system"; the caller checks, because it is the one that knows.
 *
 * @param {() => void} onChange
 */
export function onSystemThemeChange(onChange) {
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", onChange);
}

/**
 * A colour the stylesheet owns, read back so the parts of the page that are
 * not styled by CSS — the outline on a selected node, the sheet a PNG is
 * exported onto — can be drawn in it without a second copy of the palette
 * going stale beside the first.
 *
 * Read through a real `color` on a real element rather than off the custom
 * property, because an unregistered custom property computes to the tokens it
 * was written as: asking the root for `--accent` hands back the whole
 * `light-dark(...)` call, and only a property that actually takes a colour
 * makes the browser choose between the two. Comes back as `rgb(...)`, which
 * is what both callers want anyway.
 *
 * @param {string} name a custom property, `--` included
 * @param {string} fallback
 */
export function cssColor(name, fallback) {
  const probe = document.createElement("span");
  probe.style.cssText = `color: var(${name}); position: absolute; visibility: hidden`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  // A browser that did not resolve it hands back something that is not a
  // colour at all, and both callers would take it silently — a canvas keeps
  // the fill it had and an SVG drops the stroke. The fallback is a colour.
  return /^(rgb|#|color\()/.test(value) ? value : fallback;
}
