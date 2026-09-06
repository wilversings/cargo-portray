// How things look, as opposed to which things are shown.
//
// Kept out of the filter state and out of the URL on purpose: a colour scheme
// is a standing preference, not part of the view you share. It lives in
// localStorage instead.

import { NODE_KINDS, RELS, VIAS } from "./model.js";

const STORAGE_KEY = "portray.appearance.v1";

/**
 * @typedef {{ color: string, arrowhead: string }} EdgeLook
 * @typedef {{ nodeColors: Record<string, string>,
 *   edges: Record<string, EdgeLook>,
 *   viaStyles: Record<string, string> }} Appearance
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

/** Names of everything that can be recoloured, for building the panel. */
export const COLOURABLE_KINDS = [...NODE_KINDS, "module"];
export { RELS, VIAS };
