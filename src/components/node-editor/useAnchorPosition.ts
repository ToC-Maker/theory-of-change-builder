// `useAnchorPosition` — repositions an overlay so it stays anchored
// next to a moving DOM element. Used by `NodeEditor` (anchored to the
// active node) and `EdgeEditor` (anchored to the connection midpoint).
//
// Subscriptions (per plan §3.2 / red-team "Anchor reposition on pan/zoom"):
//   - `camera` prop change → reposition. The canvas pans/zooms by
//     mutating camera; consumers re-render this hook with the new
//     camera object and we recompute from getBoundingClientRect, which
//     reflects the CSS-transformed position.
//   - ResizeObserver on the anchor → reposition. Catches anchor resize
//     (node width change, font reflow).
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
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

export type Placement = 'right' | 'left' | 'top' | 'bottom';

interface UseAnchorPositionArgs {
  /** The element to anchor against. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Camera state; any change re-reads the anchor rect. */
  camera: { x: number; y: number; z: number };
  /** Side of the anchor to place the overlay on. Default: 'right'. */
  placement?: Placement;
  /** Pixels of gap between anchor and overlay. Default: 8. */
  offset?: number;
}

interface OverlayPosition {
  x: number;
  y: number;
}

function computePosition(el: HTMLElement, placement: Placement, offset: number): OverlayPosition {
  const rect = el.getBoundingClientRect();
  switch (placement) {
    case 'right':
      return { x: rect.right + offset, y: rect.top };
    case 'left':
      return { x: rect.left - offset, y: rect.top };
    case 'top':
      return { x: rect.left, y: rect.top - offset };
    case 'bottom':
      return { x: rect.left, y: rect.bottom + offset };
  }
}

export function useAnchorPosition(args: UseAnchorPositionArgs): OverlayPosition | null {
  const { anchorRef, camera, placement = 'right', offset = 8 } = args;
  const [position, setPosition] = useState<OverlayPosition | null>(null);

  // Track the anchor element in state so changes to `anchorRef.current`
  // (e.g. parent re-points at a different node on selection switch)
  // trigger effect re-subscription. The parent mutates `.current`
  // directly without changing the RefObject identity; without this
  // state-mirror, the ResizeObserver effect captures the FIRST element
  // at mount and silently keeps observing it after selection changes.
  // Updated unconditionally on every render — `setState` is a no-op
  // when the value is identical, so there's no extra render cost.
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(anchorRef.current);
  useEffect(() => {
    if (anchorRef.current !== anchorEl) setAnchorEl(anchorRef.current);
  });

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
    setPosition(computePosition(anchorEl, placement, offset));
  }, [anchorEl, placement, offset, camera.x, camera.y, camera.z]);

  // ResizeObserver. We attach to the anchor itself so width/height
  // changes (node text reflow, AI edit changing the node content) bump
  // the overlay too. Keyed on `anchorEl` so a selection switch re-
  // attaches to the new element.
  useEffect(() => {
    if (!anchorEl) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setPosition(computePosition(anchorEl, placement, offset));
    });
    ro.observe(anchorEl);
    return () => ro.disconnect();
  }, [anchorEl, placement, offset]);

  // Throttled MutationObserver on document.body. Catches DOM mutations
  // that don't trigger ResizeObserver on the anchor (sibling inserts,
  // section/column changes that re-flow this node). We throttle to one
  // rAF per burst.
  useEffect(() => {
    if (!anchorEl) return;
    if (typeof MutationObserver === 'undefined') return;
    const root = document.body;
    let rafId: number | null = null;
    const recompute = () => {
      rafId = null;
      setPosition(computePosition(anchorEl, placement, offset));
    };
    const mo = new MutationObserver(() => {
      if (rafId !== null) return;
      rafId =
        typeof requestAnimationFrame !== 'undefined'
          ? requestAnimationFrame(recompute)
          : (setTimeout(recompute, 0) as unknown as number);
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [anchorEl, placement, offset]);

  return position;
}
