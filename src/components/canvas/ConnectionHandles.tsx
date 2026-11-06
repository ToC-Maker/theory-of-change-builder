// `ConnectionHandles` — small handle dots on the left and right edges
// of a node, used to initiate a drag-to-connect gesture.
//
// Visibility: the dots are shown when the parent passes `visible={true}`,
// which is driven by NodeComponent's hover/selection state. We avoid
// a CSS `:hover` selector here so the surrounding NodeComponent's
// React-tracked `isHovered` / `isSelected` props remain the single
// source of truth (consistent with the rest of the canvas surface).
//
// The handles themselves are always mounted (in edit mode) and only
// their dots are hidden. That state is set by React a frame after the
// pointer arrives, so a handle created by it would not exist yet for a
// press that follows the arrival closely; that press would land on the
// node (starting a node drag) or on the connection's hit-path beneath
// (starting a waypoint drag) instead. A permanently mounted target
// makes the press land on the handle however soon it comes.
//
// Each handle binds its `pointerdown` via `useConnectionDrag`'s
// `bindHandle(nodeId, side)` accessor; the hook itself owns the
// gesture lifecycle.
//
// Geometry: the target is a 24×24 transparent button centered on the
// node edge, with the 12×12 indigo dot (2px white outline) centered in
// it. The node scales up 5% on hover, which carries the handle several
// pixels outward over the transition; a target that is only as big as
// the dot would drift out from under a pointer aimed at the dot, and
// at fit-to-screen zoom it measures under 10 screen px. The two targets
// are rendered as Fragment siblings (no wrapping element) so they
// don't introduce a hit-test target between them.

import clsx from 'clsx';
import type { BindConnectionHandle } from '../../hooks/useConnectionDrag';

interface ConnectionHandlesProps {
  nodeId: string;
  visible: boolean;
  bindHandle: BindConnectionHandle;
}

export function ConnectionHandles({ nodeId, visible, bindHandle }: ConnectionHandlesProps) {
  const left = bindHandle(nodeId, 'left');
  const right = bindHandle(nodeId, 'right');

  // The targets sit at the node's vertical midpoint via top:50% + translate.
  // We use absolute positioning relative to the wrapping NodeComponent
  // div (which is `relative`). `touch-none` blocks mobile scroll-eat.
  // `tabIndex={-1}`: pointer-only affordance, kept out of the tab order
  // now that it is always in the DOM.
  const target =
    'group touch-none absolute z-20 w-6 h-6 top-1/2 -translate-y-1/2 flex items-center justify-center cursor-crosshair';
  const dot = clsx(
    'pointer-events-none w-3 h-3 rounded-full bg-indigo-500 border-2 border-white shadow-md transition-[transform,opacity] group-hover:scale-125',
    visible ? 'opacity-100' : 'opacity-0',
  );

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Drag to connect from left edge"
        data-tocb-connection-handle={`${nodeId}|left`}
        onPointerDown={left.onPointerDown}
        // The handle is interactive; suppress the parent node's
        // click-to-select selection when it is clicked (so a tap on
        // the handle doesn't also toggle highlight).
        onClick={(e) => e.stopPropagation()}
        className={clsx(target, '-left-3')}
      >
        <span data-tocb-handle-dot className={dot} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Drag to connect from right edge"
        data-tocb-connection-handle={`${nodeId}|right`}
        onPointerDown={right.onPointerDown}
        onClick={(e) => e.stopPropagation()}
        className={clsx(target, '-right-3')}
      >
        <span data-tocb-handle-dot className={dot} />
      </button>
    </>
  );
}
