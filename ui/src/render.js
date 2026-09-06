// Laying the DOT out with Graphviz compiled to WebAssembly, and making the
// resulting SVG clickable.

import { Graphviz } from "../vendor/graphviz.js";
import { parseDocHref } from "./dot.js";
import { attachPanZoom } from "./panzoom.js";

/** @type {Promise<any>|null} */
let graphvizPromise = null;

function graphviz() {
  if (!graphvizPromise) graphvizPromise = Graphviz.load();
  return graphvizPromise;
}

/** @type {{ fit(): void }|null} */
let panZoom = null;

/**
 * @typedef {{ onSelect(id: string): void, onActivate(id: string): void,
 *   onDocHover(target: DocTarget, event: MouseEvent): void,
 *   onDocPin(target: DocTarget, event: MouseEvent): void,
 *   onDocLeave(): void }} Hooks
 * @typedef {{ id: string, port: string|null }} DocTarget
 */

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
  bindDocMarkers(element, hooks);
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
 * The documentation markers.
 *
 * `dot.js` hangs a `portray-doc:` href off each one, because a link is the
 * only thing Graphviz carries all the way from a table cell to the SVG. None
 * of them is a link in any real sense, so the default is cancelled and the
 * page opens the panel itself.
 *
 * @param {SVGElement} svg
 * @param {Hooks} hooks
 */
function bindDocMarkers(svg, hooks) {
  for (const anchor of svg.querySelectorAll("a")) {
    const href =
      anchor.getAttribute("xlink:href") ?? anchor.getAttribute("href") ?? "";
    const target = parseDocHref(href);
    if (!target) continue;

    anchor.classList.add("doc-marker");
    drawMarker(anchor, target.whole);
    anchor.addEventListener("mouseenter", (event) => hooks.onDocHover(target, event));
    anchor.addEventListener("mouseleave", () => hooks.onDocLeave());
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hooks.onDocPin(target, event);
    });
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Radius of the marker's ring, in the diagram's own units. */
const RING = 5.2;

/**
 * Rings the marker.
 *
 * The circle is drawn here rather than written into the label as `\u24d8`,
 * because that character is one many systems have no glyph for and render as
 * a squashed oval out of a fallback font. A circle and a letter are two shapes
 * this file controls, and they look the same everywhere.
 *
 * A table cell already holds the letter — Graphviz put it there — so it only
 * gains the ring. A plain node has no cell, so both are drawn, into the
 * top-right of the shape where `dot.js` widened it to leave room.
 *
 * @param {Element} anchor
 * @param {boolean} whole true for a whole-node marker
 */
function drawMarker(anchor, whole) {
  const shape = anchor.querySelector("ellipse, polygon");
  const glyph = /** @type {SVGGraphicsElement|null} */ (anchor.querySelector("text"));

  const centre = whole ? cornerOf(shape) : centreOf(glyph);
  if (!centre) return;

  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", centre.x.toFixed(2));
  ring.setAttribute("cy", centre.y.toFixed(2));
  ring.setAttribute("r", String(RING));
  ring.setAttribute("class", "doc-ring");
  anchor.append(ring);

  if (!whole) {
    // Graphviz pinned the letter to the width it guessed for it; freed of
    // that, the browser draws it at its own width, inside the ring.
    glyph?.removeAttribute("textLength");
    glyph?.removeAttribute("lengthAdjust");
    glyph?.classList.add("doc-glyph");
    return;
  }
  const letter = document.createElementNS(SVG_NS, "text");
  letter.setAttribute("x", centre.x.toFixed(2));
  letter.setAttribute("y", centre.y.toFixed(2));
  letter.setAttribute("class", "doc-letter");
  letter.textContent = "i";
  anchor.append(letter);
}

/** @param {Element|null} element */
function centreOf(element) {
  const box = boundsOf(element);
  return box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The top right of a shape, *inside* it.
 *
 * The corner of an ellipse's bounding box is outside the ellipse, and the
 * middle of it is where the label already is, so the marker goes on the
 * diagonal between them — in the room `dot.js` added to the width for it.
 * @param {Element|null} shape
 */
function cornerOf(shape) {
  if (shape?.tagName === "ellipse") {
    const at = (/** @type {string} */ name) => Number(shape.getAttribute(name) ?? 0);
    // Halfway round to the corner, on an ellipse shrunk by the ring's own
    // size, so the ring lands inside the outline however flat the node is.
    const inset = RING * 1.6;
    const diagonal = Math.SQRT1_2;
    return {
      x: at("cx") + Math.max(at("rx") - inset, 0) * diagonal,
      y: at("cy") - Math.max(at("ry") - inset, 0) * diagonal,
    };
  }
  const box = boundsOf(shape);
  return box && { x: box.x + box.width - RING * 1.7, y: box.y + RING * 1.7 };
}

/** @param {Element|null} element */
function boundsOf(element) {
  try {
    return /** @type {SVGGraphicsElement} */ (element)?.getBBox() ?? null;
  } catch {
    return null; // never laid out, so there is nothing to place anything against
  }
}

/**
 * @param {Element} group
 * @param {boolean} on
 */
export function markSelected(group, on) {
  group.classList.toggle("selected", on);
  for (const shape of group.querySelectorAll("polygon, ellipse, path")) {
    if (on) {
      shape.setAttribute("stroke", "#d1345b");
      shape.setAttribute("stroke-width", "2.5");
    } else if (shape.getAttribute("stroke") === "#d1345b") {
      shape.setAttribute("stroke", "#000000");
      shape.removeAttribute("stroke-width");
    }
  }
}

export function resetView() {
  panZoom?.fit();
}
