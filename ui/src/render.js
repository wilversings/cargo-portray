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

/** @type {{ fit(): void, setLocked(on: boolean): void }|null} */
let panZoom = null;
/**
 * Whether the diagram is pinned where the reader left it. It lives here rather
 * than in the pan itself because every redraw builds a new SVG and a new pan:
 * a lock the reader switched on would come off under a filter click otherwise.
 */
let locked = false;

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
  panZoom.setLocked(locked);

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

/**
 * The colour a selected node is outlined in.
 *
 * The stylesheet owns it — it is `--accent`, and it turns over with the theme
 * — so it is handed here rather than copied here, and a second palette cannot
 * go stale beside the first. The default is only what stands until the page
 * has read the real one back.
 */
let selectStroke = "#d1345b";

/** @param {string} color */
export function setSelectStroke(color) {
  selectStroke = color;
}

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
      shape.setAttribute("stroke", selectStroke);
      shape.setAttribute("stroke-width", "2.5");
    } else if (shape.getAttribute("stroke") === selectStroke) {
      shape.setAttribute("stroke", shape.getAttribute("data-stroke") ?? "#000000");
      shape.removeAttribute("stroke-width");
    }
  }
}

export function resetView() {
  panZoom?.fit();
}

/**
 * Pins the view: the wheel and the drag stop moving it, and it survives the
 * redraws that follow. `fit` still works — it is asked for, not stumbled into.
 * @param {boolean} on
 */
export function setDiagramLocked(on) {
  locked = on;
  panZoom?.setLocked(on);
}
