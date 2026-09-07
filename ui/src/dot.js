// The filtered view, rendered as DOT.
//
// Ported from the standalone generator this tool replaces, so the drawing
// keeps what worked there: nested module clusters, one sub-cluster per impl
// block or trait, struct fields as table rows, and edges that leave from the
// exact field that creates the dependency.

import { edgeColor, lighten } from "./appearance.js";

/** @param {string} text */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {string} id */
function escapeId(id) {
  return id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** @param {string} text */
function sanitize(text) {
  return text.replace(/[^A-Za-z0-9]/g, "_");
}

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

/** Backgrounds cycled by nesting depth so nested modules stay separable. */
const DEPTH_FILLS = ["#f7f7f9", "#eef1f6", "#e6ebf3", "#dfe6f0"];

/** Kinds drawn as a table with a header row and one row per member. */
const TABLE_KINDS = new Set(["struct", "enum", "trait", "type_alias"]);

/** Must match the `fontname`/`fontsize` set on nodes below, or the measuring
 *  under it is measuring the wrong thing. */
const FONT_STACK = "sans-serif";
const FONT_SIZE = 10;
const CELL_PADDING = 4;

/** @type {CanvasRenderingContext2D|false|null} */
let measuringContext = null;

/**
 * Width of a run of text, in points, as the browser will actually draw it.
 *
 * Graphviz compiled to WebAssembly has no fontconfig and no system fonts, so
 * it falls back to a crude built-in estimate of how wide text is. That
 * estimate is too small for `sans-serif`, which is why cells came out
 * narrower than their contents and long member names spilled out of the box.
 * Measuring here and handing Graphviz an explicit cell width takes its guess
 * out of the loop.
 *
 * A canvas measured at N *pixels* gives exactly the advance in *points* for
 * text drawn at N points, because the 4/3 px-per-pt conversion cancels.
 *
 * @param {string} text
 * @param {boolean} bold
 */
function textWidth(text, bold) {
  if (measuringContext === null) {
    measuringContext =
      typeof document === "undefined"
        ? false
        : (document.createElement("canvas").getContext("2d") ?? false);
  }
  if (!measuringContext) return text.length * 5.6; // headless: a rough stand-in
  measuringContext.font = `${bold ? "bold " : ""}${FONT_SIZE}px ${FONT_STACK}`;
  return measuringContext.measureText(text).width;
}

/** @param {string} text @param {boolean} bold */
function cellWidth(text, bold) {
  return Math.ceil(textWidth(text, bold) + CELL_PADDING * 2 + 2);
}

/** @param {import("./filter.js").ViewNode} node */
function keywordFor(node) {
  return node.kind === "type_alias" ? "type" : node.kind;
}

/**
 * @param {import("./filter.js").ViewNode} node
 * @param {boolean} showMembers
 * @param {import("./appearance.js").Appearance} look
 * @param {string} indent
 */
function renderTableNode(node, showMembers, look, indent) {
  const headerBg = look.nodeColors[node.kind] ?? "#eeeeee";
  const bodyBg = lighten(headerBg, 0.72);

  const members = showMembers ? node.members : [];

  // One text run, not `<b>struct</b> Name`: Graphviz positions each run from
  // its own font metrics, and with those metrics wrong the second run landed
  // on top of the first — that is what ran `struct` into the type name.
  const header = `${keywordFor(node)} ${node.name}`;

  // Spare width in a row is shared out among that row's cells, so every row is
  // asked for the same total: the widest one decides, and none of the others
  // has to guess.
  const rowWidth = Math.max(
    cellWidth(header, true),
    ...members.map((member) => cellWidth(member.label, false)),
  );

  const rows = [
    `<tr><td bgcolor="${headerBg}" align="left" width="${rowWidth}">` +
      `<b>${escapeHtml(header)}</b></td></tr>`,
  ];
  for (const member of members) {
    rows.push(
      `<tr><td port="${member.port}" bgcolor="${bodyBg}" align="left" ` +
        `width="${rowWidth}">${escapeHtml(member.label)}</td></tr>`,
    );
  }

  const label =
    `<table border="0" cellborder="1" cellspacing="0" cellpadding="4" ` +
    `bgcolor="#ffffff">${rows.join("")}</table>`;
  return `${indent}"${escapeId(node.id)}" [shape=plain, label=<${label}>];\n`;
}

/**
 * @param {import("./filter.js").ViewNode} node
 * @param {import("./appearance.js").Appearance} look
 * @param {string} indent
 */
function renderPlainNode(node, look, indent) {
  const fill = look.nodeColors[node.kind] ?? "#d9ead3";
  if (node.kind === "module") {
    const count = `${node.contains ?? 0} items`;
    const widest = Math.max(textWidth(node.name, false), textWidth(count, false));
    return (
      `${indent}"${escapeId(node.id)}" [label="${node.name}\\n${count}", shape=box3d, ` +
      `style=filled, fillcolor="${fill}", penwidth=1.6, ` +
      `width=${((widest + 24) / 72).toFixed(3)}];\n`
    );
  }
  const shape = node.kind === "const" ? "note" : "ellipse";
  // An ellipse needs to be wider than its text to contain it; a note is a box
  // and only needs the padding. Either way the width is a minimum, computed
  // here rather than left to Graphviz's font-metric guess.
  const slack = shape === "ellipse" ? 1.5 : 1;
  const width = (textWidth(node.name, false) * slack + 16) / 72;
  return (
    `${indent}"${escapeId(node.id)}" [label="${escapeHtml(node.name)}", shape=${shape}, ` +
    `style=filled, fillcolor="${fill}", width=${width.toFixed(3)}];\n`
  );
}

/**
 * @param {import("./filter.js").ViewNode} node
 * @param {boolean} showMembers
 * @param {import("./appearance.js").Appearance} look
 * @param {string} indent
 */
function renderNode(node, showMembers, look, indent) {
  return TABLE_KINDS.has(node.kind)
    ? renderTableNode(node, showMembers, look, indent)
    : renderPlainNode(node, look, indent);
}

/**
 * @param {ModuleTree} tree
 * @param {string[]} path
 * @param {boolean} showMembers
 * @param {import("./appearance.js").Appearance} look
 * @param {number} depth
 * @param {{ value: number }} counter
 */
function renderModule(tree, path, showMembers, look, depth, counter) {
  const indent = "  ".repeat(depth + 1);
  const inCluster = path.length > 0;
  let out = "";

  if (inCluster) {
    counter.value += 1;
    const id = `cluster_mod_${sanitize(path.join("_"))}_${counter.value}`;
    out += `${indent}subgraph ${id} {\n`;
    out += `${indent}  label="${escapeHtml(path.join("::"))}";\n`;
    out += `${indent}  style=filled; color="#b7bec9"; fillcolor="${
      DEPTH_FILLS[Math.min(depth, DEPTH_FILLS.length - 1)]
    }";\n`;
  }

  const body = "  ".repeat(depth + (inCluster ? 2 : 1));

  for (const node of tree.loose) {
    out += renderNode(node, showMembers, look, body);
  }

  for (const [group, members] of [...tree.groups].sort(([a], [b]) => a.localeCompare(b))) {
    counter.value += 1;
    const id = `cluster_grp_${sanitize(group)}_${counter.value}`;
    out += `${body}subgraph ${id} {\n`;
    out += `${body}  label="${escapeHtml(group)}";\n`;
    out += `${body}  style=filled; color="#9fb3c8"; fillcolor="#ffffff"; fontsize=11;\n`;
    for (const node of members) {
      out += renderNode(node, showMembers, look, body + "  ");
    }
    out += `${body}}\n`;
  }

  for (const [name, child] of [...tree.children].sort(([a], [b]) => a.localeCompare(b))) {
    out += renderModule(child, [...path, name], showMembers, look, depth + 1, counter);
  }

  if (inCluster) out += `${indent}}\n`;
  return out;
}

/**
 * @param {import("./filter.js").ViewEdge} edge
 * @param {number} index its position in the view, and its handle in the SVG
 * @param {Set<string>} portsDrawn
 * @param {import("./appearance.js").Appearance} look
 * @param {string} indent
 */
function renderEdge(edge, index, portsDrawn, look, indent) {
  const relLook = look.edges[edge.rel] ?? { color: "#333333", arrowhead: "normal" };
  const style = look.viaStyles[edge.via] ?? "solid";
  const color = edgeColor(look, edge);
  // Graphviz writes an edge's `<title>` as `tail->head` — but it drops the
  // port and keeps the compass point, and a Rust id is full of colons, so
  // that string cannot be parsed back into two node ids. An explicit `id`
  // comes through untouched, and `render.js` joins on the position instead.
  const attrs = [
    `id="edge_${index}"`,
    `color="${color}"`,
    `style=${style}`,
    `arrowhead=${relLook.arrowhead}`,
  ];

  const labels = [];
  if (edge.count > 1) labels.push(`×${edge.count}`);
  if (edge.ambiguous) labels.push("?");
  if (labels.length > 0) {
    attrs.push(`label="${labels.join(" ")}"`, `fontcolor="${color}"`);
  }
  if (edge.ambiguous) attrs.push("penwidth=0.7");

  const tail =
    edge.fromPort && portsDrawn.has(`${edge.from} ${edge.fromPort}`)
      ? `"${escapeId(edge.from)}":${edge.fromPort}:e`
      : `"${escapeId(edge.from)}"`;

  return `${indent}${tail} -> "${escapeId(edge.to)}" [${attrs.join(", ")}];\n`;
}

/**
 * @param {import("./filter.js").View} view
 * @param {import("./state.js").FilterState} state
 * @param {import("./appearance.js").Appearance} look
 */
export function toDot(view, state, look) {
  const root = emptyTree();
  for (const node of view.nodes) {
    const module = entryFor(root, node.module);
    if (node.owner) {
      if (!module.groups.has(node.owner)) module.groups.set(node.owner, []);
      module.groups.get(node.owner).push(node);
    } else {
      module.loose.push(node);
    }
  }

  // An edge may only use a port whose row is actually on the page.
  const portsDrawn = new Set();
  if (state.showMembers) {
    for (const node of view.nodes) {
      if (!TABLE_KINDS.has(node.kind)) continue;
      for (const member of node.members) portsDrawn.add(`${node.id} ${member.port}`);
    }
  }

  let out = "digraph portray {\n";
  out += `  rankdir=${state.rankdir};\n`;
  out += "  compound=true;\n";
  out += "  newrank=true;\n";
  out += '  graph [fontname="sans-serif", fontsize=13, labeljust="l"];\n';
  out += '  node  [fontname="sans-serif", fontsize=10];\n';
  out += '  edge  [fontname="sans-serif", fontsize=9];\n\n';

  out += renderModule(root, [], state.showMembers, look, 0, { value: 0 });

  out += "\n";
  view.edges.forEach((edge, index) => {
    out += renderEdge(edge, index, portsDrawn, look, "  ");
  });
  out += "}\n";
  return out;
}
