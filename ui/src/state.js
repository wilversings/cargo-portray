// Filter state, and the URL hash it round-trips through so that any view is
// a shareable link and the browser's back button undoes a filter change.

import { moduleTree, NODE_KINDS, RELS, VIAS } from "./model.js";

/**
 * @typedef {"out"|"in"|"both"} Direction
 * @typedef {{
 *   kinds: import("./model.js").NodeKind[],
 *   rels: import("./model.js").Rel[],
 *   vias: import("./model.js").Via[],
 *   ambiguous: boolean,
 *   hiddenModules: string[],
 *   collapsedModules: string[],
 *   solo: string|null,
 *   focus: string|null,
 *   depth: number,
 *   direction: Direction,
 *   hidden: string[],
 *   hidePattern: string,
 *   showMembers: boolean,
 *   showOrphans: boolean,
 *   rankdir: "LR"|"TB",
 * }} FilterState
 */

/**
 * Types and how they relate: dense enough to be interesting, sparse enough to
 * read. Methods and call-shaped edges are one checkbox away.
 * @returns {FilterState}
 */
export function defaultState() {
  return {
    kinds: ["struct", "enum", "trait"],
    rels: ["field", "impls", "supertrait"],
    vias: [...VIAS],
    ambiguous: true,
    hiddenModules: [],
    collapsedModules: [],
    solo: null,
    focus: null,
    depth: 1,
    direction: "out",
    hidden: [],
    hidePattern: "",
    showMembers: true,
    showOrphans: false,
    rankdir: "LR",
  };
}

export class Store {
  /** @param {FilterState} initial */
  constructor(initial) {
    this.state = initial;
    /** @type {((state: FilterState) => void)[]} */
    this.listeners = [];
  }

  /** @returns {FilterState} */
  get() {
    return this.state;
  }

  /**
   * Replaces the state without notifying, for the load and reload paths where
   * the caller draws everything itself straight afterwards.
   * @param {FilterState} state
   */
  reset(state) {
    this.state = state;
    writeHash(state);
  }

  /** @param {(state: FilterState) => void} listener */
  subscribe(listener) {
    this.listeners.push(listener);
  }

  /** @param {Partial<FilterState>} change */
  update(change) {
    this.state = { ...this.state, ...change };
    writeHash(this.state);
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Adds or removes one entry of a list-valued filter.
   * @param {keyof FilterState} key
   * @param {string} value
   */
  toggleIn(key, value) {
    const current = /** @type {string[]} */ (this.state[key]);
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    this.update({ [key]: next });
  }
}

/**
 * Only what differs from the defaults goes into the URL, so a plain view has
 * a plain link.
 * @param {FilterState} state
 */
function diffFromDefaults(state) {
  const base = defaultState();
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(base)) {
    if (JSON.stringify(base[key]) !== JSON.stringify(state[key])) out[key] = state[key];
  }
  return out;
}

let suppressHashRead = false;

/**
 * The hash is written to be read: `#kinds=struct,enum&depth=2` says what the
 * view is without decoding anything. Lists are comma-separated, flags are
 * `true`/`false`, and only the characters that would break the
 * `key=value&key=value` shape are percent-escaped — so a module path keeps its
 * colons and a link stays quotable in prose.
 */
const LIST_KEYS = ["kinds", "rels", "vias", "hiddenModules", "collapsedModules", "hidden"];
const FLAG_KEYS = ["ambiguous", "showMembers", "showOrphans"];
const NUMBER_KEYS = ["depth"];
const DIRECTIONS = ["out", "in", "both"];
const RANKDIRS = ["LR", "TB"];
const FLAG_OFF = ["false", "0", "no", "off"];

/**
 * Escapes only what the hash grammar needs, so `crate::net::Socket` survives
 * as itself. A list entry keeps its comma escaped, since that is the separator.
 * @param {string} text
 * @param {boolean} isEntry
 */
function encodePart(text, isEntry) {
  const encoded = encodeURIComponent(text).replace(/%3A/g, ":").replace(/%2F/g, "/");
  return isEntry ? encoded : encoded.replace(/%2C/g, ",");
}

/** @param {unknown} value */
function encodeValue(value) {
  if (Array.isArray(value)) return value.map((entry) => encodePart(String(entry), true)).join(",");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (value === null || value === undefined) return "";
  return encodePart(String(value), false);
}

/**
 * @param {string} key
 * @param {string} raw
 * @param {FilterState} base
 */
function decodeValue(key, raw, base) {
  if (LIST_KEYS.includes(key)) {
    return raw === "" ? [] : raw.split(",").map((entry) => decodeURIComponent(entry));
  }
  // A bare `&showOrphans` reads as switching it on, which is what writing one
  // by hand means.
  if (FLAG_KEYS.includes(key)) return !FLAG_OFF.includes(raw.toLowerCase());
  if (NUMBER_KEYS.includes(key)) {
    const number = Number(raw);
    return Number.isFinite(number) ? number : undefined;
  }
  const text = decodeURIComponent(raw);
  return text === "" && base[key] === null ? null : text;
}

/** @param {FilterState} state */
export function writeHash(state) {
  const diff = diffFromDefaults(state);
  const pairs = Object.entries(diff).map(([key, value]) => `${key}=${encodeValue(value)}`);
  const hash = pairs.length === 0 ? "" : "#" + pairs.join("&");
  if (hash === window.location.hash) return;
  suppressHashRead = true;
  window.history.pushState(null, "", hash || window.location.pathname);
  suppressHashRead = false;
}

/**
 * Links written before the hash was readable carry the whole view as encoded
 * JSON. They still open.
 * @param {string} raw
 */
function parseLegacy(raw) {
  return JSON.parse(decodeURIComponent(raw));
}

/**
 * @param {string} raw
 * @param {FilterState} base
 */
function parsePairs(raw, base) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const split = pair.indexOf("=");
    const key = split === -1 ? pair : pair.slice(0, split);
    if (!(key in base)) continue;
    const value = decodeValue(key, split === -1 ? "" : pair.slice(split + 1), base);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** @returns {FilterState} */
export function readHash() {
  const base = defaultState();
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return base;
  try {
    const legacy = raw.startsWith("{") || raw.startsWith("%7B");
    const merged = { ...base, ...(legacy ? parseLegacy(raw) : parsePairs(raw, base)) };
    // A hand-edited link should not be able to smuggle in unknown values.
    merged.kinds = merged.kinds.filter((kind) => NODE_KINDS.includes(kind));
    merged.rels = merged.rels.filter((rel) => RELS.includes(rel));
    merged.vias = merged.vias.filter((via) => VIAS.includes(via));
    if (!DIRECTIONS.includes(merged.direction)) merged.direction = base.direction;
    if (!RANKDIRS.includes(merged.rankdir)) merged.rankdir = base.rankdir;
    return merged;
  } catch {
    return base;
  }
}

/**
 * Drops the parts of a view that name something this crate does not have.
 *
 * A link outlives the crate it was written for: the server always defaults to
 * the same port, so the browser will happily reopen a konductord view against
 * a different project. Left alone, a `solo` on a module that is not here
 * matches nothing and the page comes up blank with every artifact still
 * listed in the sidebar — a filter for a crate you are not looking at should
 * simply not apply.
 *
 * @param {FilterState} state
 * @param {import("./model.js").Graph} graph
 * @returns {{ state: FilterState, dropped: string[] }}
 */
export function reconcile(state, graph) {
  const modules = new Set(moduleTree(graph.nodes));
  const ids = new Set(graph.nodes.map((node) => node.id));
  /** @type {string[]} */
  const dropped = [];
  const next = { ...state };

  if (next.solo !== null && !modules.has(next.solo)) {
    dropped.push(`studying ${next.solo} on its own`);
    next.solo = null;
  }
  if (next.focus !== null && !ids.has(next.focus)) {
    dropped.push(`focus on ${next.focus}`);
    next.focus = null;
  }

  const describe = (/** @type {number} */ n, /** @type {string} */ what) =>
    `${n} ${what}${n === 1 ? "" : "s"} it does not have`;

  const modulesKept = next.hiddenModules.filter((module) => modules.has(module));
  if (modulesKept.length !== next.hiddenModules.length) {
    dropped.push(describe(next.hiddenModules.length - modulesKept.length, "switched-off module"));
    next.hiddenModules = modulesKept;
  }

  const collapsedKept = next.collapsedModules.filter((module) => modules.has(module));
  if (collapsedKept.length !== next.collapsedModules.length) {
    dropped.push(describe(next.collapsedModules.length - collapsedKept.length, "collapsed module"));
    next.collapsedModules = collapsedKept;
  }

  const hiddenKept = next.hidden.filter((id) => ids.has(id));
  if (hiddenKept.length !== next.hidden.length) {
    dropped.push(describe(next.hidden.length - hiddenKept.length, "hidden artifact"));
    next.hidden = hiddenKept;
  }

  return { state: next, dropped };
}

/**
 * Fires when the user navigates back or forward, unless we caused it.
 * @param {(state: FilterState) => void} handler
 */
export function onHashNavigation(handler) {
  window.addEventListener("popstate", () => {
    if (suppressHashRead) return;
    handler(readHash());
  });
}
