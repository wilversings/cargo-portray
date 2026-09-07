// Colours and line styles, picked by the user.
//
// Two axes, matching the model: the *relation* an edge stands for gets a
// colour and an arrowhead, and how the type was *reached* gets the line
// style. Keeping them separate is what lets a dashed orange line mean
// "implements, as a template argument" without either axis overwriting the
// other.
//
// The two controls that are not colours are here for the same reason a colour
// is: giving every edge its own colour, and dimming everything the pointer is
// not on, both answer "which line is which" in a crowded drawing without
// changing which artifacts are in it.

import { button, checkbox, colorInput, h, section, select } from "../dom.js";
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
    h("h3", {}, "under the pointer"),
    checkbox("dim everything but what is hovered", look.hoverTrace, (checked) =>
      onChange({ hoverTrace: checked }),
    ),
    h("div", { class: "row-actions" }, button("reset to defaults", onReset)),
    h("p", { class: "hint" }, "Kept in this browser, not in the shareable link."),
  );
}
