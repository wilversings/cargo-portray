// Mirrors src/model.rs. Keep the two in step: the JSON is the only contract
// between the extractor and this viewer.
//
// Plain ES modules with JSDoc types — no build step, so a TypeScript-aware
// editor still checks this while `cargo run` remains the only thing anyone
// needs installed.

/**
 * @typedef {"struct"|"enum"|"trait"|"type_alias"|"fn"|"inherent_method"
 *   |"trait_method"|"impl_method"|"const"} NodeKind
 * @typedef {"field"|"param"|"return"|"impls"|"supertrait"|"bound"|"call"} Rel
 * @typedef {"direct"|"generic"|"dyn"} Via
 * @typedef {{ port: string, label: string, docs: string|null }} Member
 * @typedef {{ id: string, kind: NodeKind, name: string, module: string,
 *   owner: string|null, file: string, line: number, visibility: string,
 *   members: Member[], signature: string|null, docs: string|null }} GraphNode
 * @typedef {{ from: string, fromPort: string|null, to: string, rel: Rel,
 *   via: Via, ambiguous: boolean }} GraphEdge
 * @typedef {{ crate: string, root: string, scope: string[],
 *   nodes: GraphNode[], edges: GraphEdge[] }} Graph
 */

/** @type {NodeKind[]} */
export const NODE_KINDS = [
  "struct",
  "enum",
  "trait",
  "type_alias",
  "const",
  "fn",
  "inherent_method",
  "trait_method",
  "impl_method",
];

/** @type {Record<NodeKind, string>} */
export const KIND_LABELS = {
  struct: "struct",
  enum: "enum",
  trait: "trait",
  type_alias: "type alias",
  const: "const / static",
  fn: "free function",
  inherent_method: "inherent method",
  trait_method: "trait method",
  impl_method: "impl method",
};

/** @type {Rel[]} */
export const RELS = ["field", "param", "return", "impls", "supertrait", "bound", "call"];

/** @type {Record<Rel, string>} */
export const REL_LABELS = {
  field: "struct member",
  param: "method argument",
  return: "return type",
  impls: "implements",
  supertrait: "supertrait",
  bound: "generic bound",
  call: "calls",
};

/**
 * The artifact kinds a call can run between. `CALL_KINDS` is what the call
 * hierarchy preset switches the diagram to: a call graph drawn over types is
 * mostly boxes with nothing joining them.
 * @type {NodeKind[]}
 */
export const CALL_KINDS = ["fn", "inherent_method", "trait_method", "impl_method"];

/** @type {Via[]} */
export const VIAS = ["direct", "generic", "dyn"];

/** @type {Record<Via, string>} */
export const VIA_LABELS = {
  direct: "named directly",
  generic: "template argument",
  dyn: "behind dyn / impl Trait",
};

/**
 * Every module that holds at least one node, plus every ancestor of one.
 * @param {GraphNode[]} nodes
 * @returns {string[]}
 */
export function moduleTree(nodes) {
  const modules = new Set([""]);
  for (const node of nodes) {
    const parts = node.module === "" ? [] : node.module.split("::");
    for (let i = 1; i <= parts.length; i++) {
      modules.add(parts.slice(0, i).join("::"));
    }
  }
  return [...modules].sort();
}

/**
 * True when `module` is `ancestor` or nested inside it.
 * @param {string} module
 * @param {string} ancestor
 */
export function isUnder(module, ancestor) {
  if (ancestor === "") return true;
  return module === ancestor || module.startsWith(ancestor + "::");
}

/**
 * The module one level up, or "" at the root.
 * @param {string} module
 */
export function parentModule(module) {
  const index = module.lastIndexOf("::");
  return index === -1 ? "" : module.slice(0, index);
}
