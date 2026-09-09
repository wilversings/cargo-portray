// The filtered view, grouped the way both drawings group it.
//
// Nested module boxes, one sub-box per impl block or trait, artifacts inside:
// that shape belongs to the view rather than to any one output format, so it is
// built once here and walked twice — by `dot.js` in Graphviz's terms and by
// `plantuml.js` in PlantUML's. Nothing in here knows about either.

/**
 * @typedef {{ children: Map<string, ModuleTree>,
 *   loose: import("./filter.js").ViewNode[],
 *   groups: Map<string, import("./filter.js").ViewNode[]> }} ModuleTree
 * @returns {ModuleTree}
 */
function emptyTree() {
  return { children: new Map(), loose: [], groups: new Map() };
}

/** @param {ModuleTree} root @param {string} module */
function entryFor(root, module) {
  if (module === "") return root;
  let current = root;
  for (const part of module.split("::")) {
    if (!current.children.has(part)) current.children.set(part, emptyTree());
    current = current.children.get(part);
  }
  return current;
}

/**
 * The view as a tree of modules, each holding the artifacts that sit loose in
 * it and the ones grouped under an `impl` block or a trait.
 *
 * @param {import("./filter.js").ViewNode[]} nodes
 * @returns {ModuleTree}
 */
export function buildTree(nodes) {
  const root = emptyTree();
  for (const node of nodes) {
    const module = entryFor(root, node.module);
    if (node.owner) {
      if (!module.groups.has(node.owner)) module.groups.set(node.owner, []);
      module.groups.get(node.owner).push(node);
    } else {
      module.loose.push(node);
    }
  }
  return root;
}

/**
 * An identifier with everything a diagram language might read as syntax taken
 * out of it. Node ids are Rust paths — `::`, `<`, `>`, spaces and all — and no
 * format here accepts one as a name.
 *
 * @param {string} text
 */
export function sanitize(text) {
  return text.replace(/[^A-Za-z0-9]/g, "_");
}
