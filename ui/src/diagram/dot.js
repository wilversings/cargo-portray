// The filtered view, rendered as DOT.
//
// Ported from the standalone generator this tool replaces, so the drawing
// keeps what worked there: nested module clusters, one sub-cluster per impl
// block or trait, struct fields as table rows, and edges that leave from the
// exact field that creates the dependency.

import { DIAGRAM_CHROME, edgeColor, mix } from "./appearance.js";
import { buildTree, sanitize } from "./tree.js";

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

/** @param {import("../data/filter.js").ViewNode} node */
function keywordFor(node) {
  return node.kind === "type_alias" ? "type" : node.kind;
}

/**
 * @param {import("../data/filter.js").ViewNode} node
 * @param {boolean} showMembers
 * @param {import("./appearance.js").Appearance} look
 * @param {import("../widgets/theme.js").Theme} theme
 * @param {string} indent
 */
function renderTableNode(node, showMembers, look, theme, indent) {
  const chrome = DIAGRAM_CHROME[theme];
  const headerBg = look.nodeColors[node.kind] ?? chrome.depthFills[1];
  // Towards the sheet the table is on, not towards white: the rows have to
  // step *away* from the header in whichever direction the page runs.
  const bodyBg = mix(headerBg, chrome.table, 0.72);

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
    `bgcolor="${chrome.table}">${rows.join("")}</table>`;
  return `${indent}"${escapeId(node.id)}" [shape=plain, label=<${label}>];\n`;
}

/**
 * @param {import("../data/filter.js").ViewNode} node
 * @param {import("./appearance.js").Appearance} look
 * @param {import("../widgets/theme.js").Theme} theme
 * @param {string} indent
 */
function renderPlainNode(node, look, theme, indent) {
  const fill = look.nodeColors[node.kind] ?? DIAGRAM_CHROME[theme].depthFills[1];
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
 * @param {import("../data/filter.js").ViewNode} node
 * @param {boolean} showMembers
 * @param {import("./appearance.js").Appearance} look
 * @param {import("../widgets/theme.js").Theme} theme
 * @param {string} indent
 */
function renderNode(node, showMembers, look, theme, indent) {
  return TABLE_KINDS.has(node.kind)
    ? renderTableNode(node, showMembers, look, theme, indent)
    : renderPlainNode(node, look, theme, indent);
}

/**
 * @param {import("./tree.js").ModuleTree} tree
 * @param {string[]} path
 * @param {boolean} showMembers
 * @param {import("./appearance.js").Appearance} look
 * @param {import("../widgets/theme.js").Theme} theme
 * @param {number} depth
 * @param {{ value: number }} counter
 */
function renderModule(tree, path, showMembers, look, theme, depth, counter) {
  const chrome = DIAGRAM_CHROME[theme];
  const indent = "  ".repeat(depth + 1);
  const inCluster = path.length > 0;
  let out = "";

  if (inCluster) {
    counter.value += 1;
    const id = `cluster_mod_${sanitize(path.join("_"))}_${counter.value}`;
    out += `${indent}subgraph ${id} {\n`;
    out += `${indent}  label="${escapeHtml(path.join("::"))}";\n`;
    out += `${indent}  style=filled; color="${chrome.clusterLine}"; fillcolor="${
      chrome.depthFills[Math.min(depth, chrome.depthFills.length - 1)]
    }";\n`;
  }

  const body = "  ".repeat(depth + (inCluster ? 2 : 1));

  for (const node of tree.loose) {
    out += renderNode(node, showMembers, look, theme, body);
  }

  for (const [group, members] of [...tree.groups].sort(([a], [b]) => a.localeCompare(b))) {
    counter.value += 1;
    const id = `cluster_grp_${sanitize(group)}_${counter.value}`;
    out += `${body}subgraph ${id} {\n`;
    out += `${body}  label="${escapeHtml(group)}";\n`;
    out += `${body}  style=filled; color="${chrome.groupLine}"; fillcolor="${chrome.groupFill}"; fontsize=11;\n`;
    for (const node of members) {
      out += renderNode(node, showMembers, look, theme, body + "  ");
    }
    out += `${body}}\n`;
  }

  for (const [name, child] of [...tree.children].sort(([a], [b]) => a.localeCompare(b))) {
    out += renderModule(child, [...path, name], showMembers, look, theme, depth + 1, counter);
  }

  if (inCluster) out += `${indent}}\n`;
  return out;
}

/**
 * @param {import("../data/filter.js").ViewEdge} edge
 * @param {Set<string>} portsDrawn
 * @param {import("./appearance.js").Appearance} look
 * @param {import("../widgets/theme.js").Theme} theme
 * @param {string} indent
 */
function renderEdge(edge, portsDrawn, look, theme, indent) {
  const relLook = look.edges[edge.rel] ?? { arrowhead: "normal" };
  const style = look.viaStyles[edge.via] ?? "solid";
  const color = edgeColor(look, edge, theme);
  const attrs = [
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
 * @param {import("../data/filter.js").View} view
 * @param {import("../data/state.js").FilterState} state
 * @param {import("./appearance.js").Appearance} look
 * @param {import("../widgets/theme.js").Theme} theme
 */
export function toDot(view, state, look, theme) {
  const chrome = DIAGRAM_CHROME[theme];
  const root = buildTree(view.nodes);

  // An edge may only use a port whose row is actually on the page.
  const portsDrawn = new Set();
  if (state.showMembers) {
    for (const node of view.nodes) {
      if (!TABLE_KINDS.has(node.kind)) continue;
      for (const member of node.members) portsDrawn.add(`${node.id} ${member.port}`);
    }
  }

  // The sheet is painted rather than left transparent, so that an SVG saved
  // out of a dark page is still a dark diagram wherever it is opened, and the
  // ink is named for the same reason: Graphviz's default is black, which on
  // that sheet is nothing at all.
  let out = "digraph portray {\n";
  out += `  rankdir=${state.rankdir};\n`;
  out += "  compound=true;\n";
  out += "  newrank=true;\n";
  out += `  bgcolor="${chrome.bg}";\n`;
  out += `  graph [fontname="sans-serif", fontsize=13, labeljust="l", fontcolor="${chrome.ink}"];\n`;
  out += `  node  [fontname="sans-serif", fontsize=10, fontcolor="${chrome.ink}", color="${chrome.nodeLine}"];\n`;
  out += `  edge  [fontname="sans-serif", fontsize=9, fontcolor="${chrome.ink}"];\n\n`;

  out += renderModule(root, [], state.showMembers, look, theme, 0, { value: 0 });

  out += "\n";
  for (const edge of view.edges) {
    out += renderEdge(edge, portsDrawn, look, theme, "  ");
  }
  out += "}\n";
  return out;
}
