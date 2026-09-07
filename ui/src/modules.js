// Tree logic for the module checkboxes.
//
// `hiddenModules` holds only the roots of what is switched off: hiding
// `actions` implies its children without listing them. That keeps the URL
// short, but it means the checkbox states have to be derived rather than read
// straight off the list, and that turning one child back on has to rewrite
// the ancestor entry into its siblings.

import { isUnder, parentModule } from "./model.js";

/**
 * @param {string} module
 * @param {string[]} hiddenModules
 */
export function isHidden(module, hiddenModules) {
  return hiddenModules.some((hidden) => isUnder(module, hidden));
}

/**
 * True when the module itself is on but something inside it is off — the
 * third checkbox state.
 * @param {string} module
 * @param {string[]} hiddenModules
 */
export function isPartlyHidden(module, hiddenModules) {
  if (isHidden(module, hiddenModules)) return false;
  return hiddenModules.some((hidden) => hidden !== module && isUnder(hidden, module));
}

/** @param {string} module @param {string[]} allModules */
function directChildren(module, allModules) {
  return allModules.filter((candidate) => candidate !== "" && parentModule(candidate) === module);
}

/** Every module from `ancestor` down to `module`, both ends included. */
function pathDown(ancestor, module) {
  if (ancestor === module) return [module];
  const rest = ancestor === "" ? module : module.slice(ancestor.length + 2);
  const steps = rest.split("::");
  const path = [ancestor];
  let current = ancestor;
  for (const step of steps) {
    current = current === "" ? step : `${current}::${step}`;
    path.push(current);
  }
  return path;
}

/**
 * Switching a module off subsumes anything already off inside it.
 * @param {string} module
 * @param {string[]} hiddenModules
 */
export function hideModule(module, hiddenModules) {
  return [...hiddenModules.filter((hidden) => !isUnder(hidden, module)), module];
}

/**
 * Switching a module back on has to unpick any ancestor that was hiding it:
 * the ancestor entry is replaced by its own children, minus the branch
 * leading down to `module`, so the rest of the tree stays as the user left it.
 * @param {string} module
 * @param {string[]} hiddenModules
 * @param {string[]} allModules
 */
export function showModule(module, hiddenModules, allModules) {
  let hidden = hiddenModules.filter((entry) => entry !== module);

  for (const ancestor of hidden.filter((entry) => isUnder(module, entry))) {
    hidden = hidden.filter((entry) => entry !== ancestor);
    const path = pathDown(ancestor, module);
    for (const step of path) {
      for (const child of directChildren(step, allModules)) {
        if (!path.includes(child) && !isUnder(child, module)) hidden.push(child);
      }
    }
  }

  return [...new Set(hidden)];
}

/**
 * Clearing the third state: everything under `module` comes back on.
 * @param {string} module
 * @param {string[]} hiddenModules
 */
export function showSubtree(module, hiddenModules) {
  return hiddenModules.filter((hidden) => !isUnder(hidden, module));
}

/**
 * The rows a search box leaves in the tree: every module whose path holds
 * `query`, plus the ancestors those hang from.
 *
 * The whole path is searched rather than the last segment, so `extract`
 * brings `extract::calls` with it — a subtree arrives whole, the way you
 * asked for it. The ancestors come along because a match shown without them
 * is a flat list, and the point of the tree is where a module sits.
 *
 * @param {string[]} modules every module in the tree
 * @param {string} query
 * @returns {{ matched: Set<string>, shown: Set<string> }}
 */
export function searchModules(modules, query) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { matched: new Set(modules), shown: new Set(modules) };

  const matched = new Set(modules.filter((module) => module.toLowerCase().includes(needle)));
  const shown = new Set(matched);
  for (const module of matched) {
    let ancestor = module;
    while (ancestor !== "") {
      ancestor = parentModule(ancestor);
      shown.add(ancestor);
    }
  }
  return { matched, shown };
}
