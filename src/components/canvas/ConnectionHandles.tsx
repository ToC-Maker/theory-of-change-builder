// `ConnectionHandles` — drag-to-connect handles on the left and right
// edges of a node: a 12px indigo dot (2px white outline) centred on the
// edge, drawn when `visible` (NodeComponent's hover/selection state) and
// transparent otherwise.
//
// The handle buttons stay mounted (in edit mode) while the dot is hidden.
// `visible` changes a frame after the pointer arrives, so a handle created
// by it would not exist yet for a press that follows closely, and that
// press would start a node drag, or a waypoint drag where a connection
// lies underneath, instead. A permanently mounted target catches it
// however soon it comes.
//
// Each handle binds its `pointerdown` via `useConnectionDrag`'s
// `bindHandle(nodeId, side)`; the hook owns the gesture lifecycle.
//
// Hit area. A connection leaves its node exactly at the dot, and a node's
// handle outranks the connection's hit path beneath it. A target reaching
// 12px outside the edge would cover the first 12px of every outgoing
// connection, all of a short one (the default 24px column gap leaves a
// line of about 10px): it could not be hovered, clicked, split or
// dragged. So how far the target reaches outside the node depends on
// whether a press there is likely to be meant for the dot:
//   - always live: 12px inside the node edge and 3px outside it. A press
//     right after the pointer arrives on the node lands here.
//   - live only while the node is hovered or selected: the next 9px
//     outside. Hover scales the node up 5%, carrying the dot about 5px
//     outward under a pointer aimed at it, and this keeps that press on
//     the handle. The hover test is CSS (`:hover` on the node, this
//     component's parent), so it does not wait for a React render: in
//     Chrome it is live 20ms after the pointer enters the node, though a
//     press dispatched in the same task as that move can still beat it.
//     A selected node keeps this reach live, because its dot stays drawn
//     and is aimed at without hovering first; the connection's first
//     ~12px are then covered, as they are while hovering the node.
// A press that arrives from outside the node, aimed at the outer half of
// the dot on a node not hovered or selected, therefore lands on the
// connection or the canvas instead.
//
// The two buttons are Fragment siblings (no wrapping element) so they
// don't introduce a hit-test target between them.

import clsx from 'clsx';
import type { BindConnectionHandle, HandleSide } from '../../hooks/useConnectionDrag';

interface ConnectionHandlesProps {
  nodeId: string;
  visible: boolean;
  bindHandle: BindConnectionHandle;
}

// Per side, the offsets that put the always-live box 3px outside the node
// edge and the dot back onto the edge, plus the side the outer reach
// extends to.
const SIDE_CLASSES: Record<HandleSide, { button: string; dot: string; reach: string }> = {
  left: { button: '-left-[3px] justify-start', dot: '-ml-[3px]', reach: 'before:right-full' },
  right: { button: '-right-[3px] justify-end', dot: '-mr-[3px]', reach: 'before:left-full' },
};

export function ConnectionHandles({ nodeId, visible, bindHandle }: ConnectionHandlesProps) {
  // The buttons sit at the node's vertical midpoint via top:50% + translate,
  // absolutely positioned against the node's own box. `touch-none` blocks
  // mobile scroll-eat. `tabIndex={-1}`: pointer-only affordance, kept out of
  // the tab order.
  const button =
    'group touch-none absolute z-20 w-[15px] h-6 top-1/2 -translate-y-1/2 flex items-center cursor-crosshair before:absolute before:inset-y-0 before:w-[9px]';
  const reach = visible
    ? 'before:pointer-events-auto'
    : 'before:pointer-events-none [:hover>&]:before:pointer-events-auto';
  const dot = clsx(
    'pointer-events-none w-3 h-3 rounded-full bg-indigo-500 border-2 border-white shadow-md transition-[transform,opacity] group-hover:scale-125',
    visible ? 'opacity-100' : 'opacity-0',
  );

  return (
    <>
      {(['left', 'right'] as const).map((side) => (
        <button
          key={side}
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          data-tocb-connection-handle={`${nodeId}|${side}`}
          onPointerDown={bindHandle(nodeId, side).onPointerDown}
          // The handle is interactive; suppress the parent node's
          // click-to-select selection when it is clicked (so a tap on
          // the handle doesn't also toggle highlight).
          onClick={(e) => e.stopPropagation()}
          className={clsx(button, reach, SIDE_CLASSES[side].button, SIDE_CLASSES[side].reach)}
        >
          <span data-tocb-handle-dot className={clsx(dot, SIDE_CLASSES[side].dot)} />
        </button>
      ))}
    </>
  );
}
