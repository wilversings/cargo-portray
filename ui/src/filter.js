// Turning the whole model plus the filter state into the subgraph to draw.
//
// The order matters: artifact kinds and hidden nodes are removed first so
// that a hidden node cannot act as a stepping stone in the reachability walk
// that follows.

import { isUnder } from "./model.js";
import { isHidden } from "./modules.js";

/**
 * @typedef {import("./model.js").NodeKind|"module"} ViewKind
 * @typedef {{ id: string, kind: ViewKind, name: string, module: string,
 *   owner: string|null, file: string, line: number, visibility: string,
 *   members: import("./model.js").Member[], signature: string|null,
 *   docs: string|null, contains?: number }} ViewNode
 * @typedef {{ from: string, fromPort: string|null, to: string,
 *   rel: import("./model.js").Rel, via: import("./model.js").Via,
 *   ambiguous: boolean, count: number }} ViewEdge
 * @typedef {{ nodes: ViewNode[], edges: ViewEdge[], totalNodes: number,
 *   totalEdges: number, emptyReason: string|null }} View
 */

/** @param {string} pattern */
function compilePattern(pattern) {
  if (!pattern.trim()) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Node ids within `depth` hops of `seeds`, following edges in `direction`.
 * @param {Set<string>} seeds
 * @param {import("./model.js").GraphEdge[]} edges
 * @param {number} depth
 * @param {import("./state.js").Direction} direction
 */
function reachable(seeds, edges, depth, direction) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  /** @type {Map<string, string[]>} */
  const inbound = new Map();
  for (const edge of edges) {
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from).push(edge.to);
    if (!inbound.has(edge.to)) inbound.set(edge.to, []);
    inbound.get(edge.to).push(edge.from);
  }

  const seen = new Set(seeds);
  let frontier = [...seeds];
  for (let hop = 0; hop < depth; hop++) {
    /** @type {string[]} */
    const next = [];
    for (const id of frontier) {
      /** @type {string[]} */
      const neighbours = [];
      if (direction !== "in") neighbours.push(...(out.get(id) ?? []));
      if (direction !== "out") neighbours.push(...(inbound.get(id) ?? []));
      for (const neighbour of neighbours) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return seen;
}

/**
 * @param {import("./model.js").Graph} graph
 * @param {import("./state.js").FilterState} state
 * @returns {View}
 */
export function buildView(graph, state) {
  const kinds = new Set(state.kinds);
  const rels = new Set(state.rels);
  const vias = new Set(state.vias);
  const hidden = new Set(state.hidden);
  const pattern = compilePattern(state.hidePattern);

  // 1. Which artifacts are eligible at all.
  const visible = graph.nodes.filter((node) => {
    if (!kinds.has(node.kind)) return false;
    if (hidden.has(node.id)) return false;
    if (pattern && pattern.test(node.id)) return false;
    if (isHidden(node.module, state.hiddenModules)) return false;
    return true;
  });
  const visibleIds = new Set(visible.map((node) => node.id));

  // 2. Which relations are eligible, between eligible artifacts.
  const eligibleEdges = graph.edges.filter((edge) => {
    if (!rels.has(edge.rel)) return false;
    if (!vias.has(edge.via)) return false;
    if (edge.ambiguous && !state.ambiguous) return false;
    return visibleIds.has(edge.from) && visibleIds.has(edge.to);
  });

  // 3. Narrow to what is under study, if anything is.
  /** @type {Set<string>} */
  let keep;
  if (state.focus && visibleIds.has(state.focus)) {
    keep = reachable(new Set([state.focus]), eligibleEdges, state.depth, state.direction);
  } else if (state.solo !== null) {
    const seeds = new Set(
      visible.filter((node) => isUnder(node.module, state.solo)).map((node) => node.id),
    );
    keep = reachable(seeds, eligibleEdges, state.depth, state.direction);
  } else {
    keep = visibleIds;
  }

  let nodes = visible.filter((node) => keep.has(node.id)).map((node) => ({ ...node }));
  let edges = eligibleEdges
    .filter((edge) => keep.has(edge.from) && keep.has(edge.to))
    .map((edge) => ({ ...edge, count: 1 }));

  // 4. Collapse whole modules into single boxes.
  if (state.collapsedModules.length > 0) {
    ({ nodes, edges } = collapse(nodes, edges, state.collapsedModules));
  }

  // 5. Drop anything left without a relation to show — but only while there
  //    are relations to show at all. Turning every edge type off is a request
  //    to see the artifacts on their own, not to see an empty page.
  if (!state.showOrphans && edges.length > 0) {
    const connected = new Set();
    for (const edge of edges) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    nodes = nodes.filter((node) => connected.has(node.id));
  }

  return {
    nodes,
    edges,
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    emptyReason: nodes.length > 0 ? null : whyEmpty(graph, state, visible.length),
  };
}

/**
 * A blank page should say which filter emptied it — the sidebar still lists
 * every artifact, so "nothing is drawn" on its own reads like a bug.
 * @param {import("./model.js").Graph} graph
 * @param {import("./state.js").FilterState} state
 * @param {number} eligible how many artifacts survived the kind/module/hidden filters
 */
function whyEmpty(graph, state, eligible) {
  if (graph.nodes.length === 0) return "This crate has no artifacts to draw.";
  if (eligible === 0) {
    return (
      `All ${graph.nodes.length} artifacts are switched off — by artifact type, ` +
      `by module, or on the hidden list.`
    );
  }
  if (state.solo !== null) {
    return (
      `Nothing under ${state.solo || "the crate root"} survives the other filters. ` +
      `Stop studying it on its own, or widen those.`
    );
  }
  return "Every artifact is filtered out.";
}

/**
 * @param {ViewNode[]} nodes
 * @param {ViewEdge[]} edges
 * @param {string[]} collapsedModules
 */
function collapse(nodes, edges, collapsedModules) {
  // An outer collapsed module swallows an inner one, so the shortest
  // matching prefix wins.
  const ordered = [...collapsedModules].sort((a, b) => a.length - b.length);
  /** @type {Map<string, string>} */
  const owner = new Map();
  /** @type {Map<string, number>} */
  const counts = new Map();

  for (const node of nodes) {
    const module = ordered.find((candidate) => isUnder(node.module, candidate));
    if (module === undefined) continue;
    const id = `module:${module}`;
    owner.set(node.id, id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const kept = nodes.filter((node) => !owner.has(node.id));
  for (const [id, count] of counts) {
    const module = id.slice("module:".length);
    const parent = module.includes("::") ? module.slice(0, module.lastIndexOf("::")) : "";
    kept.push({
      id,
      kind: "module",
      name: module === "" ? "crate root" : module.split("::").pop(),
      module: parent,
      owner: null,
      file: "",
      line: 0,
      visibility: "",
      members: [],
      signature: null,
      docs: null,
      contains: count,
    });
  }

  // Parallel edges between the same pair collapse into one, carrying a count.
  /** @type {Map<string, ViewEdge>} */
  const merged = new Map();
  for (const edge of edges) {
    const from = owner.get(edge.from) ?? edge.from;
    const to = owner.get(edge.to) ?? edge.to;
    if (from === to) continue;
    const collapsedEnd = from !== edge.from || to !== edge.to;
    const key = `${from} ${to} ${edge.rel} ${edge.via}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += 1;
      existing.ambiguous = existing.ambiguous && edge.ambiguous;
      continue;
    }
    merged.set(key, {
      from,
      to,
      // A port only means something while the field rows are still drawn.
      fromPort: collapsedEnd ? null : edge.fromPort,
      rel: edge.rel,
      via: edge.via,
      ambiguous: edge.ambiguous,
      count: 1,
    });
  }

  return { nodes: kept, edges: [...merged.values()] };
}
