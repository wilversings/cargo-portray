// Wiring: fetch the model, keep the filter state, redraw when either moves.

import { button, h } from "./dom.js";
import { buildView } from "./filter.js";
import { toDot } from "./dot.js";
import { appearancePanel } from "./panels/appearance.js";
import { detailsPanel } from "./panels/details.js";
import { artifactPanel, optionsPanel, presetPanel, relationPanel } from "./panels/filters.js";
import { hiddenPanel } from "./panels/hidden.js";
import { modulePanel } from "./panels/modules.js";
import { clearAppearance, defaultAppearance, loadAppearance, saveAppearance } from "./appearance.js";
import { hideDoc, hoverDoc, isPinned, pinDoc } from "./doctip.js";
import { markSelected, renderInto, resetView } from "./render.js";
import { defaultState, onHashNavigation, readHash, reconcile, Store } from "./state.js";

const sidebar = document.getElementById("panels");
const crateName = document.getElementById("crate-name");
const toolbar = document.getElementById("toolbar");
const viewport = document.getElementById("viewport");
const statusLine = document.getElementById("status");

/**
 * `api/graph` when there is a server behind the page, a plain file when this
 * is a static export — in which case nothing can change under us and there is
 * nothing to poll.
 */
const source =
  document.querySelector('meta[name="portray-source"]')?.getAttribute("content") ?? "api/graph";
const live = source === "api/graph";

const store = new Store(readHash());
let appearance = loadAppearance();
/** @type {import("./model.js").Graph} */
let graph = { crate: "", root: "", scope: [], nodes: [], edges: [] };
/** @type {string|null} */
let selected = null;
/** Modules folded shut in the sidebar tree — display-only, never shared. */
const foldedModules = new Set();
let lastDot = "";
let pending = false;
/** Set when the loaded view mentioned things this crate does not have. */
let notice = "";

async function loadGraph() {
  const response = await fetch(source);
  if (!response.ok) {
    statusLine.textContent = `could not load the model: ${response.status}`;
    return;
  }
  graph = await response.json();
  // A scoped run read part of a crate, and a page that did not say so would
  // read as a whole crate with things missing.
  const scope = graph.scope?.length ? ` · ${graph.scope.join(", ")}` : "";
  crateName.textContent = graph.crate + scope;
  crateName.title = graph.scope?.length
    ? `only ${graph.scope.join(" and ")} was read; the rest of the crate was not parsed`
    : graph.crate;
  document.title = `portray — ${graph.crate}${scope}`;

  // Every caller redraws right after this, so the state can be swapped
  // without notifying.
  const { state, dropped } = reconcile(store.get(), graph);
  notice = dropped.length === 0 ? "" : `ignored, not in ${graph.crate}: ${dropped.join(", ")}`;
  if (dropped.length > 0) store.reset(state);
}

/**
 * @param {string} name
 * @param {BlobPart} data
 * @param {string} type
 */
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportPng() {
  const svg = viewport.querySelector("svg");
  if (!svg) return;
  const clone = /** @type {SVGSVGElement} */ (svg.cloneNode(true));
  const box = svg.getBBox();
  const scale = 2;
  clone.setAttribute("width", String(box.width * scale));
  clone.setAttribute("height", String(box.height * scale));
  clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);

  const source = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = box.width * scale;
    canvas.height = box.height * scale;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) download(`${graph.crate}-deps.png`, blob, "image/png");
    });
  };
  image.src =
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
}

function renderToolbar() {
  const state = store.get();
  toolbar.replaceChildren(
    h("input", {
      type: "search",
      id: "search",
      list: "node-ids",
      placeholder: "focus an artifact…",
      value: state.focus ?? "",
      onchange: (event) => {
        const term = event.target.value.trim();
        if (!term) {
          store.update({ focus: null });
          return;
        }
        const lower = term.toLowerCase();
        const match =
          graph.nodes.find((node) => node.id === term) ??
          graph.nodes.find((node) => node.id.toLowerCase().includes(lower));
        if (match) store.update({ focus: match.id, solo: null });
      },
    }),
    h(
      "datalist",
      { id: "node-ids" },
      ...graph.nodes.slice(0, 2000).map((node) => h("option", { value: node.id })),
    ),
    button("fit", resetView, "fit the diagram to the window"),
    button("reset", () => store.update(defaultState()), "back to the default view"),
    h("span", { class: "spacer" }),
    button("DOT", () => download(`${graph.crate}-deps.dot`, lastDot, "text/vnd.graphviz")),
    button("SVG", () => {
      const svg = viewport.querySelector("svg");
      if (svg) {
        download(
          `${graph.crate}-deps.svg`,
          new XMLSerializer().serializeToString(svg),
          "image/svg+xml",
        );
      }
    }),
    button("PNG", exportPng),
  );
}

function renderSidebar() {
  const active = /** @type {HTMLInputElement|null} */ (document.activeElement);
  const activeId = active?.id ?? null;
  const caret = active && active.type === "text" ? active.selectionStart : null;

  sidebar.replaceChildren(
    detailsPanel(store, graph, selected),
    modulePanel(store, graph, foldedModules, (module) => {
      if (foldedModules.has(module)) foldedModules.delete(module);
      else foldedModules.add(module);
      renderSidebar();
    }),
    presetPanel(store),
    relationPanel(store, graph, appearance),
    artifactPanel(store, graph, appearance),
    hiddenPanel(store, graph),
    optionsPanel(store),
    appearancePanel(
      appearance,
      (change) => {
        appearance = { ...appearance, ...change };
        saveAppearance(appearance);
        renderSidebar();
        void draw();
      },
      () => {
        clearAppearance();
        appearance = defaultAppearance();
        renderSidebar();
        void draw();
      },
    ),
  );

  if (activeId) {
    const restored = /** @type {HTMLInputElement|null} */ (document.getElementById(activeId));
    restored?.focus();
    if (restored && caret !== null) restored.setSelectionRange(caret, caret);
  }
}

function suffix() {
  return notice ? ` · ${notice}` : "";
}

async function draw() {
  if (pending) return;
  pending = true;
  // The SVG the panel was opened over is about to be replaced.
  hideDoc(true);
  try {
    const state = store.get();
    const view = buildView(graph, state);
    lastDot = toDot(view, state, appearance);

    if (view.nodes.length === 0) {
      viewport.innerHTML = "";
      statusLine.textContent = `Nothing to draw. ${view.emptyReason} Press reset to start over.${suffix()}`;
      return;
    }

    statusLine.textContent = `laying out ${view.nodes.length} artifacts…`;
    const { elapsedMs } = await renderInto(viewport, lastDot, selected, {
      onSelect: (id) => {
        selected = id;
        renderSidebar();
        highlight(id);
      },
      onActivate: (id) => store.update({ focus: id, solo: null }),
      onDocHover: (target, event) => {
        const tip = docTip(target, event);
        if (tip) hoverDoc(tip);
      },
      onDocPin: (target, event) => {
        const tip = docTip(target, event);
        if (tip) pinDoc(tip);
      },
      onDocLeave: () => hideDoc(),
    });

    const edgeNote =
      view.edges.length === 0
        ? "no edge types selected — artifacts only"
        : `${view.edges.length} of ${view.totalEdges} dependencies`;
    statusLine.textContent =
      `${view.nodes.length} of ${view.totalNodes} artifacts, ${edgeNote} · ` +
      `laid out in ${Math.round(elapsedMs)} ms${suffix()}`;
  } catch (error) {
    statusLine.textContent = `layout failed: ${error instanceof Error ? error.message : error}`;
  } finally {
    pending = false;
  }
}

/**
 * What a documentation marker points at: the artifact itself, or the one
 * field or variant the marker sits beside.
 * @param {import("./render.js").DocTarget} target
 * @param {MouseEvent} event
 * @returns {import("./doctip.js").DocTip|null}
 */
function docTip(target, event) {
  const node = graph.nodes.find((candidate) => candidate.id === target.id);
  if (!node) return null;
  if (target.port) {
    const member = node.members.find((candidate) => candidate.port === target.port);
    if (!member?.docs) return null;
    return {
      title: member.label,
      subtitle: `${node.name} in ${node.module || "the crate root"}`,
      docs: member.docs,
      x: event.clientX,
      y: event.clientY,
    };
  }
  if (!node.docs) return null;
  return {
    title: node.name,
    subtitle: node.signature ?? `${node.kind} in ${node.module || "the crate root"}`,
    docs: node.docs,
    x: event.clientX,
    y: event.clientY,
  };
}

/** Outlines the clicked node without paying for a whole re-layout. */
function highlight(id) {
  for (const group of viewport.querySelectorAll("g.node")) {
    markSelected(group, group.querySelector("title")?.textContent === id);
  }
}

/** The Rust side bumps a counter when a source file changes. */
function pollForChanges() {
  /** @type {number|null} */
  let known = null;
  window.setInterval(async () => {
    try {
      const response = await fetch("api/version");
      if (!response.ok) return;
      const { version } = await response.json();
      if (known === null) {
        known = version;
        return;
      }
      if (version !== known) {
        known = version;
        await loadGraph();
        renderToolbar();
        renderSidebar();
        await draw();
      }
    } catch {
      // The server went away; the next tick will find out if it comes back.
    }
  }, 750);
}

async function main() {
  await loadGraph();

  store.subscribe((state) => {
    // Whatever the link asked for has been superseded by a deliberate choice.
    notice = "";
    // Only the value can go stale here; rebuilding the whole toolbar would
    // throw away a datalist of every node id on each checkbox click.
    const search = /** @type {HTMLInputElement|null} */ (document.getElementById("search"));
    if (search && document.activeElement !== search) search.value = state.focus ?? "";
    renderSidebar();
    void draw();
  });
  onHashNavigation((state) => store.update(state));

  // A pinned documentation panel is dismissed the way any panel over a page
  // is: by pressing escape, or by clicking away from it.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideDoc(true);
  });
  document.addEventListener("mousedown", () => {
    if (isPinned()) hideDoc(true);
  });

  renderToolbar();
  renderSidebar();
  await draw();
  if (live) pollForChanges();
}

void main();
