// `ConnectionHandles` — small handle dots on the left and right edges
// of a node, used to initiate a drag-to-connect gesture.
//
// Visibility: only rendered when the parent passes `visible={true}`,
// which is driven by NodeComponent's hover/selection state. We avoid
// a CSS `:hover` selector here so the surrounding NodeComponent's
// React-tracked `isHovered` / `isSelected` props remain the single
// source of truth (consistent with the rest of the canvas surface).
//
// Each handle dot binds its `pointerdown` via `useConnectionDrag`'s
// `bindHandle(nodeId, side)` accessor; the hook itself owns the
// gesture lifecycle.
//
// The visual design is a 12×12 opaque indigo circle with a 2px white
// outline, positioned at the node's vertical midpoint and overhanging
// the node edge by 6px so it's grabbable without covering the title.
// The two dots are rendered as Fragment siblings (no wrapping element)
// so they don't introduce a hit-test target between them.

import React from 'react';
import type { HandleSide } from '../../hooks/useConnectionDrag';

interface ConnectionHandlesProps {
  nodeId: string;
  visible: boolean;
  bindHandle: (
    nodeId: string,
    side: HandleSide,
  ) => {
    onPointerDown: (e: React.PointerEvent) => void;
  };
}

export function ConnectionHandles({ nodeId, visible, bindHandle }: ConnectionHandlesProps) {
  if (!visible) return null;

  const left = bindHandle(nodeId, 'left');
  const right = bindHandle(nodeId, 'right');

  // The dots sit at the node's vertical midpoint via top:50% + translate.
  // We use absolute positioning relative to the wrapping NodeComponent
  // div (which is `relative`). `touch-none` blocks mobile scroll-eat.
  return (
    <>
      <button
        type="button"
        aria-label="Drag to connect from left edge"
        data-tocb-connection-handle={`${nodeId}|left`}
        onPointerDown={left.onPointerDown}
        // The handle is interactive; suppress the parent node's
        // click-to-select selection when this dot is clicked (so a
        // tap on the handle dot doesn't also toggle highlight).
        onClick={(e) => e.stopPropagation()}
        className="touch-none absolute z-20 w-3 h-3 -left-1.5 top-1/2 -translate-y-1/2 rounded-full bg-indigo-500 border-2 border-white shadow-md cursor-crosshair hover:scale-125 transition-transform"
      />
      <button
        type="button"
        aria-label="Drag to connect from right edge"
        data-tocb-connection-handle={`${nodeId}|right`}
        onPointerDown={right.onPointerDown}
        onClick={(e) => e.stopPropagation()}
        className="touch-none absolute z-20 w-3 h-3 -right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-indigo-500 border-2 border-white shadow-md cursor-crosshair hover:scale-125 transition-transform"
      />
    </>
  );
}
