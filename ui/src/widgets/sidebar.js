// How wide the sidebar is.
//
// A width is a standing preference about this browser window, not part of the
// view you share, so it goes to localStorage beside the colours rather than
// into the URL hash.
//
// The strip that is dragged sits over the seam rather than in the grid, so
// widening the sidebar moves one custom property and never reflows a column
// that the diagram is measured against.

const STORAGE_KEY = "portray.sidebar-width.v1";

/** Narrow enough to hold a module row, wide enough for a long id. */
const MIN = 220;
const MAX = 720;

/** The width the page is laid out at, as a number of pixels. */
function current() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width");
  return Number.parseFloat(raw) || MIN;
}

/** @param {number} width */
function apply(width) {
  document.documentElement.style.setProperty("--sidebar-width", `${Math.round(width)}px`);
}

/** @returns {number|null} the saved width, if this browser kept one */
function load() {
  try {
    const width = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(width) && width >= MIN ? Math.min(width, MAX) : null;
  } catch {
    // Storage is off; the default width is already what the page is using.
    return null;
  }
}

/** @param {number} width */
function save(width) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Private browsing, a full quota — the width just will not persist.
  }
}

/**
 * Restores the saved width, and makes `handle` the strip it is dragged by.
 *
 * The pointer is captured for the duration, so a drag that runs out over the
 * diagram — or off the page — still ends where the button comes up.
 *
 * @param {HTMLElement} handle
 */
export function attachSidebarResize(handle) {
  const saved = load();
  if (saved !== null) apply(saved);

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    let width = current();

    const move = (/** @type {PointerEvent} */ moved) => {
      width = Math.max(MIN, Math.min(moved.clientX, MAX));
      apply(width);
    };
    const drop = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", drop);
      handle.removeEventListener("pointercancel", drop);
      save(width);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", drop);
    handle.addEventListener("pointercancel", drop);
    event.preventDefault(); // or the drag selects the panels behind it
  });

  // A drag is not the only way to point at a seam: the keys make the same
  // move without one, for anyone who reaches the handle by tabbing to it.
  handle.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (step === 0) return;
    event.preventDefault();
    const width = Math.max(MIN, Math.min(current() + step, MAX));
    apply(width);
    save(width);
  });
}
