// Laying the DOT out with Graphviz compiled to WebAssembly, and making the
// resulting SVG clickable — and, under the pointer, traceable.

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
 * @param {{ selected: string|null,
 *   edges: import("./filter.js").ViewEdge[],
 *   trace: boolean }} options `edges` in the same order `dot.js` numbered them
 * @param {Hooks} hooks
 * @returns {Promise<{ svg: string, elapsedMs: number }>}
 */
export async function renderInto(container, dot, options, hooks) {
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

  bindNodes(element, options.selected, hooks);
  if (options.trace) bindTrace(element, options.edges);
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

/**
 * A second copy of the edge's line, transparent and thick, laid under it.
 *
 * An edge is a hairline: at the zoom where a crowded channel is worth
 * tracing, hitting one with the pointer is luck. The copy is what the pointer
 * actually hits — `pointer-events: stroke` in the stylesheet applies to it
 * whether or not the paint is visible — and it carries no dash pattern, so
 * there are no gaps in the target.
 *
 * @param {Element} edge
 */
function widenHitArea(edge) {
  const line = edge.querySelector("path");
  if (!line) return;
  const hit = /** @type {Element} */ (line.cloneNode(false));
  hit.setAttribute("class", "hit");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", "9");
  hit.removeAttribute("stroke-dasharray");
  edge.insertBefore(hit, line);
}

/**
 * Dim everything the pointer is not on.
 *
 * The clutter this answers is a bundle of edges sharing one channel between
 * two clusters: the picture is right, and unreadable, because twenty lines
 * that run together cannot be told apart by eye. Nothing is removed and
 * nothing is laid out differently — hovering a node lights that node, its
 * edges and their far ends, and hovering a line lights just that line and the
 * two things it joins, which is what turns a bundle back into edges.
 *
 * @param {SVGElement} svg
 * @param {import("./filter.js").ViewEdge[]} edges
 */
function bindTrace(svg, edges) {
  /** @type {Map<string, Element>} */
  const nodes = new Map();
  for (const group of svg.querySelectorAll("g.node")) {
    const id = group.querySelector("title")?.textContent ?? "";
    if (id) nodes.set(id, group);
  }

  /** Ends of the edge drawn by one SVG group. @type {Map<Element, string[]>} */
  const ends = new Map();
  /** Edges incident to one node. @type {Map<string, Element[]>} */
  const touching = new Map();
  edges.forEach((edge, index) => {
    const element = svg.querySelector(`#edge_${index}`);
    if (!element) return;
    ends.set(element, [edge.from, edge.to]);
    for (const id of [edge.from, edge.to]) {
      if (!touching.has(id)) touching.set(id, []);
      touching.get(id)?.push(element);
    }
    widenHitArea(element);
  });

  /** @type {Element[]} */
  let lit = [];
  const clear = () => {
    if (lit.length === 0) return;
    svg.classList.remove("tracing");
    for (const element of lit) element.classList.remove("traced");
    lit = [];
  };

  /** @param {Element[]} elements */
  const light = (elements) => {
    clear();
    if (elements.length === 0) return;
    for (const element of elements) element.classList.add("traced");
    lit = elements;
    // One class on the root does the dimming, so the cost of a hover does not
    // grow with the size of the drawing.
    svg.classList.add("tracing");
  };

  /** @type {Element|null} */
  let under = null;

  // Delegated, because `mouseenter` does not bubble and a crowded diagram has
  // thousands of groups to bind.
  svg.addEventListener("mouseover", (event) => {
    const target =
      event.target instanceof Element ? event.target.closest("g.node, g.edge") : null;
    if (target === under) return;
    under = target;

    if (!target) {
      clear();
      return;
    }

    /** @type {Element[]} */
    const wanted = [target];
    /** @param {string[]} ids */
    const addNodes = (ids) => {
      for (const id of ids) {
        const node = nodes.get(id);
        if (node) wanted.push(node);
      }
    };

    if (target.classList.contains("edge")) {
      addNodes(ends.get(target) ?? []);
    } else {
      const id = target.querySelector("title")?.textContent ?? "";
      const seen = new Set([id]);
      for (const element of touching.get(id) ?? []) {
        wanted.push(element);
        const far = (ends.get(element) ?? []).filter((end) => !seen.has(end));
        for (const end of far) seen.add(end);
        addNodes(far);
      }
    }
    light(wanted);
  });

  svg.addEventListener("mouseleave", () => {
    under = null;
    clear();
  });
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
