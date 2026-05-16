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
//   - Throttled MutationObserver on the canvas container → reposition.
//     Catches DOM-tree shifts that move the anchor without firing
//     ResizeObserver (sibling insert/delete, layout-only updates).
//     Throttled to one read per animation frame so a churning AI-edit
//     stream doesn't repeatedly thrash.
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
  /**
   * Optional container element to observe for DOM-tree mutations.
   * Defaults to `document.body`. Test shims need this seam since jsdom's
   * MutationObserver shim may not survive global re-installs.
   */
  mutationRoot?: HTMLElement | null;
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
  const { anchorRef, camera, placement = 'right', offset = 8, mutationRoot } = args;
  const [position, setPosition] = useState<OverlayPosition | null>(null);

  // Synchronous read on every camera change. We DO want this in the
  // render path: camera updates 60fps from `useZoomPan` already commit
  // synchronously, and useEffect would leave the overlay one frame
  // behind. The cost is one getBoundingClientRect per render with the
  // hook mounted — same cost as React Aria / Floating UI's
  // useFloating with `whileElementsMounted: autoUpdate`.
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) {
      setPosition(null);
      return;
    }
    setPosition(computePosition(el, placement, offset));
  }, [anchorRef, placement, offset, camera.x, camera.y, camera.z]);

  // ResizeObserver. We attach to the anchor itself so width/height
  // changes (node text reflow, AI edit changing the node content) bump
  // the overlay too.
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setPosition(computePosition(el, placement, offset));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchorRef, placement, offset]);

  // Throttled MutationObserver on a container. Catches DOM mutations
  // that don't trigger ResizeObserver on the anchor (sibling inserts,
  // section/column changes that re-flow this node). We throttle to one
  // rAF per burst.
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    if (typeof MutationObserver === 'undefined') return;
    const root = mutationRoot ?? document.body;
    let rafId: number | null = null;
    const recompute = () => {
      rafId = null;
      if (!anchorRef.current) return;
      setPosition(computePosition(anchorRef.current, placement, offset));
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
  }, [anchorRef, placement, offset, mutationRoot]);

  return position;
}
