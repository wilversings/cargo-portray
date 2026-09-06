// The module tree: switch a module off, collapse it into one box, or study
// one module on its own.
//
// Switching a module off switches off everything inside it, so a parent whose
// children are only partly switched off shows the third checkbox state rather
// than claiming to be fully on.

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
 */
export function modulePanel(store, graph) {
  const state = store.get();
  const modules = moduleTree(graph.nodes);

  const rows = modules.map((module) => {
    const depth = module === "" ? 0 : module.split("::").length;
    const name = module === "" ? "crate root" : module.split("::").pop();
    const hidden = isHidden(module, state.hiddenModules);
    const partial = isPartlyHidden(module, state.hiddenModules);
    const collapsed = state.collapsedModules.includes(module);
    const solo = state.solo === module;

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

    return h(
      "div",
      { class: `module-row${solo ? " solo" : ""}${hidden ? " off" : ""}` },
      h("span", { class: "indent", style: `width:${depth * 12}px` }),
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
