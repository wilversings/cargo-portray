// What the selected artifact is, and what you can do to it.

import { button, h, section } from "../dom.js";
import { renderMarkdown } from "../markdown.js";
import { KIND_LABELS, REL_LABELS } from "../model.js";

/**
 * @param {import("../model.js").Graph} graph
 * @param {import("../model.js").GraphNode} node
 */
function neighbourLines(graph, node) {
  const outgoing = graph.edges.filter((edge) => edge.from === node.id);
  const incoming = graph.edges.filter((edge) => edge.to === node.id);
  return [
    h("p", { class: "hint" }, `${outgoing.length} out, ${incoming.length} in`),
    ...outgoing.slice(0, 8).map((edge) =>
      h(
        "div",
        { class: "neighbour" },
        h("span", { class: "neighbour-rel" }, REL_LABELS[edge.rel]),
        h("span", { class: "neighbour-id", title: edge.to }, edge.to),
      ),
    ),
    outgoing.length > 8
      ? h("p", { class: "hint" }, `…and ${outgoing.length - 8} more outgoing`)
      : null,
  ].filter(Boolean);
}

/**
 * The documentation, if there is any: the artifact's own, then each field or
 * variant that has some.
 *
 * The diagram has a marker per doc comment and this panel has all of them at
 * once, because the two questions are different — "what is this one thing"
 * while reading the picture, and "what does this artifact say" once you have
 * picked it.
 * @param {import("../model.js").GraphNode} node
 */
function docLines(node) {
  const documented = node.members.filter((member) => member.docs);
  if (!node.docs && documented.length === 0) return [];
  return [
    node.docs ? h("div", { class: "doc prose" }, renderMarkdown(node.docs)) : null,
    ...documented.map((member) =>
      h(
        "div",
        { class: "doc-member" },
        h("div", { class: "mono doc-member-name" }, member.label),
        h("div", { class: "doc prose" }, renderMarkdown(member.docs)),
      ),
    ),
  ].filter(Boolean);
}

/**
 * @param {import("../state.js").Store} store
 * @param {import("../model.js").Graph} graph
 * @param {string|null} selected
 */
export function detailsPanel(store, graph, selected) {
  const state = store.get();
  if (!selected) {
    return section(
      "Selection",
      h("p", { class: "hint" }, "Click an artifact to inspect it. Double-click to focus on it."),
    );
  }

  const node = graph.nodes.find((candidate) => candidate.id === selected);
  if (!node) {
    // A collapsed module box, or a node that a filter change just removed.
    const module = selected.startsWith("module:") ? selected.slice("module:".length) : null;
    return section(
      "Selection",
      h("p", { class: "mono" }, selected),
      module !== null
        ? button("expand this module", () => store.toggleIn("collapsedModules", module))
        : null,
    );
  }

  const focused = state.focus === node.id;

  return section(
    "Selection",
    h("p", { class: "mono strong" }, node.name),
    h("p", { class: "hint" }, `${KIND_LABELS[node.kind]} in ${node.module || "the crate root"}`),
    node.owner ? h("p", { class: "hint mono" }, node.owner) : null,
    node.signature ? h("pre", { class: "signature" }, node.signature) : null,
    ...docLines(node),
    h("p", { class: "hint mono" }, `${node.file}:${node.line}`),
    h(
      "div",
      { class: "row-actions" },
      button(
        focused ? "clear focus" : "focus",
        () => store.update({ focus: focused ? null : node.id, solo: null }),
        "keep only what this artifact reaches",
      ),
      button("hide", () => store.toggleIn("hidden", node.id), "take it out of the picture"),
      button(
        "study module",
        () => store.update({ solo: node.module, focus: null }),
        `study ${node.module || "the crate root"} on its own`,
      ),
    ),
    ...neighbourLines(graph, node),
  );
}
