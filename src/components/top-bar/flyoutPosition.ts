// Flyout vertical positioning for FileMenu's side flyouts (PR 7
// feedback (62)): flyouts vertically align with their parent menu
// item, not the panel top. Lives in its own module (not FileMenu.tsx)
// so the pure math is unit-testable and the component file keeps
// exporting only components (react-refresh constraint).

// The alignment target is the macOS-menu convention: the flyout's
// FIRST ITEM lines up with the parent item. Both panels have a 1px
// border and 4px (`py-1`) vertical padding, so the flyout's outer top
// must sit (border 1 + padding 4) − (panel border 1) = 4px above the
// parent item's outer top.
export const FLYOUT_FIRST_ITEM_INSET_PX = 4;

// Minimum breathing room kept between the flyout's bottom edge and the
// viewport bottom when clamping.
export const FLYOUT_VIEWPORT_MARGIN_PX = 8;

/**
 * Compute the flyout's `top` (px, within the shared `relative`
 * containing block) so its first item aligns with the parent menu
 * item, clamped so the flyout neither overflows the viewport bottom
 * (Open recent can be tall) nor rises above the main panel's top.
 */
export function computeFlyoutTop(opts: {
  /** `offsetTop` of the main menu panel within the containing block. */
  panelOffsetTop: number;
  /** `offsetTop` of the parent menu item within the panel. */
  itemOffsetTop: number;
  /** Rendered height of the flyout panel (border box). */
  flyoutHeight: number;
  /** Viewport Y of the containing block's top. */
  anchorTop: number;
  /** `window.innerHeight`. */
  viewportHeight: number;
}): number {
  const desired = opts.panelOffsetTop + opts.itemOffsetTop - FLYOUT_FIRST_ITEM_INSET_PX;
  // Largest top that keeps the flyout's bottom inside the viewport
  // (with a margin). May go negative for very tall flyouts; the panel-
  // top floor below wins in that case.
  const maxTop =
    opts.viewportHeight - FLYOUT_VIEWPORT_MARGIN_PX - opts.flyoutHeight - opts.anchorTop;
  return Math.max(Math.min(desired, maxTop), opts.panelOffsetTop);
}
