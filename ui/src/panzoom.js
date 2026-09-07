// Pan and zoom for the rendered SVG, by moving its viewBox.
//
// This replaces the svg-pan-zoom package: sixty lines of viewBox arithmetic
// is a better trade than a dependency, and it was the last thing standing
// between this viewer and needing no package manager at all.

/**
 * @param {SVGSVGElement} svg
 */
export function attachPanZoom(svg) {
  const declared = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const initial =
    declared.length === 4 && declared.every((n) => Number.isFinite(n))
      ? { x: declared[0], y: declared[1], w: declared[2], h: declared[3] }
      : { x: 0, y: 0, w: 1000, h: 1000 };

  let view = { ...initial };
  /**
   * A locked diagram ignores the gestures that move it — the wheel and the
   * drag — and nothing else: a click still selects, because selecting a node
   * does not shift the picture the reader has framed.
   */
  let locked = false;

  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.touchAction = "none";

  function apply() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  /** Client pixels to user units, taking the letterboxing into account. */
  function scale() {
    const box = svg.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return view.w / 1000;
    return Math.max(view.w / box.width, view.h / box.height);
  }

  /** @param {MouseEvent|WheelEvent} event */
  function toUser(event) {
    const box = svg.getBoundingClientRect();
    const factor = scale();
    // The viewBox is centred inside the element, so the unused half of the
    // letterbox has to come off before scaling.
    const offsetX = (box.width - view.w / factor) / 2;
    const offsetY = (box.height - view.h / factor) / 2;
    return {
      x: view.x + (event.clientX - box.left - offsetX) * factor,
      y: view.y + (event.clientY - box.top - offsetY) * factor,
    };
  }

  svg.addEventListener(
    "wheel",
    (event) => {
      if (locked) return;
      event.preventDefault();
      const anchor = toUser(event);
      const step = Math.exp(event.deltaY * 0.002);
      const width = Math.min(Math.max(view.w * step, initial.w / 200), initial.w * 40);
      const ratio = width / view.w;
      view = {
        w: width,
        h: view.h * ratio,
        x: anchor.x - (anchor.x - view.x) * ratio,
        y: anchor.y - (anchor.y - view.y) * ratio,
      };
      apply();
    },
    { passive: false },
  );

  /**
   * A press is not a drag yet.
   *
   * The pan used to capture the pointer the moment a button went down, and a
   * captured pointer sends its `pointerup` — and the `click` built out of it —
   * to whatever holds the capture. Every click in the diagram was therefore
   * delivered to the `<svg>` itself: nothing a node or a documentation marker
   * listened for ever reached it. So the press is only remembered here, and
   * the capture waits until the pointer has actually travelled far enough to
   * mean a drag; a click that stays put is left alone to land where it fell.
   */
  const DRAG_SLOP = 3;

  /** @type {{ user: { x: number, y: number }, x: number, y: number, id: number }|null} */
  let press = null;
  /** @type {{ x: number, y: number }|null} */
  let dragging = null;

  svg.addEventListener("pointerdown", (event) => {
    if (locked || event.button !== 0) return;
    // Without this the browser starts a text selection and the drag paints
    // every label it passes over blue. It does not stop the click.
    event.preventDefault();
    press = { user: toUser(event), x: event.clientX, y: event.clientY, id: event.pointerId };
  });

  svg.addEventListener("pointermove", (event) => {
    if (press && !dragging) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP) return;
      dragging = press.user;
      svg.setPointerCapture(press.id);
      svg.style.cursor = "grabbing";
    }
    if (!dragging) return;
    const factor = scale();
    const box = svg.getBoundingClientRect();
    const offsetX = (box.width - view.w / factor) / 2;
    const offsetY = (box.height - view.h / factor) / 2;
    // Recompute where the grabbed point sits now and shift the view so it
    // stays under the cursor.
    view.x = dragging.x - (event.clientX - box.left - offsetX) * factor;
    view.y = dragging.y - (event.clientY - box.top - offsetY) * factor;
    apply();
  });

  function endDrag(/** @type {PointerEvent} */ event) {
    press = null;
    if (!dragging) return;
    dragging = null;
    svg.releasePointerCapture?.(event.pointerId);
    svg.style.cursor = "";
  }
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  apply();

  return {
    fit() {
      view = { ...initial };
      apply();
    },
    /** @param {boolean} on */
    setLocked(on) {
      locked = on;
      // A press already under way when the lock came on would otherwise pan
      // on the next move, after the gesture was supposed to have stopped.
      if (on) {
        press = null;
        dragging = null;
        svg.style.cursor = "";
      }
    },
  };
}
