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

  /** @type {{ x: number, y: number }|null} */
  let dragging = null;

  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // Without this the browser starts a text selection and the drag paints
    // every label it passes over blue.
    event.preventDefault();
    dragging = toUser(event);
    svg.setPointerCapture(event.pointerId);
    svg.style.cursor = "grabbing";
  });

  svg.addEventListener("pointermove", (event) => {
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
  };
}
