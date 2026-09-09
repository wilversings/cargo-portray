// Wiring: fetch the model, keep the filter state, redraw when either moves.

import { button, closeMenus, h, icon, menu, toggle } from "./dom.js";
import { buildView } from "./filter.js";
import { toDot } from "./dot.js";
import { toPlantUml } from "./plantuml.js";
import { appearancePanel } from "./panels/appearance.js";
import { detailsPanel } from "./panels/details.js";
import { artifactPanel, optionsPanel, presetPanel, relationPanel } from "./panels/filters.js";
import { hiddenPanel } from "./panels/hidden.js";
import { modulePanel } from "./panels/modules.js";
import { clearAppearance, defaultAppearance, loadAppearance, saveAppearance } from "./appearance.js";
import { markSelected, renderInto, resetView, setDiagramLocked, setSelectStroke } from "./render.js";
import { attachSidebarResize } from "./sidebar.js";
import { defaultState, onHashNavigation, readHash, reconcile, Store } from "./state.js";
import {
  applyTheme,
  cssColor,
  loadTheme,
  onSystemThemeChange,
  resolveTheme,
  saveTheme,
  themeFromHost,
  THEME_CHOICES,
} from "./theme.js";

const sidebar = document.getElementById("panels");
const crateName = document.getElementById("crate-name");
const toolbar = document.getElementById("toolbar");
const canvasSwitches = document.getElementById("canvas-switches");
const viewport = document.getElementById("viewport");
const statusLine = document.getElementById("status");

/**
 * `api/graph` when there is a server behind the page, a plain file when this
 * is a static export, and `inline` when the export was folded into one file
 * and the model is in the page itself — in which case, either way, nothing
 * can change under us and there is nothing to poll.
 */
const source =
  document.querySelector('meta[name="portray-source"]')?.getAttribute("content") ?? "api/graph";
const live = source === "api/graph";

/**
 * Too narrow to stand the panels beside the diagram.
 *
 * The stylesheet turns the sidebar into a sheet over the drawing at the same
 * width, and the two have to agree: below it the page opens with the panels
 * out of the way, because a sidebar that covers a phone is a page with no
 * diagram in it. Which mode the window is in is asked rather than remembered,
 * like the mode it decides.
 */
const narrow = window.matchMedia("(max-width: 720px)");

const store = new Store(readHash());
/**
 * The light the page is read in, and the light it resolves to.
 *
 * Two values because "system" is a choice that has no colours of its own: the
 * menu shows the choice, and everything that draws — the stylesheet's tokens,
 * the diagram's own sheet and ink, the colours the reader has picked — asks
 * for the resolved one. Like the sidebar's width it is a standing preference
 * and lives in localStorage, and like the sidebar's width it stays out of the
 * link: a view is shared, and the light it is read in is not.
 */
let themeChoice = themeFromHost() ?? loadTheme();
let theme = resolveTheme(themeChoice);
let appearance = loadAppearance(theme);
/** @type {import("./model.js").Graph} */
let graph = { crate: "", root: "", scope: [], nodes: [], edges: [] };
/** @type {string|null} */
let selected = null;
/** Modules folded shut in the sidebar tree — display-only, never shared. */
const foldedModules = new Set();
/** What the module tree is being searched for — display-only, like the folds. */
let moduleSearch = "";
/**
 * Whether the panels are out of the way, and whether the diagram is pinned
 * where it was left.
 *
 * Both are display-only, like the folds and the sidebar's width: they say
 * nothing about which artifacts are drawn, so neither goes in the link. They
 * are not standing preferences either — a reader who cleared the chrome to
 * look at one diagram should not find it gone the next time the page opens —
 * so unlike the width they are not written to storage either. Which is also
 * why a narrow window can simply start with the panels away: nothing is being
 * overridden, and one tap brings them in.
 */
let chromeHidden = narrow.matches;
let diagramLocked = false;
let lastDot = "";
/**
 * The view the last DOT was generated from, and the state it was filtered by.
 *
 * Kept beside `lastDot` for the exports that write their own text out of the
 * view rather than out of the DOT: what leaves the page has to be the diagram
 * on it, not whatever the filters have been moved to since.
 *
 * @type {import("./filter.js").View|null}
 */
let lastView = null;
/** @type {import("./state.js").FilterState|null} */
let lastState = null;
let pending = false;
/** Set when the loaded view mentioned things this crate does not have. */
let notice = "";

/**
 * The model, from wherever this page keeps it.
 *
 * A one-file export has nothing beside it to fetch — a `file://` page cannot
 * fetch a sibling anyway — so the export writes the model into a `<script>`
 * and the page reads it out of its own DOM.
 */
async function readModel() {
  if (source !== "inline") {
    const response = await fetch(source);
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }
  const embedded = document.getElementById("portray-model");
  if (!embedded) throw new Error("this page says it carries its model, and does not");
  return JSON.parse(embedded.textContent ?? "");
}

async function loadGraph() {
  try {
    graph = await readModel();
  } catch (error) {
    statusLine.textContent = `could not load the model: ${error.message}`;
    return;
  }
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
    // The sheet the diagram was read on, so a picture taken off the dark page
    // is not a dark drawing on white.
    context.fillStyle = cssColor("--canvas", "#ffffff");
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) download(`${graph.crate}-deps.png`, blob, "image/png");
    });
  };
  image.src =
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
}

/** A tray with the diagram dropping into it: what leaves the page. */
const EXPORT_TRAY = "M4 15v3.5a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5V15";
const EXPORT_ARROW = ["M12 3.5v10.5", "M7.5 10l4.5 4 4.5-4"];

/**
 * The three file formats, behind one icon.
 *
 * They are a single errand — take the diagram somewhere else — that only
 * branches at the last step, so the row spends one square on them instead of
 * three words, and the choice of format is made after the reader has said they
 * want a file.
 */
function exportControl() {
  return menu(
    icon(EXPORT_TRAY, ...EXPORT_ARROW),
    "export",
    "export the diagram as DOT, PlantUML, SVG or PNG",
    [
      {
        label: "DOT",
        title: "the Graphviz source this view was laid out from",
        run: () => download(`${graph.crate}-deps.dot`, lastDot, "text/vnd.graphviz"),
      },
      {
        label: "PlantUML",
        title: "the same view as a PlantUML class diagram, to render or hand-edit",
        run: () => {
          if (!lastView || !lastState) return;
          download(
            `${graph.crate}-deps.puml`,
            toPlantUml(lastView, lastState, appearance, theme, graph.crate),
            "text/plain;charset=utf-8",
          );
        },
      },
      {
        label: "SVG",
        title: "the drawing itself, as vectors",
        run: () => {
          const svg = viewport.querySelector("svg");
          if (!svg) return;
          download(
            `${graph.crate}-deps.svg`,
            new XMLSerializer().serializeToString(svg),
            "image/svg+xml",
          );
        },
      },
      { label: "PNG", title: "the drawing as a picture, at twice the size", run: exportPng },
    ],
  );
}

/** A sun and a crescent: the light the page is being read in, whichever it is. */
const SUN = [
  "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  "M12 3v2",
  "M12 19v2",
  "M3 12h2",
  "M19 12h2",
  "M5.6 5.6l1.4 1.4",
  "M17 17l1.4 1.4",
  "M18.4 5.6L17 7",
  "M7 17l-1.4 1.4",
];
const MOON = ["M20.5 14.8A8.5 8.5 0 0 1 9.2 3.5a8.5 8.5 0 1 0 11.3 11.3z"];

/**
 * Light, dark, or whatever the machine is set to.
 *
 * A drop-down rather than a switch because there are three of them, and the
 * third is the one worth defaulting to: a reader who has told their operating
 * system which light they work in has already answered this, and the page
 * should follow when they change their mind. The button draws the light the
 * page is *in* rather than the choice that produced it, so "system" still
 * shows a sun in the morning and a moon at night; which of the three is
 * chosen is said inside the menu, where there is room to say it.
 */
function themeControl() {
  const labels = {
    light: ["Light", "always the light page"],
    dark: ["Dark", "always the dark page"],
    system: ["System", "follow the operating system's setting"],
  };
  return menu(
    icon(...(theme === "dark" ? MOON : SUN)),
    "theme",
    `theme: ${labels[themeChoice][0].toLowerCase()}`,
    THEME_CHOICES.map((choice) => ({
      label: labels[choice][0],
      title: labels[choice][1],
      checked: choice === themeChoice,
      run: () => setTheme(choice),
    })),
  );
}

/**
 * @param {import("./theme.js").ThemeChoice} choice
 */
function setTheme(choice) {
  themeChoice = choice;
  saveTheme(choice);
  switchTheme();
}

/**
 * Puts the light on the page: the stylesheet's tokens all turn over on the
 * attribute alone, and what CSS does not reach is set from it here. Does not
 * redraw — the first call happens before there is anything drawn.
 */
function paintTheme() {
  theme = resolveTheme(themeChoice);
  applyTheme(themeChoice);
  // Read back rather than repeated here, so the outline on a selected node
  // cannot drift from the accent the rest of the page is using.
  setSelectStroke(cssColor("--accent", "#d1345b"));
  // The reader's picked colours are this theme's own.
  appearance = loadAppearance(theme);
}

/**
 * The light, and everything drawn in it. The panel's colour pickers are now
 * showing another theme's colours and the diagram is an SVG that was generated
 * once, so both are built again rather than recoloured.
 */
function switchTheme() {
  paintTheme();
  renderToolbar();
  renderSidebar();
  void draw();
}

function renderToolbar() {
  // The menus about to be thrown away hold a listener on the document.
  closeMenus();
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
    button(icon(...FRAME), resetView, "fit the diagram to the window"),
    button(icon(...UNDO), () => store.update(defaultState()), "back to the default view"),
    // Left of the hairline is what changes the view; right of it is what does
    // something else with it — takes a copy away, or changes the light it is
    // read in. A hairline is enough to say so now that the row is only as wide
    // as what is in it.
    h("span", { class: "divider" }),
    exportControl(),
    themeControl(),
  );
}

/**
 * The two toolbar drawings. A frame with its corners drawn in is the window
 * the diagram is about to be sized to; a loop turning back on itself is the
 * way back to where the view started. Both say in a glyph what a word was
 * saying before, and the row is the narrower for it.
 */
const FRAME = ["M4 9V5h4", "M16 4h4v4", "M20 15v4h-4", "M8 20H4v-4"];
const UNDO = ["M3 12a9 9 0 1 0 2.6-6.4L3 8", "M3 3v5h5"];

/**
 * The switches draw their own state: a shut padlock is locked, an open one is
 * not, and the arrows point at the corners they are about to fill or leave.
 * `SHACKLE_*` is the only difference between the two locks — the same body,
 * with the hook either back in it or swung clear.
 */
const LOCK_BODY = "M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z";
const SHACKLE_SHUT = "M8 10V6.5a4 4 0 0 1 8 0V10";
const SHACKLE_OPEN = "M8 10V6.5a4 4 0 0 1 7.6-1.4";
const ARROWS_OUT = ["M15 3h6v6", "M14 10l7-7", "M9 21H3v-6", "M10 14l-7 7"];
const ARROWS_IN = ["M20 10h-6V4", "M14 10l7-7", "M4 14h6v6", "M10 14l-7 7"];
/**
 * The same switch on a narrow window, where it is not a full screen at all:
 * the panels are already off the diagram, and what the button does is slide
 * them back over it. A pane with a column ruled off it says that; arrows
 * promising a bigger picture on a page that has nothing else on it do not.
 */
const PANELS = [
  "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  "M10 5v14",
];

/**
 * The two switches that float over the diagram.
 *
 * Both act on the canvas and nothing else — one pins what is drawn where it
 * is, the other clears everything around it — which is why they are here and
 * the toolbar is in the sidebar with the filters it belongs to. Full screen
 * takes away the surface a control inside the sidebar would have been
 * standing on, so it has to stand out here in any case. The status line stays
 * visible in every mode — it is where a view with nothing in it says why.
 */
function renderCanvasTools() {
  canvasSwitches.replaceChildren(
    toggle(
      icon(LOCK_BODY, diagramLocked ? SHACKLE_SHUT : SHACKLE_OPEN),
      diagramLocked,
      () => {
        diagramLocked = !diagramLocked;
        setDiagramLocked(diagramLocked);
        applyChrome();
      },
      diagramLocked
        ? "unlock the diagram: the wheel zooms and a drag pans again"
        : "lock the diagram where it is: the wheel and a drag stop moving it",
    ),
    // On a narrow window the switch is drawn for what it does there — the
    // panels come over the diagram rather than the diagram filling the window
    // — and lights up while they are showing, which is the state a reader on a
    // phone is looking at the switch to leave.
    toggle(
      icon(...(narrow.matches ? PANELS : chromeHidden ? ARROWS_IN : ARROWS_OUT)),
      narrow.matches ? !chromeHidden : chromeHidden,
      () => setChromeHidden(!chromeHidden),
      narrow.matches
        ? chromeHidden
          ? "show the panels over the diagram"
          : "hide the panels"
        : chromeHidden
          ? "bring the panels back (or press Escape)"
          : "full screen: hide the panels, leaving the diagram",
    ),
  );
}

/** The stylesheet does the hiding and the cursor; this says which mode is on. */
function applyChrome() {
  document.body.classList.toggle("chrome-hidden", chromeHidden);
  document.body.classList.toggle("diagram-locked", diagramLocked);
  renderCanvasTools();
}

/** @param {boolean} hidden */
function setChromeHidden(hidden) {
  chromeHidden = hidden;
  // The menus go with the sidebar; left open, one would be waiting there when
  // the panels came back.
  if (hidden) closeMenus();
  applyChrome();
}

function renderSidebar() {
  const active = /** @type {HTMLInputElement|null} */ (document.activeElement);
  const activeId = active?.id ?? null;
  const caret = active && active.type === "text" ? active.selectionStart : null;

  sidebar.replaceChildren(
    detailsPanel(store, graph, selected),
    modulePanel(store, graph, {
      folded: foldedModules,
      search: moduleSearch,
      onToggleFold: (module) => {
        if (foldedModules.has(module)) foldedModules.delete(module);
        else foldedModules.add(module);
        renderSidebar();
      },
      // Narrowing the list changes nothing about what is drawn, so the
      // diagram is left alone.
      onSearch: (query) => {
        moduleSearch = query;
        renderSidebar();
      },
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
        saveAppearance(theme, appearance);
        renderSidebar();
        void draw();
      },
      () => {
        clearAppearance(theme);
        appearance = defaultAppearance(theme);
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
  try {
    const state = store.get();
    const view = buildView(graph, state);
    lastDot = toDot(view, state, appearance, theme);
    lastView = view;
    lastState = state;

    if (view.nodes.length === 0) {
      viewport.innerHTML = "";
      statusLine.textContent = `Nothing to draw. ${view.emptyReason} Press the reset button in the toolbar to start over.${suffix()}`;
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

  attachSidebarResize(document.getElementById("sidebar-resize"));
  // The way out of anything the reader took for a one-way door, innermost
  // first: an open menu shuts before the panels come back, so one press undoes
  // one thing.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (closeMenus()) return;
    if (chromeHidden) setChromeHidden(false);
  });
  // A window dragged past the width where the two stop fitting side by side
  // has answered the question again: the panels go when there is no room for
  // them and come back when there is.
  narrow.addEventListener("change", (event) => setChromeHidden(event.matches));
  // Only while the choice is "system": a reader who asked for one light in
  // particular is not asking to be moved off it at sunset.
  onSystemThemeChange(() => {
    if (themeChoice === "system") switchTheme();
  });
  paintTheme();
  applyChrome();
  renderToolbar();
  renderSidebar();
  await draw();
  if (live) pollForChanges();
}

void main();


