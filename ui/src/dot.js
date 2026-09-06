// The filtered view, rendered as DOT.
//
// Ported from the standalone generator this tool replaces, so the drawing
// keeps what worked there: nested module clusters, one sub-cluster per impl
// block or trait, struct fields as table rows, and edges that leave from the
// exact field that creates the dependency.

import { lighten } from "./appearance.js";

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

/**
 * The documentation marker: a fake URL scheme that carries what the marker
 * points at through Graphviz, and the letter the viewer draws its circle
 * around.
 *
 * Graphviz turns `href` into an `<a xlink:href>` in the SVG, which is the only
 * way a specific *cell* of a node — one field, one variant — survives layout
 * as something the page can bind to. Nothing ever navigates to these: the
 * viewer reads the id back out and opens the panel itself.
 *
 * A table has a cell to put the marker in and a plain node does not, so the
 * two schemes say which: `portray-doc:` is a cell, and `render.js` rings the
 * letter that is already there; `portray-node:` is a whole node, and it draws
 * the marker into the space `renderPlainNode` left for it.
 */
const DOC_GLYPH = "i";
const DOC_CELL_WIDTH = 18;
/** Room reserved in a plain node for a marker the viewer draws itself. */
const DOC_NODE_ROOM = 14;
const DOC_SCHEME = "portray-doc:";
const NODE_SCHEME = "portray-node:";

/** @param {string} id @param {string} [port] */
function docHref(id, port) {
  // `encodeURIComponent` escapes `/` too, so the port is unambiguous, and
  // leaves nothing that needs escaping again in an HTML-like attribute.
  return DOC_SCHEME + encodeURIComponent(id) + (port ? `/${port}` : "");
}

/**
 * Reverses {@link docHref}.
 * @param {string} href
 * @returns {{ id: string, port: string|null, whole: boolean }|null}
 */
export function parseDocHref(href) {
  const whole = href.startsWith(NODE_SCHEME);
  if (!whole && !href.startsWith(DOC_SCHEME)) return null;
  const rest = href.slice((whole ? NODE_SCHEME : DOC_SCHEME).length);
  const slash = rest.indexOf("/");
  return slash === -1
    ? { id: decodeURIComponent(rest), port: null, whole }
    : { id: decodeURIComponent(rest.slice(0, slash)), port: rest.slice(slash + 1), whole };
}

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
 * The cell that carries the marker, or the attribute that widens a row to
 * cover the column it would have sat in.
 *
 * Every row of a documented node has to agree on how many columns it has, and
 * the port has to end up on the row's *last* cell: a port names the point an
 * edge leaves from, and an edge that left the middle of the box would cross
 * the marker on its way out.
 *
 * @param {string} href
 * @param {string} bg
 * @param {string|undefined} port
 */
function docCell(href, bg, port) {
  const attrs = [
    port ? `port="${port}"` : null,
    `bgcolor="${bg}"`,
    `width="${DOC_CELL_WIDTH}"`,
    `href="${href}"`,
    // Without this Graphviz hands the cell the node's id as a native
    // browser tooltip, which arrives on top of the panel the marker opens.
    'tooltip=" "',
  ].filter(Boolean);
  return `<td ${attrs.join(" ")}>${DOC_GLYPH}</td>`;
}

/**
 * @param {import("./filter.js").ViewNode} node
 * @param {boolean} showMembers
 * @param {boolean} showDocs
 * @param {import("./appearance.js").Appearance} look
 * @param {string} indent
 */
function renderTableNode(node, showMembers, showDocs, look, indent) {
  const headerBg = look.nodeColors[node.kind] ?? "#eeeeee";
  const bodyBg = lighten(headerBg, 0.72);

  const members = showMembers ? node.members : [];
  const marked = showDocs && (Boolean(node.docs) || members.some((member) => member.docs));

  // One text run, not `<b>struct</b> Name`: Graphviz positions each run from
  // its own font metrics, and with those metrics wrong the second run landed
  // on top of the first — that is what ran `struct` into the type name.
  const header = `${keywordFor(node)} ${node.name}`;
  const span = marked && !node.docs ? ' colspan="2"' : "";
  const rows = [
    `<tr><td bgcolor="${headerBg}" align="left"${span} width="${cellWidth(header, true)}">` +
      `<b>${escapeHtml(header)}</b></td>` +
      (marked && node.docs ? docCell(docHref(node.id), headerBg, undefined) : "") +
      `</tr>`,
  ];
  for (const member of members) {
    const documented = marked && Boolean(member.docs);
    const label =
      `<td ${documented ? "" : `port="${member.port}" `}bgcolor="${bodyBg}" align="left" ` +
      `${marked && !documented ? 'colspan="2" ' : ""}` +
      `width="${cellWidth(member.label, false)}">${escapeHtml(member.label)}</td>`;
    rows.push(
      `<tr>${label}` +
        (documented ? docCell(docHref(node.id, member.port), bodyBg, member.port) : "") +
        `</tr>`,
    );
  }

  const label =
    `<table border="0" cellborder="1" cellspacing="0" cellpadding="4" ` +
    `bgcolor="#ffffff">${rows.join("")}</table>`;
  return `${indent}"${escapeId(node.id)}" [shape=plain, label=<${label}>];\n`;
}

/**
 * @param {import("./filter.js").ViewNode} node
 * @param {boolean} showDocs
 * @param {import("./appearance.js").Appearance} look
 * @param {string} indent
 */
function renderPlainNode(node, showDocs, look, indent) {
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
  // A function has no rows to hang a marker off, so the whole node is what
  // you hover, and the marker is drawn into the corner of it — with the room
  // for it added here, where the width is decided.
  const documented = showDocs && Boolean(node.docs);
  // An ellipse needs to be wider than its text to contain it; a note is a box
  // and only needs the padding. Either way the width is a minimum, computed
  // here rather than left to Graphviz's font-metric guess.
  const slack = shape === "ellipse" ? 1.5 : 1;
  const room = documented ? DOC_NODE_ROOM : 0;
  const width = (textWidth(node.name, false) * slack + 16 + room) / 72;
  const doc = documented
    ? `, href="${NODE_SCHEME}${encodeURIComponent(node.id)}", tooltip=" "`
    : "";
  return (
    `${indent}"${escapeId(node.id)}" [label="${escapeHtml(node.name)}", shape=${shape}, ` +
    `style=filled, fillcolor="${fill}", width=${width.toFixed(3)}${doc}];\n`
  );
}

/**
 * @param {import("./filter.js").ViewNode} node
 * @param {boolean} showMembers
 * @param {boolean} showDocs
 * @param {import("./appearance.js").Appearance} look
 * @param {string} indent
 */
function renderNode(node, showMembers, showDocs, look, indent) {
  return TABLE_KINDS.has(node.kind)
    ? renderTableNode(node, showMembers, showDocs, look, indent)
    : renderPlainNode(node, showDocs, look, indent);
}

/**
 * @param {ModuleTree} tree
 * @param {string[]} path
 * @param {boolean} showMembers
 * @param {boolean} showDocs
 * @param {import("./appearance.js").Appearance} look
 * @param {number} depth
 * @param {{ value: number }} counter
 */
function renderModule(tree, path, showMembers, showDocs, look, depth, counter) {
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
    out += renderNode(node, showMembers, showDocs, look, body);
  }

  for (const [group, members] of [...tree.groups].sort(([a], [b]) => a.localeCompare(b))) {
    counter.value += 1;
    const id = `cluster_grp_${sanitize(group)}_${counter.value}`;
    out += `${body}subgraph ${id} {\n`;
    out += `${body}  label="${escapeHtml(group)}";\n`;
    out += `${body}  style=filled; color="#9fb3c8"; fillcolor="#ffffff"; fontsize=11;\n`;
    for (const node of members) {
      out += renderNode(node, showMembers, showDocs, look, body + "  ");
    }
    out += `${body}}\n`;
  }

  for (const [name, child] of [...tree.children].sort(([a], [b]) => a.localeCompare(b))) {
    out += renderModule(child, [...path, name], showMembers, showDocs, look, depth + 1, counter);
  }

  if (inCluster) out += `${indent}}\n`;
  return out;
}

/**
 * @param {import("./filter.js").ViewEdge} edge
 * @param {Set<string>} portsDrawn
 * @param {import("./appearance.js").Appearance} look
 * @param {string} indent
 */
function renderEdge(edge, portsDrawn, look, indent) {
  const relLook = look.edges[edge.rel] ?? { color: "#333333", arrowhead: "normal" };
  const style = look.viaStyles[edge.via] ?? "solid";
  const attrs = [
    `color="${relLook.color}"`,
    `style=${style}`,
    `arrowhead=${relLook.arrowhead}`,
  ];

  const labels = [];
  if (edge.count > 1) labels.push(`×${edge.count}`);
  if (edge.ambiguous) labels.push("?");
  if (labels.length > 0) {
    attrs.push(`label="${labels.join(" ")}"`, `fontcolor="${relLook.color}"`);
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

  out += renderModule(root, [], state.showMembers, state.showDocs, look, 0, { value: 0 });

  out += "\n";
  for (const edge of view.edges) {
    out += renderEdge(edge, portsDrawn, look, "  ");
  }
  out += "}\n";
  return out;
}
