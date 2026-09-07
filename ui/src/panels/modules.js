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

  const rows = [];
  // Sorted order keeps a subtree contiguous, so a folded ancestor's
  // descendants can be skipped just by tracking the one we are inside.
  let hideUnder = /** @type {string|null} */ (null);
  for (const module of modules) {
    if (hideUnder !== null) {
      if (isUnder(module, hideUnder)) continue;
      hideUnder = null;
    }

    const depth = module === "" ? 0 : module.split("::").length;
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

    rows.push(
      h(
        "div",
        { class: `module-row${solo ? " solo" : ""}${hidden ? " off" : ""}` },
        h(
          "span",
          { class: "indent" },
          // Same width as a guide column and flush against it, so this row's
          // own caret lands exactly where a child's guide line will run.
          ...Array.from({ length: depth }, () => h("span", { class: "guide" })),
          branches
            ? h(
                "button",
                {
                  type: "button",
                  class: "twisty",
                  onclick: () => onToggleFold(module),
                  title: isFolded ? "expand this module's rows" : "collapse this module's rows",
                },
                isFolded ? "▸" : "▾",
              )
            : h("span", { class: "twisty" }),
        ),
        box,
        h("span", { class: "module-name", title: module || "crate root" }, name),
        h("span", { class: "module-count" }, String(nodeCount(graph, module))),
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

    if (isFolded) hideUnder = module;
  }

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
