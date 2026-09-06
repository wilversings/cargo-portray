// Edge-type and artifact-type filters, plus the handful of drawing options
// that change what a diagram means rather than how it looks.

import { button, checkbox, h, section } from "../dom.js";
import {
  CALL_KINDS,
  KIND_LABELS,
  NODE_KINDS,
  REL_LABELS,
  RELS,
  VIA_LABELS,
  VIAS,
} from "../model.js";
import { defaultState } from "../state.js";

/**
 * @param {string[]} values
 * @param {string[]} keys
 */
function counts(values, keys) {
  /** @type {Record<string, number>} */
  const tally = {};
  for (const key of keys) tally[key] = 0;
  for (const value of values) tally[value] = (tally[value] ?? 0) + 1;
  return tally;
}

/**
 * @param {import("../state.js").Store} store
 * @param {"kinds"|"rels"|"vias"} key
 * @param {string[]} all
 */
function selectAll(store, key, all) {
  const allOn = store.get()[key].length === all.length;
  return button(
    allOn ? "none" : "all",
    () => store.update({ [key]: allOn ? [] : [...all] }),
    allOn ? "clear every box" : "tick every box",
  );
}

/**
 * The two diagrams this model can be read as.
 *
 * Artifact kinds and edge kinds have to move together to mean anything: a call
 * graph drawn over structs has nothing joining it, and a type graph with every
 * call in it is unreadable. So these set both at once, and are the answer to
 * "show me the call hierarchy" being a click rather than six.
 *
 * Calls start with the guesses off. A receiver's type is not knowable from
 * syntax, so most method calls resolve to every same-named method in the
 * crate; a first look at what calls what should show what is certain, with
 * the guesses one checkbox away.
 *
 * @param {import("../state.js").Store} store
 */
export function presetPanel(store) {
  const base = defaultState();
  return section(
    "Diagram",
    h(
      "div",
      { class: "row-actions" },
      button(
        "types",
        () => store.update({ kinds: base.kinds, rels: base.rels, ambiguous: base.ambiguous }),
        "what holds, implements and extends what",
      ),
      button(
        "calls",
        () => store.update({ kinds: [...CALL_KINDS], rels: ["call"], ambiguous: false }),
        "what runs what — functions and methods only, guesses off",
      ),
    ),
    h("p", { class: "hint" }, "Sets artifact and edge types together; adjust either below."),
  );
}

/**
 * @param {import("../state.js").Store} store
 * @param {import("../model.js").Graph} graph
 * @param {import("../appearance.js").Appearance} look
 */
export function relationPanel(store, graph, look) {
  const state = store.get();
  const byRel = counts(
    graph.edges.map((edge) => edge.rel),
    RELS,
  );
  const byVia = counts(
    graph.edges.map((edge) => edge.via),
    VIAS,
  );
  const ambiguousCount = graph.edges.filter((edge) => edge.ambiguous).length;

  return section(
    "Edge type",
    h("div", { class: "row-actions" }, selectAll(store, "rels", RELS)),
    ...RELS.map((rel) =>
      checkbox(
        `${REL_LABELS[rel]} (${byRel[rel] ?? 0})`,
        state.rels.includes(rel),
        () => store.toggleIn("rels", rel),
        look.edges[rel]?.color,
      ),
    ),
    h("h3", {}, "reached via"),
    ...VIAS.map((via) =>
      checkbox(`${VIA_LABELS[via]} (${byVia[via] ?? 0})`, state.vias.includes(via), () =>
        store.toggleIn("vias", via),
      ),
    ),
    ambiguousCount > 0
      ? checkbox(`unresolved guesses (${ambiguousCount})`, state.ambiguous, (checked) =>
          store.update({ ambiguous: checked }),
        )
      : h(
          "p",
          { class: "hint" },
          "Every name resolved to exactly one definition — no guesses in this graph.",
        ),
  );
}

/**
 * @param {import("../state.js").Store} store
 * @param {import("../model.js").Graph} graph
 * @param {import("../appearance.js").Appearance} look
 */
export function artifactPanel(store, graph, look) {
  const state = store.get();
  const byKind = counts(
    graph.nodes.map((node) => node.kind),
    NODE_KINDS,
  );
  return section(
    "Artifact type",
    h("div", { class: "row-actions" }, selectAll(store, "kinds", NODE_KINDS)),
    ...NODE_KINDS.map((kind) =>
      checkbox(
        `${KIND_LABELS[kind]} (${byKind[kind] ?? 0})`,
        state.kinds.includes(kind),
        () => store.toggleIn("kinds", kind),
        look.nodeColors[kind],
      ),
    ),
  );
}

const DIRECTIONS = [
  { value: "out", label: "depends on" },
  { value: "in", label: "depended on by" },
  { value: "both", label: "both" },
];

/** @param {import("../state.js").Store} store */
export function optionsPanel(store) {
  const state = store.get();
  return section(
    "Drawing",
    checkbox("struct fields and enum variants", state.showMembers, (checked) =>
      store.update({ showMembers: checked }),
    ),
    checkbox("documentation markers", state.showDocs, (checked) =>
      store.update({ showDocs: checked }),
    ),
    checkbox("artifacts with no visible edge", state.showOrphans, (checked) =>
      store.update({ showOrphans: checked }),
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, "layout"),
      h(
        "select",
        { onchange: (event) => store.update({ rankdir: event.target.value }) },
        h("option", { value: "LR", selected: state.rankdir === "LR" }, "left to right"),
        h("option", { value: "TB", selected: state.rankdir === "TB" }, "top to bottom"),
      ),
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, "follow"),
      h(
        "select",
        { onchange: (event) => store.update({ direction: event.target.value }) },
        ...DIRECTIONS.map((option) =>
          h(
            "option",
            { value: option.value, selected: state.direction === option.value },
            option.label,
          ),
        ),
      ),
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, `depth ${state.depth}`),
      h("input", {
        type: "range",
        min: "0",
        max: "5",
        value: String(state.depth),
        onchange: (event) => store.update({ depth: Number(event.target.value) }),
      }),
    ),
  );
}
