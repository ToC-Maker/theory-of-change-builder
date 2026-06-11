import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

/**
 * Horizontally clamp an absolutely-positioned popover so it stays fully
 * visible inside the viewport AND inside every overflow-clipping ancestor.
 *
 * Why measurement instead of a static side anchor: the composer popovers
 * live inside the chat panel, whose content wrapper is `overflow-hidden`
 * (ChatInterface "Chat Content" div). A popover wider than the space to
 * its anchor's right gets clipped at the panel edge — it can never
 * "extend into the canvas". Round 1 flipped the anchor from `right-0` to
 * `left-0` (commit 4c3f484) on exactly that assumption and just moved the
 * clipping to the other edge (PR #34 feedback #60). Both static choices
 * are wrong at some panel width, so we measure.
 *
 * Mechanics: the popover renders `absolute` with its natural position at
 * the anchor's left edge (`left: 0` relative to the `relative` wrapper).
 * On open we read the wrapper's viewport position (`offsetParent` — the
 * translate-invariant anchor), the popover's `offsetWidth`, and the
 * intersection of the viewport with every ancestor whose computed
 * `overflow-x` is non-`visible`. The returned `style.left` shifts the
 * popover the minimum distance that keeps it inside that intersection;
 * when nothing would clip, it stays at the anchor's left edge. When the
 * popover is wider than the available space, the LEFT edge wins (content
 * starts on-screen and clips at the far side).
 *
 * Re-measures on window resize while open (the panel width is
 * viewport-responsive: w-1/4 clamped to [280px, 400px]).
 */
export function useClampedPopoverX(open: boolean): {
  ref: RefObject<HTMLDivElement | null>;
  style: CSSProperties;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [leftPx, setLeftPx] = useState(0);

  useLayoutEffect(() => {
    if (!open) {
      setLeftPx(0);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // offsetParent is the positioned (`relative`) wrapper the popover is
      // anchored to. Its rect is unaffected by the shift we apply to the
      // popover itself, so re-measuring is idempotent (no compounding).
      const anchor = el.offsetParent as HTMLElement | null;
      if (!anchor) return;
      const anchorLeft = anchor.getBoundingClientRect().left;
      const width = el.offsetWidth;
      const MARGIN = 8;

      let minLeft = MARGIN;
      let maxRight = window.innerWidth - MARGIN;
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'visible') {
          const r = a.getBoundingClientRect();
          minLeft = Math.max(minLeft, r.left + MARGIN);
          maxRight = Math.min(maxRight, r.right - MARGIN);
        }
      }

      let left = 0; // natural position: anchor's left edge
      if (anchorLeft + left + width > maxRight) {
        left = maxRight - width - anchorLeft;
      }
      if (anchorLeft + left < minLeft) {
        left = minLeft - anchorLeft;
      }
      setLeftPx(left);
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  return { ref, style: { left: leftPx } };
}
