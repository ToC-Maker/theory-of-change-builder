// Overlay laid over one of the gaps of the chart (the outer edges, the gap
// between sections, the gap between columns) that offers "+ Column" /
// "+ Section" controls. Edit mode lays the chart out exactly like view
// mode, so a zone takes no layout space; everything in it is absolutely
// positioned and marked `data-export-exclude`.
//
// At rest a zone shows a faint dashed hairline along its gap with a small
// "+" badge in the middle. The badge is the zone's pointer target; the
// controls themselves appear once the pointer has rested on the zone
// briefly (a sweep across the chart shows nothing) or the badge is tapped.
// They stay a moment after the pointer leaves so moving onto a control
// never hides it, and close on their own after a tap that is not followed
// by a second one.
//
// Sizes: controls are sized in on-screen pixels, not content pixels (the
// content is divided by the canvas zoom, as the waypoint handles do), so
// they are at least MOUSE_TARGET_PX wide for a mouse or pen and
// TOUCH_TARGET_PX for touch, with a readable label, at any zoom. That is
// far wider than a gap at fit zoom, so the controls overhang it. They are
// placed where they cover no node or connection if the zone has room, and
// then sit below nodes (a node, or a connection handle, always wins a
// press over the part of a control overhanging it). Where there is no
// such spot (a touch-sized row at fit zoom is wider than the columns next
// to the gap) they sit above nodes for as long as they are open, because
// a control hidden behind a node cannot be pressed. In both cases they
// are above the connection layer (a press on a control is never taken by
// a connection).
//
// The resting badge is the opposite: it sits below the connection layer.
// It is 24px (44px for touch) on screen, wider than a short connection
// between adjacent columns, so a badge above the connections would take
// that connection's hover, press, tap and drag. Below them, a connection
// that crosses a badge keeps all four and the rest of the badge (and the
// gap strip) still opens the controls.
//
// A control is not a <button>: a press on a button never starts a canvas
// pan, and pressing on a control and dragging must still pan the canvas.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { MOVE_THRESHOLD_PX } from '../../hooks/usePointerDrag';

/** Padding of the canvas card around the graph, which the edge zones occupy. */
export const CANVAS_EDGE_PX = 16;

/** Smallest on-screen control width, in CSS pixels, at any zoom. */
export const MOUSE_TARGET_PX = 24;
export const TOUCH_TARGET_PX = 44;
/** The pointer must rest on a zone this long before its controls appear. */
export const HOVER_INTENT_MS = 140;
/** Controls stay this long after the pointer leaves their zone. */
export const HOVER_GRACE_MS = 250;
/** Controls opened by a tap close after this long without a second tap. */
export const TOUCH_OPEN_MS = 5000;

const MOUSE_FONT_PX = 12;
const TOUCH_FONT_PX = 14;
const CONTROL_GAP_PX = 2;
const BADGE_PX = 16;
const AVOID_MARGIN_PX = 6;
// How far a node's connection handles reach outside its edge while it is
// hovered or selected (3px always, 9px more then), in content pixels.
const HANDLE_REACH_PX = 12;
const AVOID_STEP_PX = 8;
const CONNECTION_SAMPLE_PX = 10;

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
  /**
   * The zone is the card padding at the chart's outer edge: its controls
   * grow inward from the card's edge instead of centring on the zone.
   */
  outerEdge?: boolean;
}

/**
 * Anchors the zone in the gap after a column. Only edit mode needs the
 * anchor, so view mode's DOM keeps the column bodies as direct children of
 * the columns row.
 */
export function ColumnSlot({ editMode, children }: { editMode: boolean; children: ReactNode }) {
  return editMode ? <div className="relative">{children}</div> : <>{children}</>;
}

type Anchor = 'center' | 'left' | 'right';

function controlSize(touch: boolean, count: number) {
  const width = touch ? TOUCH_TARGET_PX : MOUSE_TARGET_PX;
  const fontPx = touch ? TOUCH_FONT_PX : MOUSE_FONT_PX;
  return {
    width,
    fontPx,
    // "+ Section" set vertically is about 5.4em long.
    length: Math.round(fontPx * 5.4 + 16),
    rowWidth: count * width + (count - 1) * CONTROL_GAP_PX,
  };
}

/** True when a point of any connection's path lies inside the rectangle. */
function crossesConnection(left: number, top: number, right: number, bottom: number): boolean {
  for (const path of document.querySelectorAll<SVGPathElement>('[data-tocb-connection-hitpath]')) {
    if (typeof path.getTotalLength !== 'function') return false;
    const box = path.getBoundingClientRect();
    if (box.right < left || box.left > right || box.bottom < top || box.top > bottom) continue;
    const toScreen = path.getScreenCTM();
    if (!toScreen) continue;
    const step = CONNECTION_SAMPLE_PX / (toScreen.a || 1);
    const length = path.getTotalLength();
    for (let at = 0; at <= length; at += step) {
      const point = path.getPointAtLength(at);
      const x = toScreen.a * point.x + toScreen.c * point.y + toScreen.e;
      const y = toScreen.b * point.x + toScreen.d * point.y + toScreen.f;
      if (x >= left && x <= right && y >= top && y <= bottom) return true;
    }
  }
  return false;
}

/**
 * Where, in content pixels from the zone's top, the controls go: as near
 * the pointer as possible, within the section's columns, on a spot that
 * covers no node and no connection (`clear`). With no such spot they are
 * centred on the pointer.
 */
function placeControls(
  zone: HTMLElement,
  pointerY: number,
  zoom: number,
  size: { rowWidth: number; length: number },
  anchor: Anchor,
): { top: number; clear: boolean } {
  const zoneRect = zone.getBoundingClientRect();
  const firstColumn = zone.parentElement?.querySelector('[data-column]');
  const minTop = firstColumn
    ? Math.max(0, firstColumn.getBoundingClientRect().top - zoneRect.top)
    : 0;
  const maxTop = zoneRect.height - size.length;
  if (maxTop < minTop) {
    return { top: (minTop + (zoneRect.height - minTop - size.length) / 2) / zoom, clear: false };
  }

  const preferred = Math.min(Math.max(pointerY - zoneRect.top - size.length / 2, minTop), maxTop);
  const left =
    anchor === 'left'
      ? zoneRect.left
      : anchor === 'right'
        ? zoneRect.right - size.rowWidth
        : zoneRect.left + (zoneRect.width - size.rowWidth) / 2;
  const right = left + size.rowWidth;
  // Stay out of a node's connection handles too, so a press on a handle is
  // never on a control's edge.
  const margin = Math.max(AVOID_MARGIN_PX, HANDLE_REACH_PX * zoom);
  const nodes = [...document.querySelectorAll('[data-tocb-node]')]
    .map((node) => node.getBoundingClientRect())
    .filter((box) => box.right + margin > left && box.left - margin < right);
  const isClear = (top: number) => {
    const from = zoneRect.top + top;
    const to = from + size.length;
    return (
      nodes.every((box) => box.bottom + margin <= from || box.top - margin >= to) &&
      !crossesConnection(left, from, right, to)
    );
  };

  for (let offset = 0; offset <= maxTop - minTop; offset += AVOID_STEP_PX) {
    for (const top of offset === 0 ? [preferred] : [preferred - offset, preferred + offset]) {
      if (top >= minTop && top <= maxTop && isClear(top)) return { top: top / zoom, clear: true };
    }
  }
  return { top: preferred / zoom, clear: false };
}

export function AddControlZone({
  testId,
  edge,
  width,
  zoomScale,
  controls,
  outerEdge = false,
}: AddControlZoneProps) {
  const zoneRef = useRef<HTMLDivElement>(null);
  // The controls keep their last placement while they fade out, so they do
  // not jump to the top of the zone on the way out.
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ top: 0, touch: false, clear: true });
  const openRef = useRef(false);
  const lastPointerY = useRef(0);
  const lastPointerType = useRef<'mouse' | 'touch'>('mouse');
  const intentTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const [coarseDevice] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(any-pointer: coarse)').matches,
  );

  const anchor: Anchor = !outerEdge ? 'center' : edge === 'left' ? 'left' : 'right';
  const scale = 1 / zoomScale;

  const hide = useCallback(() => {
    window.clearTimeout(intentTimer.current);
    window.clearTimeout(hideTimer.current);
    intentTimer.current = undefined;
    openRef.current = false;
    setOpen(false);
  }, []);

  const reveal = (touch: boolean, pointerY: number) => {
    const zone = zoneRef.current;
    if (!zone) return;
    window.clearTimeout(hideTimer.current);
    intentTimer.current = undefined;
    const spot = placeControls(
      zone,
      pointerY,
      zoomScale,
      controlSize(touch, controls.length),
      anchor,
    );
    setPlacement({ ...spot, touch });
    openRef.current = true;
    setOpen(true);
  };

  // Hover intent: the pointer has to rest on the zone before the controls
  // appear. Armed on entry and again on movement, so a drag that ends
  // inside a zone does not leave it dead until the pointer re-enters.
  const armIntent = (e: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerY.current = e.clientY;
    if (openRef.current || intentTimer.current !== undefined || e.buttons !== 0) return;
    intentTimer.current = window.setTimeout(
      () => reveal(false, lastPointerY.current),
      HOVER_INTENT_MS,
    );
  };

  useEffect(() => {
    if (!open || !placement.touch) return;
    const closeTimer = window.setTimeout(hide, TOUCH_OPEN_MS);
    const closeOnOutsideTap = (e: Event) => {
      if (!zoneRef.current?.contains(e.target as Node)) hide();
    };
    document.addEventListener('pointerdown', closeOnOutsideTap, true);
    return () => {
      window.clearTimeout(closeTimer);
      document.removeEventListener('pointerdown', closeOnOutsideTap, true);
    };
  }, [open, placement.touch, hide]);

  useEffect(
    () => () => {
      window.clearTimeout(intentTimer.current);
      window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const size = controlSize(placement.touch, controls.length);
  const triggerPx = coarseDevice ? TOUCH_TARGET_PX : MOUSE_TARGET_PX;

  const zoneStyle: CSSProperties = {
    width,
    ...(edge === 'left' ? { right: '100%' } : { left: '100%' }),
  };
  const controlsStyle: CSSProperties = {
    top: placement.top,
    transform: anchor === 'center' ? `translateX(-50%) scale(${scale})` : `scale(${scale})`,
    transformOrigin: anchor === 'center' ? 'top center' : `top ${anchor}`,
    ...(anchor === 'center' ? { left: '50%' } : { [anchor]: 0 }),
  };

  return (
    <div
      ref={zoneRef}
      className="absolute top-0 bottom-0"
      style={zoneStyle}
      data-testid={testId}
      data-export-exclude=""
      onPointerDown={(e) => {
        lastPointerType.current = e.pointerType === 'touch' ? 'touch' : 'mouse';
      }}
      onPointerEnter={(e) => {
        if (e.pointerType === 'touch') return;
        window.clearTimeout(hideTimer.current);
        armIntent(e);
      }}
      onPointerMove={(e) => {
        if (e.pointerType === 'touch') return;
        if (e.buttons !== 0) {
          window.clearTimeout(intentTimer.current);
          intentTimer.current = undefined;
          lastPointerY.current = e.clientY;
          return;
        }
        armIntent(e);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'touch') return;
        window.clearTimeout(intentTimer.current);
        intentTimer.current = undefined;
        if (!openRef.current) return;
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(hide, HOVER_GRACE_MS);
      }}
      onClick={(e: ReactMouseEvent<HTMLDivElement>) => {
        // A click on the zone itself or its badge (a tap, on touch) opens
        // the controls at once; clicks on the controls are their own.
        const target = e.target as Element;
        if (target !== e.currentTarget && !target.closest('[data-add-badge]')) return;
        reveal(lastPointerType.current === 'touch', e.clientY);
      }}
    >
      <div
        aria-hidden="true"
        data-add-cue=""
        className="absolute inset-y-0 pointer-events-none transition-opacity duration-150"
        style={{
          left: '50%',
          opacity: open ? 0 : 1,
          borderLeft: `${scale}px dashed rgb(156 163 175 / 0.55)`,
        }}
      />
      <div
        data-add-badge=""
        className="absolute flex items-center justify-center cursor-pointer transition-opacity duration-150"
        style={{
          left: '50%',
          top: '50%',
          width: triggerPx,
          height: triggerPx,
          transform: `translate(-50%, -50%) scale(${scale})`,
          // It fades out while the controls are open but keeps catching
          // the pointer: a badge that let go would hand it to whatever
          // lies beneath, which ends the hover and closes the controls
          // under the pointer, and the badge would come back and reopen
          // them.
          opacity: open ? 0 : 1,
        }}
      >
        <span
          className="flex items-center justify-center rounded-full border border-gray-300 bg-white/90 text-gray-500 font-medium leading-none"
          style={{ width: BADGE_PX, height: BADGE_PX, fontSize: MOUSE_FONT_PX }}
        >
          +
        </span>
      </div>
      <div
        data-revealed={open}
        className={`absolute flex transition-opacity duration-100 ${placement.clear ? 'z-[5]' : 'z-30'} ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ ...controlsStyle, gap: CONTROL_GAP_PX }}
      >
        {controls.map((control) => (
          <AddControlButton
            key={control.testId}
            control={control}
            width={size.width}
            length={size.length}
            fontPx={size.fontPx}
            onActivated={hide}
          />
        ))}
      </div>
    </div>
  );
}

function AddControlButton({
  control,
  width,
  length,
  fontPx,
  onActivated,
}: {
  control: AddControl;
  width: number;
  length: number;
  fontPx: number;
  onActivated: () => void;
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
  const handleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
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
    onActivated();
  };

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
      style={{ width, height: length, fontSize: fontPx, lineHeight: 1, writingMode: 'vertical-rl' }}
    >
      {isSection ? '+ Section' : '+ Column'}
    </div>
  );
}
