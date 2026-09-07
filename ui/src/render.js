// Laying the DOT out with Graphviz compiled to WebAssembly, and making the
// resulting SVG clickable.

import { Graphviz } from "../vendor/graphviz.js";
import { attachPanZoom } from "./panzoom.js";

/** @type {Promise<any>|null} */
let graphvizPromise = null;

function graphviz() {
  if (!graphvizPromise) graphvizPromise = Graphviz.load();
  return graphvizPromise;
}

/** @type {{ fit(): void }|null} */
let panZoom = null;

/** @typedef {{ onSelect(id: string): void, onActivate(id: string): void }} Hooks */

/**
 * @param {HTMLElement} container
 * @param {string} dot
 * @param {string|null} selected
 * @param {Hooks} hooks
 * @returns {Promise<{ svg: string, elapsedMs: number }>}
 */
export async function renderInto(container, dot, selected, hooks) {
  const engine = await graphviz();
  const started = performance.now();
  const svg = engine.layout(dot, "svg", "dot");
  const elapsedMs = performance.now() - started;

  container.innerHTML = svg;
  panZoom = null;

  const element = /** @type {SVGSVGElement|null} */ (container.querySelector("svg"));
  if (!element) return { svg, elapsedMs };
  element.setAttribute("width", "100%");
  element.setAttribute("height", "100%");
  element.removeAttribute("style");

  bindNodes(element, selected, hooks);
  panZoom = attachPanZoom(element);

  return { svg, elapsedMs };
}

/**
 * Graphviz writes each node's id into a `<title>`; that is the handle used to
 * map a click back to a model node.
 * @param {SVGElement} svg
 * @param {string|null} selected
 * @param {Hooks} hooks
 */
function bindNodes(svg, selected, hooks) {
  for (const group of svg.querySelectorAll("g.node")) {
    const id = group.querySelector("title")?.textContent ?? "";
    if (!id) continue;

    group.style.cursor = "pointer";
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      hooks.onSelect(id);
    });
    group.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      event.preventDefault();
      hooks.onActivate(id);
    });

    if (id === selected) markSelected(group, true);
  }
}

/** Must match `--accent`: the colour a selected node is outlined in. */
const SELECT_STROKE = "#d1345b";

/**
 * @param {Element} group
 * @param {boolean} on
 */
export function markSelected(group, on) {
  group.classList.toggle("selected", on);
  for (const shape of group.querySelectorAll("polygon, ellipse, path")) {
    if (on) {
      // What the shape was drawn with, kept so that deselecting puts it back.
      // A table's cell backgrounds carry no stroke at all, and painting them
      // black on the way out would rule lines the diagram never had.
      if (!shape.hasAttribute("data-stroke")) {
        shape.setAttribute("data-stroke", shape.getAttribute("stroke") ?? "none");
      }
      shape.setAttribute("stroke", SELECT_STROKE);
      shape.setAttribute("stroke-width", "2.5");
    } else if (shape.getAttribute("stroke") === SELECT_STROKE) {
      shape.setAttribute("stroke", shape.getAttribute("data-stroke") ?? "#000000");
      shape.removeAttribute("stroke-width");
    }
  }
}

export function resetView() {
  panZoom?.fit();
}
