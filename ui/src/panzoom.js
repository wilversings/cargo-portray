// Pan and zoom for the rendered SVG, by moving its viewBox.
//
// This replaces the svg-pan-zoom package: a hundred lines of viewBox
// arithmetic is a better trade than a dependency, and it was the last thing
// standing between this viewer and needing no package manager at all.
//
// Every gesture is read from pointer events, which is what lets one set of
// handlers serve a mouse and a touchscreen at once: one pointer down and
// moving is a pan either way, and what the wheel does with a mouse a pinch
// does with two fingers. The pinch has to be arithmetic here rather than the
// browser's own zoom because `touch-action: none` — which is what stops a drag
// across the diagram from scrolling the page instead — takes both gestures
// away together.
//
// The third is the one a hand holding a phone can make on its own: tap twice
// and slide up to come in, down to go out. It goes by several names — a
// double-tap drag, one-finger zoom, Android's "quick scale" — and it is the
// only zoom available to a thumb, which is why it is worth the state below.

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
   * A locked diagram ignores the gestures that move it — the wheel, the drag
   * and the pinch — and nothing else: a click still selects, because selecting
   * a node does not shift the picture the reader has framed.
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

  /**
   * Where the drawing sits inside the element as it is framed now: the factor
   * that turns pixels into user units, and the half of the letterbox that is
   * not drawing and has to come off before scaling.
   */
  function geometry() {
    const box = svg.getBoundingClientRect();
    const factor = scale();
    return {
      box,
      factor,
      offsetX: (box.width - view.w / factor) / 2,
      offsetY: (box.height - view.h / factor) / 2,
    };
  }

  /** @param {{ clientX: number, clientY: number }} point */
  function toUser(point) {
    const { box, factor, offsetX, offsetY } = geometry();
    return {
      x: view.x + (point.clientX - box.left - offsetX) * factor,
      y: view.y + (point.clientY - box.top - offsetY) * factor,
    };
  }

  /**
   * Moves the view so that `user` lands under `point`.
   *
   * It is the one move every gesture makes: a drag holds the grabbed point
   * under the cursor, and a zoom holds the cursor — or the middle of a pinch —
   * over whatever it was pointing at.
   *
   * @param {{ x: number, y: number }} user
   * @param {{ clientX: number, clientY: number }} point
   */
  function anchor(user, point) {
    const { box, factor, offsetX, offsetY } = geometry();
    view.x = user.x - (point.clientX - box.left - offsetX) * factor;
    view.y = user.y - (point.clientY - box.top - offsetY) * factor;
  }

  /**
   * @param {number} width the viewBox width asked for, before the limits
   * @param {{ x: number, y: number }} user the point to hold still
   * @param {{ clientX: number, clientY: number }} point where to hold it
   */
  function zoomTo(width, user, point) {
    const w = Math.min(Math.max(width, initial.w / 200), initial.w * 40);
    view = { ...view, w, h: view.h * (w / view.w) };
    anchor(user, point);
    apply();
  }

  svg.addEventListener(
    "wheel",
    (event) => {
      if (locked) return;
      event.preventDefault();
      zoomTo(view.w * Math.exp(event.deltaY * 0.002), toUser(event), event);
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
   * mean a drag; a click — or a tap — that stays put is left alone to land
   * where it fell.
   */
  const DRAG_SLOP = 3;

  /** Every pointer currently down on the diagram, by id. */
  /** @type {Map<number, { clientX: number, clientY: number }>} */
  const down = new Map();
  /** @type {{ user: { x: number, y: number }, x: number, y: number, id: number }|null} */
  let press = null;
  /** @type {{ x: number, y: number }|null} */
  let dragging = null;
  /**
   * A pinch, measured against where it started rather than against the last
   * frame: two fingers that spread and close again land back where they were,
   * and no rounding accumulates over a long gesture.
   * @type {{ distance: number, user: { x: number, y: number }, w: number }|null}
   */
  let pinch = null;

  /**
   * How near in time and place a second tap has to land to be the second half
   * of a double tap. The window is the usual one; the slop is wider than
   * `DRAG_SLOP` because two taps aimed at the same thing land a few pixels
   * apart, and a thumb is not a mouse.
   */
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_SLOP = 30;
  /**
   * How fast the slide scales: about ninety pixels to a doubling, which puts a
   * useful range inside a thumb's reach without a twitch throwing the view.
   */
  const QUICK_ZOOM_RATE = 0.008;

  /** The last tap that could still be the first half of a double one. */
  /** @type {{ at: number, x: number, y: number }|null} */
  let lastTap = null;
  /**
   * A double-tap drag under way.
   *
   * `engaged` is the same bargain the pan makes: until the finger has actually
   * travelled, the gesture is still an ordinary double tap and the `dblclick`
   * built out of it must reach the node it landed on, which is how a reader
   * focuses an artifact. Once it has travelled, the pointer is captured — and
   * a captured pointer takes its own `click` and `dblclick` with it, so
   * zooming never also focuses something.
   * @type {{ id: number, y: number, point: { clientX: number, clientY: number },
   *          user: { x: number, y: number }, w: number, engaged: boolean }|null}
   */
  let quick = null;

  /** The middle of the two fingers, and how far apart they are. */
  function span() {
    const [a, b] = [...down.values()];
    return {
      clientX: (a.clientX + b.clientX) / 2,
      clientY: (a.clientY + b.clientY) / 2,
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    };
  }

  function endPan() {
    press = null;
    dragging = null;
    svg.style.cursor = "";
  }

  /**
   * Whether this press is the second tap of a double tap — and so the start of
   * a slide that zooms rather than of a drag that pans.
   *
   * Touch only. A mouse has a wheel, and a double click that drags means
   * something already on the desktop: it pans, the way every other drag does.
   *
   * @param {PointerEvent} event
   */
  function startsQuickZoom(event) {
    if (event.pointerType !== "touch" || !lastTap) return false;
    return (
      performance.now() - lastTap.at < DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < DOUBLE_TAP_SLOP
    );
  }

  svg.addEventListener("pointerdown", (event) => {
    if (locked || event.button !== 0) return;
    // Without this the browser starts a text selection and the drag paints
    // every label it passes over blue. It does not stop the click.
    event.preventDefault();
    down.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });

    if (down.size === 1 && startsQuickZoom(event)) {
      // Not a press: this finger is here to zoom, and a pan as well would drag
      // the sheet out from under the point it is zooming around.
      lastTap = null;
      quick = {
        id: event.pointerId,
        y: event.clientY,
        point: { clientX: event.clientX, clientY: event.clientY },
        user: toUser(event),
        w: view.w,
        engaged: false,
      };
      return;
    }

    if (down.size === 2) {
      // A second finger makes the gesture a pinch, so the pan the first one
      // had started is dropped rather than fought with — both fingers move in
      // a pinch, and one of them dragging the sheet as well would double every
      // shift. Both are captured, because a pinch that ends with a finger off
      // the drawing must still be a pinch.
      endPan();
      quick = null;
      const start = span();
      pinch = { distance: start.distance, user: toUser(start), w: view.w };
      for (const id of down.keys()) svg.setPointerCapture(id);
      return;
    }
    if (down.size > 2) return;
    press = { user: toUser(event), x: event.clientX, y: event.clientY, id: event.pointerId };
  });

  svg.addEventListener("pointermove", (event) => {
    if (down.has(event.pointerId)) {
      down.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    }

    if (pinch) {
      if (down.size < 2) return;
      const now = span();
      // Fingers landing on the same pixel have no span to divide by; the next
      // move will have one.
      if (now.distance === 0) return;
      // The middle of the pinch is where the zoom is anchored, so fingers that
      // travel together pan while they scale — the two are one gesture.
      zoomTo(pinch.w * (pinch.distance / now.distance), pinch.user, now);
      return;
    }

    if (quick && quick.id === event.pointerId) {
      if (!quick.engaged) {
        if (Math.hypot(event.clientX - quick.point.clientX, event.clientY - quick.y) < DRAG_SLOP) {
          return;
        }
        quick.engaged = true;
        svg.setPointerCapture(quick.id);
      }
      // Up is in and down is out, around the point that was tapped: the finger
      // slides away from it, and what it was aimed at stays where it was put.
      const width = quick.w * Math.exp((event.clientY - quick.y) * QUICK_ZOOM_RATE);
      zoomTo(width, quick.user, quick.point);
      return;
    }

    if (press && !dragging) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP) return;
      dragging = press.user;
      svg.setPointerCapture(press.id);
      svg.style.cursor = "grabbing";
    }
    if (!dragging) return;
    // Recompute where the grabbed point sits now and shift the view so it
    // stays under the cursor.
    anchor(dragging, event);
    apply();
  });

  function lift(/** @type {PointerEvent} */ event) {
    // A tap is a finger that went down, did nothing, and came up again: not a
    // drag, not half of a pinch, and not cancelled out from under the reader.
    // Only that is worth remembering, because only that can be the first half
    // of a double tap.
    const tapped =
      event.type === "pointerup" &&
      event.pointerType === "touch" &&
      press?.id === event.pointerId &&
      !dragging &&
      !pinch;
    lastTap = tapped ? { at: performance.now(), x: event.clientX, y: event.clientY } : null;

    down.delete(event.pointerId);
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    // A finger taken off a pinch does not hand the drawing to the one left
    // behind: that finger went down to scale, not to drag, and a view that
    // lurched as the pinch ended would undo the framing just chosen.
    if (down.size < 2) pinch = null;
    if (quick?.id === event.pointerId) quick = null;
    if (press?.id === event.pointerId) endPan();
  }
  svg.addEventListener("pointerup", lift);
  svg.addEventListener("pointercancel", lift);

  apply();

  return {
    fit() {
      view = { ...initial };
      apply();
    },
    /** @param {boolean} on */
    setLocked(on) {
      locked = on;
      // A gesture already under way when the lock came on would otherwise move
      // the diagram on its next event, after it was supposed to have stopped.
      if (on) {
        down.clear();
        pinch = null;
        quick = null;
        lastTap = null;
        endPan();
      }
    },
  };
}
