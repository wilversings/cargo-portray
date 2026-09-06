// The floating panel that shows an artifact's documentation.
//
// Two ways in, because the two readings are different: hovering a marker is
// "what is this?" and wants the text to appear and then get out of the way,
// while clicking it is "I am going to read this" and wants the text to stay
// put, hold still under the pointer, and scroll. So a hover shows it and a
// click pins it, and only a pinned panel can be selected, scrolled or
// scrolled past.

import { h } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

/** @type {HTMLElement|null} */
let panel = null;
let pinned = false;
/** @type {number|undefined} */
let showTimer;

function element() {
  if (!panel) {
    panel = h("div", { id: "doctip", class: "doctip" });
    // A pinned panel is read, so a click inside it must not count as the
    // click-away that dismisses it.
    panel.addEventListener("mousedown", (event) => event.stopPropagation());
    document.body.append(panel);
  }
  return panel;
}

/**
 * @typedef {{ title: string, subtitle?: string, docs: string,
 *   x: number, y: number }} DocTip
 */

/**
 * @param {DocTip} tip
 * @param {boolean} pin
 */
function paint(tip, pin) {
  const node = element();
  node.replaceChildren(
    h(
      "div",
      { class: "doctip-head" },
      h("span", { class: "doctip-title mono" }, tip.title),
      pin ? h("button", { type: "button", class: "doctip-close", onclick: () => hideDoc(true) }, "×") : null,
    ),
    tip.subtitle ? h("p", { class: "doctip-sub hint" }, tip.subtitle) : null,
    h("div", { class: "doctip-body prose" }, renderMarkdown(tip.docs)),
  );
  node.classList.toggle("pinned", pin);
  node.style.display = "block";
  pinned = pin;
  place(node, tip.x, tip.y);
}

/** Keeps the panel beside the pointer and inside the window. */
function place(node, x, y) {
  // Measured after painting, because the height depends on the text.
  node.style.left = "0px";
  node.style.top = "0px";
  const box = node.getBoundingClientRect();
  const margin = 12;
  const left = Math.max(
    margin,
    Math.min(x + 16, window.innerWidth - box.width - margin),
  );
  const top = Math.max(
    margin,
    Math.min(y + 16, window.innerHeight - box.height - margin),
  );
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

/**
 * Shows the panel after a short pause, so that crossing a marker on the way
 * somewhere else does not flash it.
 * @param {DocTip} tip
 */
export function hoverDoc(tip) {
  if (pinned) return;
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => paint(tip, false), 120);
}

/** @param {DocTip} tip */
export function pinDoc(tip) {
  window.clearTimeout(showTimer);
  paint(tip, true);
}

/**
 * @param {boolean} [force] dismiss even a pinned panel
 */
export function hideDoc(force = false) {
  window.clearTimeout(showTimer);
  if (pinned && !force) return;
  pinned = false;
  if (panel) panel.style.display = "none";
}

export function isPinned() {
  return pinned;
}
