// How things look, as opposed to which things are shown.
//
// Kept out of the filter state and out of the URL on purpose: a colour scheme
// is a standing preference, not part of the view you share. It lives in
// localStorage instead.

import { NODE_KINDS, RELS, VIAS } from "./model.js";

const STORAGE_KEY = "portray.appearance.v1";

/**
 * @typedef {{ color: string, arrowhead: string }} EdgeLook
 * @typedef {"relation"|"random"} EdgeColorMode
 * @typedef {{ nodeColors: Record<string, string>,
 *   edges: Record<string, EdgeLook>,
 *   viaStyles: Record<string, string>,
 *   edgeColors: EdgeColorMode }} Appearance
 */

/** @returns {Appearance} */
export function defaultAppearance() {
  return {
    nodeColors: {
      struct: "#ffe08a",
      enum: "#d5c3f0",
      trait: "#a8dadc",
      type_alias: "#d9d9d9",
      const: "#f0f0f0",
      fn: "#d9ead3",
      inherent_method: "#cfe8c6",
      trait_method: "#e2f0d9",
      impl_method: "#c3e0b8",
      module: "#dbe5f1",
    },
    edges: {
      field: { color: "#3c78d8", arrowhead: "diamond" },
      param: { color: "#333333", arrowhead: "normal" },
      return: { color: "#8a8a8a", arrowhead: "normal" },
      impls: { color: "#b45f06", arrowhead: "onormal" },
      supertrait: { color: "#6a329f", arrowhead: "onormal" },
      bound: { color: "#38761d", arrowhead: "vee" },
      call: { color: "#a61c3c", arrowhead: "vee" },
    },
    viaStyles: {
      direct: "solid",
      generic: "dashed",
      dyn: "dotted",
    },
    edgeColors: "relation",
  };
}

export const ARROWHEADS = ["normal", "vee", "diamond", "odiamond", "onormal", "dot", "none"];
export const LINE_STYLES = ["solid", "dashed", "dotted", "bold"];

/** @returns {Appearance} */
export function loadAppearance() {
  const base = defaultAppearance();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    return {
      nodeColors: { ...base.nodeColors, ...(saved.nodeColors ?? {}) },
      edges: { ...base.edges, ...(saved.edges ?? {}) },
      viaStyles: { ...base.viaStyles, ...(saved.viaStyles ?? {}) },
      edgeColors: saved.edgeColors === "random" ? "random" : base.edgeColors,
    };
  } catch {
    return base;
  }
}

/** @param {Appearance} appearance */
export function saveAppearance(appearance) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Private browsing, a full quota — the colours just will not persist.
  }
}

export function clearAppearance() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the defaults are already what is in memory.
  }
}

/**
 * The pale companion of a header colour, used for the rows of a type table so
 * one picked colour is enough to restyle a whole node.
 * @param {string} hex
 * @param {number} amount 0 keeps the colour, 1 turns it white
 */
export function lighten(hex, amount) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  const r = mix((value >> 16) & 0xff);
  const g = mix((value >> 8) & 0xff);
  const b = mix(value & 0xff);
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

/**
 * 32-bit FNV-1a. Small, and — unlike `Math.random` — the same key gives the
 * same colour on every redraw, so a line does not change colour when a
 * filter moves and the diagram is laid out again.
 * @param {string} key
 */
function hashOf(key) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** @param {number} hue @param {number} sat @param {number} light 0-100 */
function hslToHex(hue, sat, light) {
  const s = sat / 100;
  const l = light / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = hue / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][Math.floor(sector) % 6];
  const offset = l - chroma / 2;
  return (
    "#" +
    base
      .map((channel) =>
        Math.round((channel + offset) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/**
 * The colour one edge is drawn in.
 *
 * `relation` is the meaningful scheme: the colour says what the dependency
 * *is*. `random` gives every edge its own colour instead, which says nothing
 * — it is there for the crowded case, where a dozen edges run down the same
 * channel between two clusters and the only question is which line is which.
 * Arrowheads still carry the relation and line styles still carry the via,
 * so nothing is actually lost.
 *
 * @param {Appearance} look
 * @param {import("./filter.js").ViewEdge} edge
 */
export function edgeColor(look, edge) {
  const relColor = look.edges[edge.rel]?.color ?? "#333333";
  if (look.edgeColors !== "random") return relColor;
  const key = [edge.from, edge.fromPort ?? "", edge.to, edge.rel].join("\u0000");
  const hash = hashOf(key);
  // Kept dark and saturated: these are hairlines on white, and a pale one is
  // not a line the reader can follow.
  return hslToHex(hash % 360, 58 + ((hash >>> 9) % 30), 31 + ((hash >>> 17) % 14));
}

/** Names of everything that can be recoloured, for building the panel. */
export const COLOURABLE_KINDS = [...NODE_KINDS, "module"];
export { RELS, VIAS };
