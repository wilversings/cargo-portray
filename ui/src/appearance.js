// How things look, as opposed to which things are shown.
//
// Kept out of the filter state and out of the URL on purpose: a colour scheme
// is a standing preference, not part of the view you share. It lives in
// localStorage instead.
//
// Everything here comes in two, one per theme, because a palette drawn to sit
// on white cannot sit on black: a pale yellow header is a lamp on a dark page,
// and a near-black edge is not a line at all. The two are stored separately
// as well, so colours picked for the light page are still there when the dark
// one is left again.

import { NODE_KINDS, RELS, VIAS } from "./model.js";

const STORAGE_KEY = "portray.appearance.v2";
/** The single-theme shape this replaces; read once, as the light palette. */
const LEGACY_KEY = "portray.appearance.v1";

/**
 * @typedef {import("./theme.js").Theme} Theme
 * @typedef {{ color: string, arrowhead: string }} EdgeLook
 * @typedef {"relation"|"random"} EdgeColorMode
 * @typedef {{ nodeColors: Record<string, string>,
 *   edges: Record<string, EdgeLook>,
 *   viaStyles: Record<string, string>,
 *   edgeColors: EdgeColorMode }} Appearance
 */

/** @type {Record<Theme, Record<string, string>>} */
const NODE_COLORS = {
  light: {
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
  // The same hues, taken down to where the page's own ink reads on top of
  // them, and kept apart from each other by the same amount they were.
  dark: {
    struct: "#6e5514",
    enum: "#4a3d70",
    trait: "#1f5257",
    type_alias: "#45484c",
    const: "#3a3d42",
    fn: "#33502e",
    inherent_method: "#2d4a28",
    trait_method: "#3a5734",
    impl_method: "#274423",
    module: "#2f4260",
  },
};

/** @type {Record<Theme, Record<string, EdgeLook>>} */
const EDGE_LOOKS = {
  light: {
    field: { color: "#3c78d8", arrowhead: "diamond" },
    param: { color: "#333333", arrowhead: "normal" },
    return: { color: "#8a8a8a", arrowhead: "normal" },
    impls: { color: "#b45f06", arrowhead: "onormal" },
    supertrait: { color: "#6a329f", arrowhead: "onormal" },
    bound: { color: "#38761d", arrowhead: "vee" },
    call: { color: "#a61c3c", arrowhead: "vee" },
  },
  // Arrowheads are the relation as much as the colours are, so only the
  // colours turn over: each one lifted to where a hairline of it is still a
  // line once the page behind it is dark.
  dark: {
    field: { color: "#6fa8ff", arrowhead: "diamond" },
    param: { color: "#c3cad3", arrowhead: "normal" },
    return: { color: "#8b959f", arrowhead: "normal" },
    impls: { color: "#e79a3c", arrowhead: "onormal" },
    supertrait: { color: "#b385e0", arrowhead: "onormal" },
    bound: { color: "#6fbf50", arrowhead: "vee" },
    call: { color: "#ff6b87", arrowhead: "vee" },
  },
};

/**
 * The parts of the drawing the reader does not pick: the sheet it is on, the
 * ink its labels are written in, and the boxes modules and impl blocks are
 * grouped by. They are not in `Appearance` because they are not choices — a
 * reset would have nothing to put back, and a saved copy of them would be a
 * light-mode diagram waiting to reappear on a dark page.
 *
 * The light half is black where Graphviz's own default was black — the ink a
 * label is written in and the line a node is outlined in — because it was
 * already right and a diagram nobody asked to have restyled should not come
 * back looking restyled. Only the dark half is new.
 *
 * @type {Record<Theme, { bg: string, ink: string, nodeLine: string,
 *   table: string, clusterLine: string, groupLine: string, groupFill: string,
 *   depthFills: string[] }>}
 */
export const DIAGRAM_CHROME = {
  light: {
    bg: "#ffffff",
    ink: "#000000",
    nodeLine: "#000000",
    table: "#ffffff",
    clusterLine: "#b7bec9",
    groupLine: "#9fb3c8",
    groupFill: "#ffffff",
    depthFills: ["#f7f7f9", "#eef1f6", "#e6ebf3", "#dfe6f0"],
  },
  dark: {
    bg: "#14171b",
    ink: "#e2e6ea",
    nodeLine: "#5b6673",
    table: "#1a1e24",
    clusterLine: "#4a525d",
    groupLine: "#5b6673",
    groupFill: "#1a1e24",
    depthFills: ["#20242b", "#262c35", "#2c333e", "#333b47"],
  },
};

/** @param {Theme} theme @returns {Appearance} */
export function defaultAppearance(theme) {
  return {
    nodeColors: { ...NODE_COLORS[theme] },
    edges: structuredClone(EDGE_LOOKS[theme]),
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

/** @returns {Record<string, unknown>} whatever this browser has stored, by theme */
function readStore() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) ?? {};
    // Colours picked before there was a second theme were picked on white.
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    return legacy ? { light: JSON.parse(legacy) } : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} store */
function writeStore(store) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Private browsing, a full quota — the colours just will not persist.
  }
}

/** @param {Theme} theme @returns {Appearance} */
export function loadAppearance(theme) {
  const base = defaultAppearance(theme);
  const saved = readStore()[theme];
  if (!saved || typeof saved !== "object") return base;
  const kept = /** @type {Partial<Appearance>} */ (saved);
  return {
    nodeColors: { ...base.nodeColors, ...(kept.nodeColors ?? {}) },
    edges: { ...base.edges, ...(kept.edges ?? {}) },
    viaStyles: { ...base.viaStyles, ...(kept.viaStyles ?? {}) },
    edgeColors: kept.edgeColors === "random" ? "random" : base.edgeColors,
  };
}

/** @param {Theme} theme @param {Appearance} appearance */
export function saveAppearance(theme, appearance) {
  writeStore({ ...readStore(), [theme]: appearance });
}

/** @param {Theme} theme */
export function clearAppearance(theme) {
  const store = readStore();
  delete store[theme];
  writeStore(store);
}

/**
 * Two colours blended, which is how a node's rows are tinted from its header:
 * one picked colour restyles the whole table, and it works either way up
 * because the colour being mixed *towards* is the sheet the diagram is on —
 * white on the light page, near-black on the dark one.
 *
 * @param {string} hex
 * @param {string} towards
 * @param {number} amount 0 keeps the colour, 1 reaches `towards`
 */
export function mix(hex, towards, amount) {
  const from = channels(hex);
  const to = channels(towards);
  if (!from || !to) return hex;
  return (
    "#" +
    from
      .map((channel, i) =>
        Math.round(channel + (to[i] - channel) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/** @param {string} hex @returns {[number, number, number]|null} */
function channels(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
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
 * @param {Theme} theme
 */
export function edgeColor(look, edge, theme) {
  const relColor = look.edges[edge.rel]?.color ?? DIAGRAM_CHROME[theme].ink;
  if (look.edgeColors !== "random") return relColor;
  const key = [edge.from, edge.fromPort ?? "", edge.to, edge.rel].join("\u0000");
  const hash = hashOf(key);
  // Kept clear of the sheet it is drawn on: these are hairlines, and one at
  // the background's own lightness is not a line the reader can follow —
  // which means dark and saturated on white, and pale on black.
  const light = theme === "dark" ? 60 + ((hash >>> 17) % 15) : 31 + ((hash >>> 17) % 14);
  return hslToHex(hash % 360, 58 + ((hash >>> 9) % 30), light);
}

/** Names of everything that can be recoloured, for building the panel. */
export const COLOURABLE_KINDS = [...NODE_KINDS, "module"];
export { RELS, VIAS };
