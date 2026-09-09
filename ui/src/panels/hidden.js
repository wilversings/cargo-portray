// Artifacts the user took out of the picture by hand, and the pattern that
// takes out a whole family of them at once.

import { button, h, section } from "../widgets/dom.js";

/**
 * @param {import("../data/state.js").Store} store
 * @param {import("../data/model.js").Graph} graph
 */
export function hiddenPanel(store, graph) {
  const state = store.get();

  /** @type {string|null} */
  let patternError = null;
  let patternMatches = 0;
  if (state.hidePattern.trim()) {
    try {
      const regex = new RegExp(state.hidePattern);
      patternMatches = graph.nodes.filter((node) => regex.test(node.id)).length;
    } catch (error) {
      patternError = error instanceof Error ? error.message : "invalid pattern";
    }
  }

  const rows = state.hidden.map((id) =>
    h(
      "div",
      { class: "hidden-row" },
      h("span", { class: "hidden-id", title: id }, id),
      button("×", () => store.toggleIn("hidden", id), "put it back"),
    ),
  );

  return section(
    `Hidden (${state.hidden.length})`,
    h(
      "label",
      { class: "field" },
      h("span", {}, "hide ids matching"),
      h("input", {
        type: "text",
        id: "hide-pattern",
        placeholder: "Error$",
        value: state.hidePattern,
        onchange: (event) => store.update({ hidePattern: event.target.value }),
      }),
    ),
    patternError
      ? h("p", { class: "hint error" }, patternError)
      : state.hidePattern.trim()
        ? h("p", { class: "hint" }, `${patternMatches} artifacts match`)
        : null,
    ...rows,
    state.hidden.length > 0 ? button("unhide all", () => store.update({ hidden: [] })) : null,
  );
}
