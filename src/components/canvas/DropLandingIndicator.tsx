// Drag landing indicator — the tinted strip that shows where a dragged
// node would land when it is over the gap between two columns (a new
// column). Deliberately NOT node-shaped: a second node outline next to the
// cursor-following copy would be indistinguishable from the node being
// dragged. Over a column body the copy itself snaps into place, so this
// draws nothing there.
//
// Absolutely positioned, pointer-transparent overlay in the canvas
// transform stack, so it never reflows the columns and moves with
// pan/zoom. It exists only while a drag is in flight (the parent
// renders it from `dragState`), so it is gone on drop, Escape, cancel
// and unmount, and is never present when a chart is exported.
import type { LandingIndicator } from '../../utils/landingIndicator';

/** Thickness of the strip's centre line on screen, so it stays visible at low zoom. */
const LINE_SCREEN_PX = 3;

interface DropLandingIndicatorProps {
  indicator: LandingIndicator | null;
  zoomScale: number;
}

export function DropLandingIndicator({ indicator, zoomScale }: DropLandingIndicatorProps) {
  if (!indicator) return null;
  const thickness = LINE_SCREEN_PX / zoomScale;

  // Tinted blue-500, the accent of the add-column controls.
  return (
    <div
      className="pointer-events-none absolute z-[61] rounded-lg bg-blue-500/20"
      style={{
        left: `${indicator.left}px`,
        top: `${indicator.top}px`,
        width: `${indicator.width}px`,
        height: `${indicator.height}px`,
      }}
      aria-hidden
      data-testid="drop-landing-indicator"
      data-kind="gutter"
    >
      <div
        className="mx-auto h-full rounded-full bg-blue-500"
        style={{ width: `${thickness}px` }}
      />
    </div>
  );
}
