// The module tree: switch a module off, collapse it into one box, study one
// module on its own, or fold its row away in this list.
//
// Switching a module off switches off everything inside it, so a parent whose
// children are only partly switched off shows the third checkbox state rather
// than claiming to be fully on.
//
// Folding is display-only — it never touches the diagram, so it lives in a
// set the caller owns rather than in filter state: nothing about which rows
// are expanded belongs in a shared link.

import { button, h, section } from "../dom.js";
import { isUnder, moduleTree } from "../model.js";
import { hideModule, isHidden, isPartlyHidden, showModule, showSubtree } from "../modules.js";

/**
 * @param {import("../model.js").Graph} graph
 * @param {string} module
 */
function nodeCount(graph, module) {
  return graph.nodes.filter((node) => isUnder(node.module, module)).length;
}

/** @param {string} module */
function depthOf(module) {
  return module === "" ? 0 : module.split("::").length;
}

/**
 * The guide columns each row draws to its left, one per ancestor.
 *
 * A tree is read down its lines, so they have to say something: a column is
 * drawn where the subtree it belongs to still has rows below this one, and
 * left blank where it does not — otherwise every line runs to the bottom of
 * the list and none of them marks where a subtree ends. The row's own column
 * turns at it: a tee where more siblings follow, an elbow on the last one.
 *
 * The rows are in sorted order, so a subtree is contiguous and one pass from
 * the bottom is enough: `more[d]` says whether a row at depth `d` is still to
 * come inside the subtree being walked out of.
 *
 * @param {string[]} visible modules with a row, in the order they are drawn
 * @returns {("line"|"blank"|"tee"|"elbow")[][]}
 */
function guideColumns(visible) {
  const out = /** @type {("line"|"blank"|"tee"|"elbow")[][]} */ (new Array(visible.length));
  /** @type {boolean[]} */
  const more = [];
  for (let i = visible.length - 1; i >= 0; i--) {
    const depth = depthOf(visible[i]);
    const columns = /** @type {("line"|"blank"|"tee"|"elbow")[]} */ ([]);
    for (let column = 1; column < depth; column++) {
      columns.push(more[column] ? "line" : "blank");
    }
    if (depth > 0) columns.push(more[depth] ? "tee" : "elbow");
    out[i] = columns;
    // This row ends every subtree that was open below it, and starts one of
    // its own for the rows above.
    more.length = depth + 1;
    more[depth] = true;
  }
  return out;
}

/**
 * @param {import("../state.js").Store} store
 * @param {import("../model.js").Graph} graph
 * @param {Set<string>} folded modules whose rows are collapsed away
 * @param {(module: string) => void} onToggleFold
 */
export function modulePanel(store, graph, folded, onToggleFold) {
  const state = store.get();
  const modules = moduleTree(graph.nodes);
  const hasChildren = (module) =>
    modules.some((candidate) => candidate !== module && isUnder(candidate, module));

  // Sorted order keeps a subtree contiguous, so a folded ancestor's
  // descendants can be skipped just by tracking the one we are inside.
  const visible = [];
  let hideUnder = /** @type {string|null} */ (null);
  for (const module of modules) {
    if (hideUnder !== null) {
      if (isUnder(module, hideUnder)) continue;
      hideUnder = null;
    }
    visible.push(module);
    if (folded.has(module)) hideUnder = module;
  }
  const guides = guideColumns(visible);

  const rows = visible.map((module, index) => {
    const name = module === "" ? "crate root" : module.split("::").pop();
    const hidden = isHidden(module, state.hiddenModules);
    const partial = isPartlyHidden(module, state.hiddenModules);
    const collapsed = state.collapsedModules.includes(module);
    const solo = state.solo === module;
    const branches = hasChildren(module);
    const isFolded = folded.has(module);

    const box = h("input", {
      type: "checkbox",
      checked: !hidden,
      title: partial
        ? "some of what is inside is switched off — tick to bring it all back"
        : "show this module",
      onchange: () => {
        // Standard third-state behaviour: a partly-off parent turns fully on.
        if (partial) {
          store.update({ hiddenModules: showSubtree(module, state.hiddenModules) });
        } else if (hidden) {
          store.update({ hiddenModules: showModule(module, state.hiddenModules, modules) });
        } else {
          store.update({ hiddenModules: hideModule(module, state.hiddenModules) });
        }
      },
    });
    box.indeterminate = partial;

    const classes = ["module-row"];
    if (solo) classes.push("solo");
    if (hidden) classes.push("off");
    if (collapsed) classes.push("boxed");
    // Rows follow that hang off this one's caret, so the caret has a line to
    // grow out of.
    if (branches && !isFolded) classes.push("expanded");

    return h(
      "div",
      { class: classes.join(" ") },
      h(
        "span",
        { class: "indent" },
        // A guide column is as wide as a caret and lines up with one, so the
        // line a child hangs from descends from its parent's own caret.
        ...guides[index].map((shape) => h("span", { class: `guide ${shape}` })),
        branches
          ? h(
              "button",
              {
                type: "button",
                class: `twisty${isFolded ? " folded" : ""}`,
                onclick: () => onToggleFold(module),
                title: isFolded ? "expand this module's rows" : "collapse this module's rows",
              },
              "▾",
            )
          : h("span", { class: "twisty" }),
      ),
      box,
      h("span", { class: "module-name", title: module || "crate root" }, name),
      h("span", { class: "module-count" }, String(nodeCount(graph, module))),
      h(
        "span",
        { class: "row-tools" },
        button(
          collapsed ? "▣" : "▢",
          () => store.toggleIn("collapsedModules", module),
          collapsed ? "expand back into individual artifacts" : "collapse into one box",
        ),
        button(
          solo ? "◉" : "○",
          () => store.update({ solo: solo ? null : module, focus: null }),
          solo ? "stop studying this module on its own" : "study only this module",
        ),
      ),
    );
  });

  return section(
    "Modules",
    state.solo !== null
      ? h(
          "p",
          { class: "hint" },
          `Showing ${state.solo || "the crate root"} and what it reaches in ` +
            `${state.depth} hop${state.depth === 1 ? "" : "s"}. Targets defined elsewhere ` +
            `are drawn inside their own module.`,
        )
      : null,
    h("div", { class: "module-tree" }, ...rows),
    state.hiddenModules.length > 0
      ? button("show every module", () => store.update({ hiddenModules: [] }))
      : null,
  );
}
