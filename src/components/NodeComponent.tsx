import clsx from 'clsx';
import React, { useRef, useEffect, memo } from 'react';
import { Node } from '../types';
import { getContrastTextColor } from '../utils';
import { ConnectionHandles } from './canvas/ConnectionHandles';
import type { BindConnectionHandle } from '../hooks/useConnectionDrag';

/**
 * DOM attribute the node root carries. Read by:
 *   - `usePointerDrag` (in spirit: the bound `onPointerDown` lives on
 *     the same root)
 *   - App.tsx's `excludeFromPan` callback, via
 *     `target.closest('[data-tocb-node]')`
 * Hoisted to a constant so the attribute writer (this component) and
 * the selector readers can't drift apart on rename.
 */
export const NODE_DOM_ATTR = 'data-tocb-node';

// PR 3: this component was previously a three-way editor — inline
// contentEditable for the title, a pencil-icon overlay that opened
// `<NodePopup>`, and an extra `setNodePopup` prop that bridged the
// info icon to the modal. All three are gone in PR 3. Title and
// markdown details are now edited in the anchored `<NodeEditor>` (in
// `src/components/node-editor/`). NodeComponent is back to being a
// pure renderer + selection delegate.
//
// PR 4: HTML5 Drag and Drop (`draggable`, `onDragStart`, `onDragEnd`)
// retired. Drag is now driven by `usePointerDrag` in the parent
// (TheoryOfChangeGraph), which binds a single `onPointerDown` on this
// component's root via the `onPointerDown` prop. The root also carries:
//   - `data-tocb-node={id}` — the new attribute the App's
//     `excludeFromPan` selector matches (replacing `draggable="true"`)
//     and the locator pointer-event tests use.
//   - `touch-none` (Tailwind: `touch-action: none`) — keeps mobile
//     browser scroll gestures from swallowing pointermove events
//     during a drag.
//
// `handleClick` modifier semantics (Cmd/Ctrl+click → 'multi',
// Shift+click in editMode → 'column', else → 'single') are preserved
// verbatim from before the refactor; the user-direction sticky in
// `plans/figma-redesign.md:219` calls them out as load-bearing.
interface NodeComponentProps {
  node: Node;
  updateNodeRef: (id: string, ref: HTMLDivElement | null) => void;
  isHighlighted: boolean;
  isConnected: boolean;
  isHovered: boolean;
  isDragging: boolean;
  toggleHighlight: (id: string, selectionMode?: 'single' | 'multi' | 'column') => void;
  setHoveredNode: (id: string | null) => void;
  hasHighlightedNodes: boolean;
  /**
   * PR 4: single pointerdown handler that starts the drag in the parent's
   * `usePointerDrag` hook. Omitted when `editMode=false` so view-only
   * pages render without any drag binding.
   */
  onPointerDown?: (event: React.PointerEvent) => void;
  /**
   * PR 5 Task 5.2: bind handle dots to the drag-to-connect gesture.
   * Returned by `useConnectionDrag().bindHandle`. Omitted when
   * editMode=false or when the parent opts out of connection drag.
   * Visibility of the dots is gated by `isHovered || isHighlighted`.
   */
  bindConnectionHandle?: BindConnectionHandle;
  editMode: boolean;
  textSize: number;
  fontFamily: string;
}

// NodeComponentInner is the actual render. The default export is wrapped
// in `React.memo` with DEFAULT shallow equality (Important fix in plan
// §0.4 — no custom equality function, harder to silently regress).
// Parent (TheoryOfChangeGraph) MUST pass stable function references for
// the callback props (`toggleHighlight`, `updateNodeRef`,
// `setHoveredNode`, and `onPointerDown` — supplied via the `bindNode`
// cache inside `usePointerDrag`), otherwise the memo bail-out fails and
// every parent render re-renders every node. The
// `NodeComponent.memo.test.tsx` regression test pins this for future
// contributors.
function NodeComponentInner({
  node,
  updateNodeRef,
  isHighlighted,
  isConnected,
  isHovered,
  isDragging,
  toggleHighlight,
  setHoveredNode,
  hasHighlightedNodes,
  onPointerDown,
  bindConnectionHandle,
  editMode,
  textSize,
  fontFamily,
}: NodeComponentProps) {
  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    updateNodeRef(node.id, nodeRef.current);
  }, [node.id, updateNodeRef]);

  const handleClick = (event: React.MouseEvent) => {
    let selectionMode: 'single' | 'multi' | 'column' = 'single';

    if (event.ctrlKey || event.metaKey) {
      selectionMode = 'multi';
    } else if (event.shiftKey && editMode) {
      selectionMode = 'column';
    }

    toggleHighlight(node.id, selectionMode);
  };

  const handleMouseEnter = () => {
    setHoveredNode(node.id);
  };

  const handleMouseLeave = () => {
    setHoveredNode(null);
  };

  return (
    <div className="relative z-10">
      <div
        ref={nodeRef}
        id={`node-${node.id}`}
        {...{ [NODE_DOM_ATTR]: node.id }}
        onPointerDown={editMode ? onPointerDown : undefined}
        className={clsx(
          'flex flex-col border-0 rounded-xl cursor-pointer transition-all duration-500 ease-in-out shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] hover:shadow-[0_20px_25px_-5px_rgba(0,0,0,0.3),_0_10px_10px_-5px_rgba(0,0,0,0.15)] transform hover:scale-105 pt-3 px-3 pb-6',
          'touch-none',
          // Only apply default gradients if no custom color is set
          !node.color && 'bg-gradient-to-br from-white to-gray-50',
          isHighlighted
            ? node.color
              ? 'ring-2 ring-black'
              : 'ring-2 ring-black bg-gradient-to-br from-indigo-50 to-indigo-100'
            : isHovered
              ? node.color
                ? '' // No ring for custom colored nodes when hovered
                : 'bg-gradient-to-br from-indigo-25 to-indigo-50' // Only background for default nodes when hovered
              : 'hover:shadow-2xl',
          hasHighlightedNodes && !isConnected && 'opacity-30',
          isDragging && 'opacity-50 scale-95 shadow-lg',
        )}
        style={{
          width: `${node.width || 192}px`,
          backgroundColor: node.color || '#ffffff',
        }}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex flex-col justify-center relative py-2">
          <div
            className={`font-medium text-center leading-tight break-words ${!node.title ? 'empty-placeholder' : ''}`}
            style={{
              fontSize: `${textSize * 1.125}rem`,
              fontFamily: fontFamily,
              color: node.color ? getContrastTextColor(node.color) : '#000000',
            }}
            data-placeholder="Untitled"
          >
            {node.title}
          </div>
        </div>
        {/* PR 5 Task 5.2: drag-to-connect handle dots on left + right
          edges. Visible only when hovered or selected (no global
          pointermove subscription — pure React-tracked state). The
          dots overhang the node edge by 6px so they're grabbable
          without covering content. Handles are absolute-positioned
          relative to this node's flex container. */}
        {editMode && bindConnectionHandle && (
          <ConnectionHandles
            nodeId={node.id}
            visible={isHovered || isHighlighted}
            bindHandle={bindConnectionHandle}
          />
        )}
      </div>
    </div>
  );
}

export const NodeComponent = memo(NodeComponentInner);
NodeComponent.displayName = 'NodeComponent';
