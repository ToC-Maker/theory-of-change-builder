import { useEffect, useMemo, useState } from 'react';

// Reserved viewport space (px) the canvas auto-fit keeps clear of the
// fixed chrome on each side, plus a shared 24px breathing-room pad so
// the fitted canvas never butts against a viewport edge (PR 1 dropped
// the JsonDropdown and the old bottom reserve; symmetric pads restored
// the centered look the reviewer asked for).
//
// `left` mirrors the *rendered* chat drawer width (ChatInterface root:
// `w-12` collapsed; `md:w-1/4 md:min-w-[280px] md:max-w-[400px]`
// expanded — PR #34 round-2 feedback 55 established the clamp; below
// md the drawer is a mobile overlay and the legacy quarter-width
// reserve is kept unchanged).
export const VIEWPORT_PAD_PX = 24;

// `top` mirrors the TopBar's rendered height the same way `left`
// mirrors the drawer's CSS contract: 40px row (`min-h-[40px]`,
// TopBar.tsx — shortened by PR #34 fb4 (70) from the round-2 52px; no
// vertical padding on the container) + 1px border-b. The legacy
// reserve said 64px, which skewed the top band 11px wider than the
// bottom at every viewport size (PR #34 fb3 known-issue K2);
// scripts/test-viewport-bands.mjs pins the mirror against the real
// DOM, scripts/test-topbar-geometry.mjs pins the bar height itself,
// and TopBar.responsive.test.tsx cross-checks this constant against
// the row's min-h class. ChatInterface's drawer `top` derives from
// this constant too.
export const TOP_BAR_HEIGHT_PX = 41;

// The drawer clamp reads window.innerWidth, so the reserve must also
// recompute when the window resizes (PR #34 fb3 known-issue K1: a
// 1920 → 1280 live resize left the 1920-era reserve in place — 80px
// band asymmetry — until a drawer toggle or reload). Debounced so
// drag-resizing doesn't thrash the canvas autofit; 100ms matches
// useZoomPan's own resize debounce.
const RESIZE_DEBOUNCE_MS = 100;

export interface ViewportOffset {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function computeViewportOffset(
  isLeftPanelCollapsed: boolean,
  innerWidth: number,
): ViewportOffset {
  const drawerWidth = isLeftPanelCollapsed
    ? 48
    : innerWidth >= 768
      ? Math.min(400, Math.max(280, innerWidth * 0.25))
      : Math.floor(innerWidth * 0.25);
  return {
    left: drawerWidth + VIEWPORT_PAD_PX,
    top: TOP_BAR_HEIGHT_PX + VIEWPORT_PAD_PX,
    right: VIEWPORT_PAD_PX,
    bottom: VIEWPORT_PAD_PX,
  };
}

export function useViewportOffset(isLeftPanelCollapsed: boolean): ViewportOffset {
  const [innerWidth, setInnerWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handleResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setInnerWidth(window.innerWidth), RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timer);
    };
  }, []);

  // Memoized so the offset's identity only changes when its inputs do —
  // unrelated App re-renders must not re-trigger useZoomPan's fit-zoom
  // effect.
  return useMemo(
    () => computeViewportOffset(isLeftPanelCollapsed, innerWidth),
    [isLeftPanelCollapsed, innerWidth],
  );
}
