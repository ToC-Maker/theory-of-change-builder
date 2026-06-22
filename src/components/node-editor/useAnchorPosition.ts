// `useAnchorPosition` — repositions an overlay so it stays anchored
// next to a moving DOM element. Used by `NodeEditor` (anchored below
// the active node) and `EdgeEditor` (anchored to the connection
// midpoint).
//
// Subscriptions (per plan §3.2 / red-team "Anchor reposition on pan/zoom"):
//   - `camera` prop change → reposition. The canvas pans/zooms by
//     mutating camera; consumers re-render this hook with the new
//     camera object and we recompute from getBoundingClientRect, which
//     reflects the CSS-transformed position.
//   - ResizeObserver on the anchor → reposition. Catches anchor resize
//     (node width change, font reflow).
//   - ResizeObserver on the overlay (when `overlayRef` is provided) →
//     re-evaluates the flip decision. The MDXEditor in NodeEditor
//     expands lazily as its chunk lands, so the overlay height grows
//     after first mount; without re-observing we'd compute the flip
//     on the (small) initial height and never reposition once the
//     real height settled.
//   - Throttled MutationObserver on document.body → reposition.
//     Catches DOM-tree shifts that move the anchor without firing
//     ResizeObserver (sibling insert/delete, layout-only updates).
//     Throttled to one read per animation frame so a churning AI-edit
//     stream doesn't repeatedly thrash.
//
// Note: callers pass a `RefObject<HTMLElement>` rather than the element
// directly. Parents mutate `.current` on every render to point at the
// active anchor (e.g. selection switch). We mirror the current `.current`
// into local state so the ResizeObserver / MutationObserver effects
// re-subscribe when the underlying element changes — without the mirror,
// they'd silently keep observing the FIRST element captured at mount.
//
// Returns the {x, y} the caller should place the overlay at (in
// viewport coordinates, since `getBoundingClientRect` is viewport-relative
// and the overlay portals to `document.body` with `position: fixed`).
//
// ---------------------------------------------------------------------------
// Auto-flip (PR 7 feedback Editor: width-drag bug)
// ---------------------------------------------------------------------------
//
// User feedback (PR 7): "the node editor should probably be above or
// below the node, rather than to the side, as when I drag to change
// the width of the note, it moves the editor, which moves the width
// slider that I'm still dragging." NodeEditor now passes
// `placement: 'bottom'` so width-drag does not horizontally translate
// the editor under the cursor.
//
// To keep that promise on tall pages where a node near the bottom of
// the viewport would push the editor below the fold, we also accept
// `flip: true`. When set, the hook measures the overlay height (via
// `overlayRef`) and flips to top-placement if the natural placement
// would extend past the viewport. `'bottom'` is the only placement
// that supports flip today; EdgeEditor's `'right'` keeps the legacy
// no-flip behavior.
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

export type Placement = 'right' | 'left' | 'top' | 'bottom';

interface UseAnchorPositionArgs {
  /** The element to anchor against. */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * The overlay element being positioned. When set with `flip: true`
   * (and placement: 'bottom'), the hook reads the overlay's height
   * and flips to top-placement when the natural bottom-placement
   * would extend past the viewport. Optional: when unset, the hook
   * computes from the anchor alone (no flip).
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
   * doesn't fit below the anchor in the viewport. Requires
   * `overlayRef` to be set (otherwise we don't know the overlay's
   * height and can't make the decision). Other placements ignore the
   * flag (no flip).
   */
  flip?: boolean;
}

interface OverlayPosition {
  x: number;
  y: number;
}

function computePosition(
  anchorRect: DOMRect,
  overlayWidth: number,
  overlayHeight: number,
  placement: Placement,
  offset: number,
  flip: boolean,
  viewportWidth: number,
  viewportHeight: number,
): OverlayPosition {
  // For bottom-placement we horizontally CENTER the overlay on the
  // anchor (rather than aligning its left edge to the anchor's left).
  // Width-drag bug fix (PR 7): the canvas centers each column in its
  // section via `justify-content: center`. When the user drags the
  // width slider, the node grows, the column grows, and the column
  // re-centers — so the node's LEFT edge moves left by ΔW/2. The
  // node's CENTER, by contrast, stays put. Anchoring the editor's
  // center to the node's center keeps the slider track stationary in
  // screen space while the user drags. (Falls back to anchor.left
  // when we don't know the overlay's width yet, to avoid a flash at
  // x=anchor.left+anchor.width/2.)
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const bottomX = overlayWidth > 0 ? anchorCenterX - overlayWidth / 2 : anchorRect.left;
  // Clamp horizontally so the overlay doesn't run off the viewport
  // (e.g. a node in the rightmost column of a wide section).
  const clampedBottomX =
    overlayWidth > 0 && viewportWidth > 0
      ? Math.max(8, Math.min(bottomX, viewportWidth - overlayWidth - 8))
      : bottomX;

  if (placement === 'bottom' && flip && overlayHeight > 0) {
    // Available space below: viewport.height - anchor.bottom - offset.
    // If the overlay would extend below the viewport AND there's more
    // room above, flip to top. We compare the two spaces rather than
    // applying a hard "must fit" rule, so a node near the bottom on a
    // small viewport still picks the better of two bad options.
    const spaceBelow = viewportHeight - anchorRect.bottom - offset;
    const spaceAbove = anchorRect.top - offset;
    const fitsBelow = overlayHeight <= spaceBelow;
    const fitsAbove = overlayHeight <= spaceAbove;
    if (!fitsBelow && fitsAbove) {
      return { x: clampedBottomX, y: anchorRect.top - overlayHeight - offset };
    }
    if (!fitsBelow && !fitsAbove && spaceAbove > spaceBelow) {
      return { x: clampedBottomX, y: anchorRect.top - overlayHeight - offset };
    }
  }
  switch (placement) {
    case 'right':
      return { x: anchorRect.right + offset, y: anchorRect.top };
    case 'left':
      return { x: anchorRect.left - offset, y: anchorRect.top };
    case 'top':
      return { x: clampedBottomX, y: anchorRect.top - offset };
    case 'bottom':
      return { x: clampedBottomX, y: anchorRect.bottom + offset };
  }
}

export function useAnchorPosition(args: UseAnchorPositionArgs): OverlayPosition | null {
  const { anchorRef, overlayRef, camera, placement = 'right', offset = 8, flip = false } = args;
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
    const overlayHeight = overlayRect?.height ?? 0;
    const viewportWidth =
      typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
    const viewportHeight =
      typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 0;
    setPosition(
      computePosition(
        currentAnchor.getBoundingClientRect(),
        overlayWidth,
        overlayHeight,
        placement,
        offset,
        flip,
        viewportWidth,
        viewportHeight,
      ),
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
  }, [anchorEl, overlayEl, placement, offset, flip, camera.x, camera.y, camera.z]);

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
  }, [anchorEl, overlayEl, placement, offset, flip]);

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
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayEl, anchorEl, placement, offset, flip]);

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
  }, [anchorEl, overlayEl, placement, offset, flip]);

  return position;
}
