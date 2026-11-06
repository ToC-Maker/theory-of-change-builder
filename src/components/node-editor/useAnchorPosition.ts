// `useAnchorPosition` — repositions an overlay so it stays anchored
// next to a moving DOM element. Used by `NodeEditor` (anchored below
// the active node) and `EdgeEditor` (anchored to the connection
// midpoint).
//
// Subscriptions:
//   - `camera` prop change → reposition. The canvas pans/zooms by
//     mutating camera; consumers re-render this hook with the new
//     camera object and we recompute from getBoundingClientRect, which
//     reflects the CSS-transformed position.
//   - ResizeObserver on the anchor → reposition. Catches anchor resize
//     (node width change, font reflow).
//   - ResizeObserver on the overlay and on its direct children (when
//     `overlayRef` is provided; the children are those present when the
//     observer attaches) → re-evaluates the flip decision and the height
//     cap. The MDXEditor in NodeEditor expands lazily as its chunk
//     lands, so the overlay height grows after first mount; without
//     re-observing we'd compute the flip on the (small) initial height
//     and never reposition once the real height settled. Once the
//     overlay is height-capped its box stops growing while its content
//     keeps going, which only the children report.
//   - Throttled MutationObserver on document.body → reposition.
//     Catches DOM-tree shifts that move the anchor without firing
//     ResizeObserver (sibling insert/delete, layout-only updates).
//     Throttled to one read per animation frame so a churning AI-edit
//     stream doesn't repeatedly thrash.
//   - Window `resize` → reposition now and on every frame for a
//     moment. The canvas refits and re-centres itself a debounce after
//     a resize without touching the camera, so the anchor moves with
//     none of the signals above, and the visible area changed too.
//
// Note: callers pass a `RefObject<HTMLElement>` rather than the element
// directly. Parents mutate `.current` on every render to point at the
// active anchor (e.g. selection switch). We mirror the current `.current`
// into local state so the ResizeObserver / MutationObserver effects
// re-subscribe when the underlying element changes — without the mirror,
// they'd silently keep observing the FIRST element captured at mount.
//
// Returns the {x, y, maxHeight} the caller should place the overlay at
// (in viewport coordinates, since `getBoundingClientRect` is
// viewport-relative and the overlay portals to `document.body` with
// `position: fixed`).
//
// ---------------------------------------------------------------------------
// Placement and auto-flip
// ---------------------------------------------------------------------------
//
// NodeEditor uses `placement: 'bottom'` rather than 'right': beside the
// node, dragging the width slider widens the node, which moves the
// editor and with it the slider track still under the cursor. Below the
// node (centered on it) the track stays put during a width drag.
//
// To keep the editor on screen when a node near the bottom of the
// viewport would push it below the fold, we also accept `flip: true`.
// When set, the hook measures the overlay height (via `overlayRef`) and
// flips to the other side if the overlay doesn't fit on the preferred
// one: `'bottom'` flips to `'top'` when that side has more room, and
// `'right'` flips to `'left'` when it would pass the window's right edge
// and the left side fits.
//
// ---------------------------------------------------------------------------
// Containment: a measured overlay stays inside the visible area
// ---------------------------------------------------------------------------
//
// The visible area is the window minus `topInset` (the fixed top bar),
// with an 8px margin on every side. Once the overlay has been measured,
// the returned `{x, y}` keeps it inside that area, and `maxHeight` is the
// height the overlay may take there: the room on the side of the anchor
// it was placed on, so a tall overlay (long node details, a short
// window) must scroll internally instead of running off the screen. The
// caller applies `maxHeight` and `overflow-y: auto`. When neither side
// of the anchor leaves at least `MIN_OVERLAY_HEIGHT`, the overlay is
// allowed to cover the anchor rather than shrink into a sliver. An
// anchor panned out of the visible area leaves the overlay pinned to the
// nearest edge, still usable. Before the overlay has been measured (its
// first frame, or no `overlayRef`) it is placed from the anchor alone:
// `y` is not clamped and `maxHeight` is null.
//
// The overlay's height is read as its content height (`scrollHeight`),
// not its box: a capped box is shorter than its content, and deciding
// the side from the capped box would flip-flop with the cap it was
// given last time.
import { useEffect, useState } from 'react';
import type { RefObject, WheelEvent } from 'react';

export type Placement = 'right' | 'left' | 'top' | 'bottom';

interface UseAnchorPositionArgs {
  /** The element to anchor against. */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * The overlay element being positioned. The hook reads its width (to
   * center it and keep it between the window's side edges, and to flip
   * right to left) and its content height (to flip bottom to top, to
   * keep it inside the vertical band and to derive `maxHeight`).
   * Optional: when unset, the hook computes from the anchor alone: no
   * flip, no clamping, `maxHeight` null.
   */
  overlayRef?: RefObject<HTMLElement | null>;
  /** Camera state; any change re-reads the anchor rect. */
  camera: { x: number; y: number; z: number };
  /** Side of the anchor to place the overlay on. Default: 'right'. */
  placement?: Placement;
  /** Pixels of gap between anchor and overlay. Default: 8. */
  offset?: number;
  /**
   * When true, the hook may flip 'bottom' → 'top' if the overlay
   * doesn't fit below the anchor in the viewport, and 'right' → 'left'
   * if it doesn't fit beside it. Requires `overlayRef` to be set
   * (otherwise we don't know the overlay's size and can't make the
   * decision). 'top' and 'left' ignore the flag.
   */
  flip?: boolean;
  /**
   * Height (px) of fixed chrome at the top of the window that the
   * overlay must stay below. Default: 0.
   */
  topInset?: number;
}

interface OverlayPosition {
  x: number;
  y: number;
  /**
   * The tallest the overlay may be where it was placed, or null while
   * its size is unknown. Apply as `max-height` with `overflow-y: auto`.
   */
  maxHeight: number | null;
}

// How long after a window resize the overlay keeps following its
// anchor frame by frame: longer than the canvas's own refit debounce.
const RESIZE_FOLLOW_MS = 500;
// Gap kept between the overlay and the edges of the visible area.
const EDGE_MARGIN = 8;
// Below this height a side of the anchor is not worth shrinking the
// overlay into; it covers the anchor instead.
const MIN_OVERLAY_HEIGHT = 240;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

interface ComputeArgs {
  anchorRect: DOMRect;
  overlayWidth: number;
  /** Content height of the overlay, 0 while it is unmeasured. */
  overlayHeight: number;
  placement: Placement;
  offset: number;
  flip: boolean;
  viewportWidth: number;
  viewportHeight: number;
  topInset: number;
}

function computePosition(args: ComputeArgs): OverlayPosition {
  const {
    anchorRect,
    overlayWidth,
    overlayHeight,
    placement,
    offset,
    flip,
    viewportWidth,
    viewportHeight,
    topInset,
  } = args;
  const minX = EDGE_MARGIN;
  const maxX = viewportWidth - EDGE_MARGIN;
  const minY = topInset + EDGE_MARGIN;
  const maxY = viewportHeight - EDGE_MARGIN;
  const bandHeight = Math.max(0, maxY - minY);
  const sized = overlayHeight > 0 && viewportHeight > 0;
  const clampX = (x: number) =>
    overlayWidth > 0 && viewportWidth > 0 ? clamp(x, minX, maxX - overlayWidth) : x;

  if (placement === 'bottom' || placement === 'top') {
    // Horizontally CENTER the overlay on the anchor (rather than
    // aligning its left edge to the anchor's left). Width drag: the
    // canvas centers each column in its section via
    // `justify-content: center`. When the user drags the width slider,
    // the node grows, the column grows, and the column re-centers — so
    // the node's LEFT edge moves left by ΔW/2. The node's CENTER, by
    // contrast, stays put. Anchoring the editor's center to the node's
    // center keeps the slider track stationary in screen space while
    // the user drags. (Falls back to anchor.left when we don't know the
    // overlay's width yet, to avoid a flash at
    // x=anchor.left+anchor.width/2.)
    const anchorCenterX = anchorRect.left + anchorRect.width / 2;
    const x = clampX(overlayWidth > 0 ? anchorCenterX - overlayWidth / 2 : anchorRect.left);
    if (!sized) {
      return {
        x,
        y: placement === 'top' ? anchorRect.top - offset : anchorRect.bottom + offset,
        maxHeight: null,
      };
    }
    const spaceBelow = maxY - (anchorRect.bottom + offset);
    const spaceAbove = anchorRect.top - offset - minY;
    // Flip to the larger side when the overlay doesn't fit on the
    // preferred one: with room on neither, the larger still shows more.
    const side =
      placement === 'bottom' && flip && overlayHeight > spaceBelow && spaceAbove > spaceBelow
        ? 'top'
        : placement;
    // An anchor outside the visible area has no side to be next to:
    // the whole band is open to the overlay.
    const anchorVisible = anchorRect.bottom > minY && anchorRect.top < maxY;
    const space = !anchorVisible ? bandHeight : side === 'bottom' ? spaceBelow : spaceAbove;
    const maxHeight = Math.min(
      bandHeight,
      Math.max(space, Math.min(overlayHeight, MIN_OVERLAY_HEIGHT)),
    );
    const height = Math.min(overlayHeight, maxHeight);
    const y = side === 'bottom' ? anchorRect.bottom + offset : anchorRect.top - offset - height;
    return { x, y: clamp(y, minY, maxY - height), maxHeight };
  }

  // 'right' / 'left': beside the anchor, top edges aligned.
  const rightX = anchorRect.right + offset;
  const leftX = anchorRect.left - offset - overlayWidth;
  const known = overlayWidth > 0 && viewportWidth > 0;
  const useLeft =
    placement === 'left' || (flip && known && rightX + overlayWidth > maxX && leftX >= minX);
  const x = clampX(useLeft ? leftX : rightX);
  if (!sized) return { x, y: anchorRect.top, maxHeight: null };
  const height = Math.min(overlayHeight, bandHeight);
  return { x, y: clamp(anchorRect.top, minY, maxY - height), maxHeight: bandHeight };
}

/**
 * `onWheel` for a scrollable overlay. The canvas pans on any wheel event
 * in the document and cancels it, so without this a wheel over a
 * height-capped overlay would pan the canvas instead of scrolling the
 * overlay. Ctrl/Cmd+wheel still reaches the canvas as a zoom, and so does
 * a wheel over an overlay that has nothing to scroll.
 */
export function keepWheelInOverlay(e: WheelEvent) {
  const overlay = e.currentTarget;
  if (!e.ctrlKey && !e.metaKey && overlay.scrollHeight > overlay.clientHeight) {
    e.stopPropagation();
  }
}

export function useAnchorPosition(args: UseAnchorPositionArgs): OverlayPosition | null {
  const {
    anchorRef,
    overlayRef,
    camera,
    placement = 'right',
    offset = 8,
    flip = false,
    topInset = 0,
  } = args;
  const [position, setPosition] = useState<OverlayPosition | null>(null);

  // Track the anchor element in state so changes to `anchorRef.current`
  // (e.g. parent re-points at a different node on selection switch)
  // trigger effect re-subscription. The parent mutates `.current`
  // directly without changing the RefObject identity; without this
  // state-mirror, the ResizeObserver effect captures the FIRST element
  // at mount and silently keeps observing it after selection changes.
  //
  // Runs on every render and only writes when `.current` actually
  // changes — React bails out on identical setState, so the no-op
  // path costs one comparison.
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(anchorRef.current);
  // Intentionally runs every render. Listing deps would defeat the
  // purpose (the whole point is to detect `.current` changes that the
  // RefObject identity doesn't surface). The `if` short-circuits the
  // infinite-update loop the linter is warning about.
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  useEffect(() => {
    if (anchorRef.current !== anchorEl) setAnchorEl(anchorRef.current);
  });

  // Mirror overlayRef the same way (independent from anchorEl since
  // it has a different identity / lifetime). Only relevant when the
  // caller wires it for flip computation.
  const [overlayEl, setOverlayEl] = useState<HTMLElement | null>(overlayRef?.current ?? null);
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  useEffect(() => {
    const next = overlayRef?.current ?? null;
    if (next !== overlayEl) setOverlayEl(next);
  });

  // Single recompute path used by every subscription. Reads the
  // anchor + overlay rects + viewport size and feeds them to
  // `computePosition`. Closes over the latest `anchorEl` / `overlayEl`
  // / `placement` / etc. via the surrounding effects' deps lists; we
  // re-bind it inside each effect so its captured values stay fresh.
  function recompute(currentAnchor: HTMLElement, currentOverlay: HTMLElement | null) {
    const overlayRect = currentOverlay?.getBoundingClientRect();
    const overlayWidth = overlayRect?.width ?? 0;
    // Content height, not box height: a capped overlay scrolls, so its
    // box (`height`) is shorter than its content (`scrollHeight`, which
    // excludes the border the box adds back).
    const overlayHeight =
      currentOverlay && overlayRect
        ? currentOverlay.scrollHeight + overlayRect.height - currentOverlay.clientHeight
        : 0;
    const viewportWidth =
      typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
    const viewportHeight =
      typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 0;
    const next = computePosition({
      anchorRect: currentAnchor.getBoundingClientRect(),
      overlayWidth,
      overlayHeight,
      placement,
      offset,
      flip,
      viewportWidth,
      viewportHeight,
      topInset,
    });
    // Per-frame callers (resize follow, DOM mutations) mostly land on the
    // same spot: keep the old object so the overlay doesn't re-render.
    setPosition((prev) =>
      prev && prev.x === next.x && prev.y === next.y && prev.maxHeight === next.maxHeight
        ? prev
        : next,
    );
  }

  // Re-read the anchor rect after every camera change. useEffect (not
  // useLayoutEffect) is fine here: the editor portals with position:
  // fixed at z-150, so the first paint after a pan briefly shows the
  // last position before this effect commits — visually indistinguishable
  // from a single-frame layout pass. Cost: one getBoundingClientRect
  // per camera update with the hook mounted (same shape as Floating
  // UI's `whileElementsMounted: autoUpdate`).
  useEffect(() => {
    if (!anchorEl) {
      setPosition(null);
      return;
    }
    recompute(anchorEl, overlayEl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, overlayEl, placement, offset, flip, topInset, camera.x, camera.y, camera.z]);

  // ResizeObserver on the anchor. We attach to the anchor itself so
  // width/height changes (node text reflow, AI edit changing the node
  // content) bump the overlay too. Keyed on `anchorEl` so a selection
  // switch re-attaches to the new element.
  useEffect(() => {
    if (!anchorEl) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recompute(anchorEl, overlayEl));
    ro.observe(anchorEl);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, overlayEl, placement, offset, flip, topInset]);

  // ResizeObserver on the overlay. The overlay's own height changes
  // mid-life (e.g. NodeEditor's MDXEditor chunk lands and the
  // accordion expands). When `flip` is on we need to re-evaluate the
  // bottom-vs-top decision against the new height. Without this
  // observer, the flip would be a one-shot read at mount and stale
  // thereafter.
  useEffect(() => {
    if (!overlayEl || !anchorEl) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recompute(anchorEl, overlayEl));
    ro.observe(overlayEl);
    // A height-capped overlay's box stops growing while its content keeps
    // going (its own scrollbar takes over), so watch the content too.
    for (const child of Array.from(overlayEl.children)) ro.observe(child);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayEl, anchorEl, placement, offset, flip, topInset]);

  // Throttled MutationObserver on document.body. Catches DOM mutations
  // that don't trigger ResizeObserver on the anchor (sibling inserts,
  // section/column changes that re-flow this node). We throttle to one
  // rAF per burst.
  useEffect(() => {
    if (!anchorEl) return;
    if (typeof MutationObserver === 'undefined') return;
    const root = document.body;
    let rafId: number | null = null;
    const fire = () => {
      rafId = null;
      recompute(anchorEl, overlayEl);
    };
    const mo = new MutationObserver(() => {
      if (rafId !== null) return;
      rafId =
        typeof requestAnimationFrame !== 'undefined'
          ? requestAnimationFrame(fire)
          : (setTimeout(fire, 0) as unknown as number);
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, overlayEl, placement, offset, flip, topInset]);

  useEffect(() => {
    if (!anchorEl) return;
    let rafId: number | null = null;
    let followUntil = 0;
    const follow = () => {
      rafId = null;
      recompute(anchorEl, overlayEl);
      if (performance.now() < followUntil) rafId = requestAnimationFrame(follow);
    };
    const onResize = () => {
      recompute(anchorEl, overlayEl);
      followUntil = performance.now() + RESIZE_FOLLOW_MS;
      if (rafId === null) rafId = requestAnimationFrame(follow);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, overlayEl, placement, offset, flip, topInset]);

  return position;
}
