// The filtered view, rendered as a PlantUML class diagram.
//
// The same errand as `dot.js` against a language that draws less, so what the
// drawing says with shape has to be said some other way here:
//
//   * PlantUML has no ports. An edge that left a struct's field row leaves the
//     struct itself, and carries that field's name as its label — the only
//     place the information can still go.
//   * It has no arrowhead vocabulary to spend on seven relations. So every
//     arrow is drawn alike and the relation is the colour — the reader's own
//     colour, the one on the screen — with a word on the line to name it,
//     because a colour with no legend beside it names nothing.
//   * A class body ends at a `}`, which an enum's `Restore { resource: Key }`
//     would end early, so a variant's payload is shown in parentheses.
//
// Nested module packages, impl-block grouping, member rows, both palettes and
// every colour the reader picked survive as they are. Nothing here is dated or
// randomised: the same view exported twice is the same bytes, so a `.puml`
// committed beside a design note has a diff worth reading.

import { DIAGRAM_CHROME, edgeColor } from "./appearance.js";
import { buildTree, sanitize } from "./tree.js";

/** The element a kind is declared as; everything else is a plain `class`. */
const KEYWORDS = { enum: "enum", trait: "interface" };

/** The «guillemets» under a name, which is how a kind reads once `hide circle`
 *  has taken PlantUML's own C/E/I badge off the corner. */
const STEREOTYPES = {
  struct: "struct",
  enum: "enum",
  trait: "trait",
  type_alias: "type alias",
  const: "const",
  fn: "fn",
  inherent_method: "inherent method",
  trait_method: "trait method",
  impl_method: "impl method",
  module: "module",
};

/** The word an arrow carries, standing in for the arrowhead it cannot have. */
const REL_WORDS = {
  field: "field",
  param: "param",
  return: "returns",
  impls: "implements",
  supertrait: "supertrait",
  bound: "bound",
  call: "calls",
};

/** PlantUML's line styles, by the name `viaStyles` gives them. `solid` is the
 *  default and has no keyword of its own. */
const LINE_STYLES = { dashed: "dashed", dotted: "dotted", bold: "bold" };

/** Text going inside a `"…"` name, which cannot hold a quote of its own. */
function quote(text) {
  return text.replace(/"/g, "'");
}

/**
 * A member row PlantUML will keep in one piece.
 *
 * The braces are the whole problem: a line of a class body that holds a `}`
 * risks ending the body there, and an enum's struct-variant payload is written
 * with them. Parentheses say the same thing and cannot close anything. The
 * `{field}` in front is what stops `Restore(resource: Key)` from being filed
 * as a method for having parentheses in it.
 *
 * @param {string} label
 */
function memberLine(label) {
  return `{field} ${label.replace(/\{\s*/g, "(").replace(/\s*\}/g, ")")}`;
}

/**
 * The name of the field an edge left, for the label that replaces the port.
 *
 * Member labels are `key: Key`, `.0: Key`, `Unit`, `Wrap(Key)` or
 * `Restore { resource: Key }`, and the leading run of every one of them is the
 * name — the rest is the type, which the arrow already points at.
 *
 * @param {string} label
 */
function memberName(label) {
  return /^[.\w]+/.exec(label)?.[0] ?? label;
}

/**
 * Short, unique, readable names for the elements, so the arrows at the bottom
 * of the file can be read on their own.
 *
 * Sanitizing a node id can collide — `<Foo as Bar>::f` and `_Foo_as_Bar___f`
 * both flatten the same way — so a repeat gets a number, and everything gets a
 * prefix: a module called `class` or `note` would otherwise alias an element to
 * a PlantUML keyword.
 *
 * @param {import("./filter.js").ViewNode[]} nodes
 * @returns {Map<string, string>}
 */
function aliases(nodes) {
  /** @type {Map<string, string>} */
  const byId = new Map();
  /** @type {Set<string>} */
  const taken = new Set();
  for (const node of nodes) {
    const base = `n_${sanitize(node.id)}`;
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}_${n}`;
    taken.add(alias);
    byId.set(node.id, alias);
  }
  return byId;
}

/**
 * @param {import("./filter.js").ViewNode} node
 * @param {string} alias
 * @param {boolean} showMembers
 * @param {import("./appearance.js").Appearance} look
 * @param {import("./theme.js").Theme} theme
 * @param {string} indent
 */
function renderNode(node, alias, showMembers, look, theme, indent) {
  const keyword = KEYWORDS[node.kind] ?? "class";
  const stereotype = STEREOTYPES[node.kind] ?? node.kind;
  const fill = look.nodeColors[node.kind] ?? DIAGRAM_CHROME[theme].depthFills[1];
  // A collapsed module stands for what is inside it, and the count is the
  // whole point of it — the drawing puts it on a second line of the label.
  const name = node.kind === "module" ? `${node.name} (${node.contains ?? 0} items)` : node.name;
  const head = `${indent}${keyword} "${quote(name)}" as ${alias} <<${stereotype}>> ${fill}`;

  const members = showMembers ? node.members : [];
  if (members.length === 0) return `${head}\n`;
  return (
    `${head} {\n` +
    members.map((member) => `${indent}  ${memberLine(member.label)}\n`).join("") +
    `${indent}}\n`
  );
}

/**
 * @param {import("./tree.js").ModuleTree} tree
 * @param {string[]} path
 * @param {Map<string, string>} alias
 * @param {boolean} showMembers
 * @param {import("./appearance.js").Appearance} look
 * @param {import("./theme.js").Theme} theme
 * @param {number} depth
 */
function renderModule(tree, path, alias, showMembers, look, theme, depth) {
  const chrome = DIAGRAM_CHROME[theme];
  // `depth` counts module levels and picks the fill, so the crate root is 0 and
  // the outermost package is 1; the indent has to start one step behind it, or
  // a top-level package would be further in than the artifacts beside it.
  const indent = "  ".repeat(Math.max(depth - 1, 0));
  const inPackage = path.length > 0;
  let out = "";

  if (inPackage) {
    const fill = chrome.depthFills[Math.min(depth, chrome.depthFills.length - 1)];
    out += `${indent}package "${quote(path.join("::"))}" ${fill} {\n`;
  }

  const body = inPackage ? `${indent}  ` : indent;

  for (const node of tree.loose) {
    out += renderNode(node, alias.get(node.id), showMembers, look, theme, body);
  }

  for (const [group, members] of [...tree.groups].sort(([a], [b]) => a.localeCompare(b))) {
    // A package is named by its label and there is no aliasing it, so the label
    // has to be the unique one: two modules that both define an `Error` both
    // have an `impl Error`, and named alike they would be one box holding the
    // methods of both. The module in front is what the drawing's own nested
    // labels do anyway.
    const label = path.length > 0 ? `${path.join("::")}::${group}` : group;
    out += `${body}package "${quote(label)}" <<Rectangle>> ${chrome.groupFill} {\n`;
    for (const node of members) {
      out += renderNode(node, alias.get(node.id), showMembers, look, theme, body + "  ");
    }
    out += `${body}}\n`;
  }

  for (const [name, child] of [...tree.children].sort(([a], [b]) => a.localeCompare(b))) {
    out += renderModule(child, [...path, name], alias, showMembers, look, theme, depth + 1);
  }

  if (inPackage) out += `${indent}}\n`;
  return out;
}

/**
 * @param {import("./filter.js").ViewEdge} edge
 * @param {Map<string, string>} alias
 * @param {Map<string, string>} fieldNames port keys to the member's name
 * @param {import("./appearance.js").Appearance} look
 * @param {import("./theme.js").Theme} theme
 */
function renderEdge(edge, alias, fieldNames, look, theme) {
  const color = edgeColor(look, edge, theme);
  const style = LINE_STYLES[look.viaStyles[edge.via]];
  const spec = style ? `[${color},${style}]` : `[${color}]`;

  const field = edge.fromPort ? fieldNames.get(`${edge.from} ${edge.fromPort}`) : undefined;
  const labels = [field ?? REL_WORDS[edge.rel] ?? edge.rel];
  if (edge.count > 1) labels.push(`×${edge.count}`);
  // The same mark the drawing uses: a guess should read as a guess here too.
  if (edge.ambiguous) labels.push("?");

  return `${alias.get(edge.from)} -${spec}-> ${alias.get(edge.to)} : ${labels.join(" ")}\n`;
}

/**
 * @param {import("./filter.js").View} view
 * @param {import("./state.js").FilterState} state
 * @param {import("./appearance.js").Appearance} look
 * @param {import("./theme.js").Theme} theme
 * @param {string} crate
 */
export function toPlantUml(view, state, look, theme, crate) {
  const chrome = DIAGRAM_CHROME[theme];
  const alias = aliases(view.nodes);

  /** @type {Map<string, string>} */
  const fieldNames = new Map();
  for (const node of view.nodes) {
    for (const member of node.members) {
      fieldNames.set(`${node.id} ${member.port}`, memberName(member.label));
    }
  }

  let out = "@startuml\n";
  out += `' ${crate}, as filtered in cargo-portray\n`;
  // The direction the reader chose, and the sheet they read it on: an export
  // taken off the dark page is a dark diagram wherever it is opened next.
  out += state.rankdir === "LR" ? "left to right direction\n" : "top to bottom direction\n";
  out += `skinparam backgroundColor ${chrome.bg}\n`;
  out += "skinparam defaultFontName sans-serif\n";
  out += "skinparam defaultFontSize 11\n";
  out += "skinparam shadowing false\n";
  out += "skinparam ArrowFontSize 9\n";
  out += `skinparam ArrowFontColor ${chrome.ink}\n`;
  out += `skinparam ClassFontColor ${chrome.ink}\n`;
  out += `skinparam ClassAttributeFontColor ${chrome.ink}\n`;
  out += `skinparam ClassBorderColor ${chrome.nodeLine}\n`;
  out += `skinparam PackageFontColor ${chrome.ink}\n`;
  out += `skinparam PackageBorderColor ${chrome.clusterLine}\n`;
  // The badge is the kind, and the stereotype already said it; the empty
  // compartments are what a diagram with member rows switched off is made of.
  out += "hide circle\n";
  out += "hide empty members\n\n";

  out += renderModule(buildTree(view.nodes), [], alias, state.showMembers, look, theme, 0);

  out += "\n";
  for (const edge of view.edges) {
    out += renderEdge(edge, alias, fieldNames, look, theme);
  }
  out += "@enduml\n";
  return out;
}
