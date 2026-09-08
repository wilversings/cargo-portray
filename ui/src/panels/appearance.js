// Colours and line styles, picked by the user.
//
// Two axes, matching the model: the *relation* an edge stands for gets a
// colour and an arrowhead, and how the type was *reached* gets the line
// style. Keeping them separate is what lets a dashed orange line mean
// "implements, as a template argument" without either axis overwriting the
// other.
//
// Giving every edge its own colour instead is the one setting that says
// nothing about the model: it is there for the crowded case, where a dozen
// edges run down the same channel and the only question is which line is
// which.

import { button, colorInput, h, section, select } from "../dom.js";
import { ARROWHEADS, COLOURABLE_KINDS, LINE_STYLES } from "../appearance.js";
import { KIND_LABELS, REL_LABELS, RELS, VIA_LABELS, VIAS } from "../model.js";

/**
 * @param {import("../appearance.js").Appearance} look
 * @param {(change: Partial<import("../appearance.js").Appearance>) => void} onChange
 * @param {() => void} onReset
 */
export function appearancePanel(look, onChange, onReset) {
  const kindRows = COLOURABLE_KINDS.map((kind) =>
    h(
      "div",
      { class: "look-row" },
      colorInput(look.nodeColors[kind], (color) =>
        onChange({ nodeColors: { ...look.nodeColors, [kind]: color } }),
      ),
      h("span", { class: "look-label" }, kind === "module" ? "collapsed module" : KIND_LABELS[kind]),
    ),
  );

  const relRows = RELS.map((rel) =>
    h(
      "div",
      { class: "look-row" },
      colorInput(look.edges[rel].color, (color) =>
        onChange({ edges: { ...look.edges, [rel]: { ...look.edges[rel], color } } }),
      ),
      h("span", { class: "look-label" }, REL_LABELS[rel]),
      select(look.edges[rel].arrowhead, ARROWHEADS, (arrowhead) =>
        onChange({ edges: { ...look.edges, [rel]: { ...look.edges[rel], arrowhead } } }),
      ),
    ),
  );

  const viaRows = VIAS.map((via) =>
    h(
      "div",
      { class: "look-row" },
      h("span", { class: "look-label" }, VIA_LABELS[via]),
      select(look.viaStyles[via], LINE_STYLES, (style) =>
        onChange({ viaStyles: { ...look.viaStyles, [via]: style } }),
      ),
    ),
  );

  const modes = [
    { value: "relation", label: "by what it is" },
    { value: "random", label: "one per edge" },
  ];

  return section(
    "Appearance",
    h("h3", {}, "artifact colours"),
    ...kindRows,
    h("h3", {}, "edge colour and arrowhead"),
    h(
      "label",
      { class: "field" },
      h("span", {}, "colour"),
      h(
        "select",
        { onchange: (event) => onChange({ edgeColors: event.target.value }) },
        ...modes.map((mode) =>
          h(
            "option",
            { value: mode.value, selected: look.edgeColors === mode.value },
            mode.label,
          ),
        ),
      ),
    ),
    ...relRows,
    look.edgeColors === "random" &&
      h(
        "p",
        { class: "hint" },
        "Every edge has its own colour, so the colours above are not in use — " +
          "the arrowheads and line styles still say what each edge is.",
      ),
    h("h3", {}, "line style, by how the type was reached"),
    ...viaRows,
    h("div", { class: "row-actions" }, button("reset to defaults", onReset)),
    h(
      "p",
      { class: "hint" },
      "Kept in this browser, one set per theme, and never in the shareable link.",
    ),
  );
}
