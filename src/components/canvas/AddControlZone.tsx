// Hover zone laid over one of the gaps of the chart (the outer edges, the
// gap between sections, the gap between columns). While the pointer is
// over the zone, a stack of "+ Column" / "+ Section" controls appears
// where it entered. The zone is an overlay: edit mode lays the chart out
// exactly like view mode, so the zone takes no layout space and the
// controls may extend past the gap only vertically.
//
// Stacking: the zone itself sits under the connection layer, so a
// connection crossing the gap keeps its hover and click. The revealed
// controls sit above the connection layer but below nodes, so a click on
// a control is never swallowed by a connection while the connection
// handle of a node overhanging into the gap keeps its press.
//
// Text sizing: the zone width is fixed by the chart's gaps, so the
// controls can only grow with the inverse of the zoom up to what fits in
// the gap. At fit zoom the labels stay small; the tooltip carries the
// full wording.

import { useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { MOVE_THRESHOLD_PX } from '../../hooks/usePointerDrag';

/** Padding of the canvas card around the graph, which the edge zones occupy. */
export const CANVAS_EDGE_PX = 16;

const BASE_FONT_PX = 12;
const PILL_GAP_PX = 2;

// A thick border on the side the control's target lies on. Written out in
// full so Tailwind sees the class names.
const STRIPE = {
  column: { left: 'border-l-4 border-l-blue-600', right: 'border-r-4 border-r-blue-600' },
  section: { left: 'border-l-4 border-l-green-600', right: 'border-r-4 border-r-green-600' },
} as const;

export interface AddControl {
  kind: 'column' | 'section';
  /** Tooltip and accessible name. */
  title: string;
  testId: string;
  onClick: () => void;
  /**
   * Which side of the zone the control's target lies on, shown as an
   * accent stripe. Left unset for controls that act on the gap itself.
   */
  towards?: 'left' | 'right';
}

interface AddControlZoneProps {
  testId: string;
  /** Side of the positioned parent the zone is attached to. */
  edge: 'left' | 'right';
  /** Gap width in content pixels. */
  width: number;
  zoomScale: number;
  controls: AddControl[];
}

/**
 * Anchors the zone in the gap after a column. Only edit mode needs the
 * anchor, so view mode's DOM keeps the column bodies as direct children of
 * the columns row.
 */
export function ColumnSlot({ editMode, children }: { editMode: boolean; children: ReactNode }) {
  return editMode ? <div className="relative">{children}</div> : <>{children}</>;
}

export function AddControlZone({ testId, edge, width, zoomScale, controls }: AddControlZoneProps) {
  // The stack keeps its last position while it fades out, so it does not
  // jump to the top of the zone on the way out.
  const [stack, setStack] = useState({ top: 0, shown: false });

  const pillWidth = width - 2;
  const fontPx = Math.min(Math.max(BASE_FONT_PX, BASE_FONT_PX / zoomScale), pillWidth * 0.65);
  // Roughly the label's length ("+ Section" is about 5.4 em of text) plus
  // the same padding at both ends.
  const pillLength = Math.round(fontPx * 5.4 + 12);
  const stackHeight = controls.length * pillLength + (controls.length - 1) * PILL_GAP_PX;

  const reveal = (e: MouseEvent<HTMLDivElement>) => {
    // A pressed button means a node, connection or canvas drag is in
    // flight; controls popping up under it would only get in the way.
    if (e.buttons !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const zoneHeight = rect.height / zoomScale;
    const pointerY = (e.clientY - rect.top) / zoomScale;
    const centered = pointerY - stackHeight / 2;
    setStack({ top: Math.max(0, Math.min(centered, zoneHeight - stackHeight)), shown: true });
  };

  const zoneStyle: CSSProperties = {
    width,
    ...(edge === 'left' ? { right: '100%' } : { left: '100%' }),
  };

  return (
    <div
      className="absolute top-0 bottom-0"
      style={zoneStyle}
      data-testid={testId}
      data-export-exclude=""
      onMouseEnter={reveal}
      onMouseLeave={() => setStack((current) => ({ ...current, shown: false }))}
    >
      <div
        className="absolute z-[5] flex flex-col opacity-0 pointer-events-none transition-opacity duration-100 data-[revealed=true]:opacity-100 data-[revealed=true]:pointer-events-auto"
        style={{ left: 1, width: pillWidth, top: stack.top, gap: PILL_GAP_PX }}
        data-revealed={stack.shown}
      >
        {controls.map((control) => (
          <AddControlButton
            key={control.testId}
            control={control}
            length={pillLength}
            fontPx={fontPx}
          />
        ))}
      </div>
    </div>
  );
}

function AddControlButton({
  control,
  length,
  fontPx,
}: {
  control: AddControl;
  length: number;
  fontPx: number;
}) {
  const isSection = control.kind === 'section';
  const tone = isSection
    ? 'text-green-700 border-green-300 bg-green-50 hover:bg-green-500 hover:border-green-500 hover:text-white'
    : 'text-blue-700 border-blue-300 bg-blue-50 hover:bg-blue-500 hover:border-blue-500 hover:text-white';
  const stripe = control.towards ? STRIPE[control.kind][control.towards] : '';

  // The canvas pans while the content follows the cursor, so a pan that
  // starts on a control ends on it and the browser still reports a click.
  // Only a press that stayed within the click threshold is a click.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const down = pressedAt.current;
    pressedAt.current = null;
    if (
      down &&
      (Math.abs(e.clientX - down.x) > MOVE_THRESHOLD_PX ||
        Math.abs(e.clientY - down.y) > MOVE_THRESHOLD_PX)
    ) {
      return;
    }
    control.onClick();
  };

  // Not a <button>: a press on a button never starts a canvas pan, and
  // pressing on a control and dragging must still move the canvas.
  return (
    <div
      role="button"
      tabIndex={-1}
      title={control.title}
      aria-label={control.title}
      data-testid={control.testId}
      onPointerDown={(e) => {
        pressedAt.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={handleClick}
      className={`flex-none flex items-center justify-center rounded-md border whitespace-nowrap font-medium shadow-sm cursor-pointer select-none transition-colors ${tone} ${stripe}`}
      style={{ height: length, fontSize: fontPx, lineHeight: 1, writingMode: 'vertical-rl' }}
    >
      {isSection ? '+ Section' : '+ Column'}
    </div>
  );
}
