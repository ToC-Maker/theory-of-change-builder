// Drag landing indicator — the thin mark that shows where a dragged
// node will land. Deliberately NOT node-shaped: a second node outline
// next to the cursor-following clone would be indistinguishable from the
// node being dragged. An insertion line (or a tinted gutter for a new
// column) cannot be mistaken for one.
//
// Absolutely positioned, pointer-transparent overlay in the canvas
// transform stack, so it never reflows the columns and moves with
// pan/zoom. It exists only while a drag is in flight (the parent
// renders it from `dragState`), so it is gone on drop, Escape, cancel
// and unmount, and is never present when a chart is exported.
import type { LandingIndicator } from '../../utils/landingIndicator';

/** Line thickness on screen, so it stays visible at low zoom. */
const LINE_SCREEN_PX = 3;

interface DropLandingIndicatorProps {
  indicator: LandingIndicator | null;
  zoomScale: number;
}

export function DropLandingIndicator({ indicator, zoomScale }: DropLandingIndicatorProps) {
  if (!indicator) return null;
  const thickness = LINE_SCREEN_PX / zoomScale;

  if (indicator.kind === 'line') {
    return (
      <div
        className="pointer-events-none absolute z-[61] rounded-full bg-blue-500"
        style={{
          left: `${indicator.left}px`,
          // Centre the line on the node's top edge.
          top: `${indicator.top - thickness / 2}px`,
          width: `${indicator.width}px`,
          height: `${thickness}px`,
        }}
        aria-hidden
        data-testid="drop-landing-indicator"
        data-kind="line"
      />
    );
  }

  // Same blue as the column gutters' hover tint.
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
