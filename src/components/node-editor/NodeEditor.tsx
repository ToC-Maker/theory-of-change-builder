// `NodeEditor` — the unified anchored editor that replaced three pre-PR-3
// node-editing affordances:
//
//   1. The per-selection floating toolbar (`PerSelectionToolbar`) that
//      held width / color / delete above the active selection.
//   2. The inline `contentEditable` <div> embedded in `NodeComponent`
//      that handled in-place title edits.
//   3. The `<NodePopup>` modal that opened from the pencil icon for
//      title + markdown details editing.
//
// All three converge here: a single floating editor anchored beside the
// currently-selected node, with title (input), visual controls (width
// slider, color picker, delete button), and a lazy MDXEditor accordion
// for the details block. Multi-selection writes apply to all selected
// nodes; single-selection writes target the one. See
// `useNodeProperties.ts` for the commit-cadence semantics.
//
// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------
//
// The editor portals to `document.body` (so its z-index escapes whatever
// transform stack the canvas applies) and is `position: fixed`-positioned
// by `useAnchorPosition`. The hook subscribes to camera, anchor resize,
// and DOM mutations so the overlay stays glued to the node across pan,
// zoom, and graph reflow.
//
// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
//
// Buffered title / details writes are flushed on unmount via a cleanup
// effect that calls `commitTitle()` and `commitDetails()`. The hook
// `useNodeProperties` itself does NOT install this — see the file-header
// comment there for the rationale (we want one explicit owner of the
// "close → flush" edge so accordion mount/unmount within the editor
// doesn't double-commit).
//
// ---------------------------------------------------------------------------
// onDragStartedElsewhere (PR 4 integration seam)
// ---------------------------------------------------------------------------
//
// PR 4's `usePointerDrag` will fire `onStart` when a drag begins on a
// node. The editor needs to dismiss itself when that happens (otherwise
// it'd hang in mid-air on a now-moved anchor). Today there's no
// CustomEvent and no actual drag in flight, so this is just the prop
// shape PR 4 will plumb. The plan section "Red-team Important —
// CustomEvent→callback prop" specifies a direct callback to avoid the
// event-ordering hazard CustomEvent would introduce; we expose
// `registerOnDragStartedElsewhere` so the parent can plug a single
// callback in (instead of NodeEditor itself wiring an event listener).
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TrashIcon } from '@heroicons/react/24/outline';
import type { SetStateAction } from 'react';
import type { ToCData } from '../../types';
import { useNodeProperties } from './useNodeProperties';
import { useAnchorPosition } from './useAnchorPosition';
import { DetailsEditor } from './DetailsEditor';

type GraphUpdater = SetStateAction<ToCData>;

interface NodeEditorProps {
  /** Currently-selected node ids (1+ for the editor to be visible). */
  selectedNodeIds: string[];
  /** Live graph data. Used to read current property values. */
  data: ToCData;
  /** Anchor element (the first selected node's wrapper). */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Camera state — passed through to `useAnchorPosition`. */
  camera: { x: number; y: number; z: number };
  /** From useGraphMutation. */
  mutate: (updater: GraphUpdater) => void;
  mutateDebounced: (updater: GraphUpdater, key: string) => void;
  commit: (key?: string) => void;
  /** Fired on outside click or registered drag-start. */
  onRequestClose: () => void;
  /**
   * PR 4 seam: the parent registers a single callback here that fires
   * when a drag starts elsewhere on the canvas. We call
   * `onRequestClose()` from inside.
   */
  registerOnDragStartedElsewhere?: (cb: () => void) => void;
  fontFamily?: string;
}

export function NodeEditor(props: NodeEditorProps) {
  const {
    selectedNodeIds,
    data,
    anchorRef,
    camera,
    mutate,
    mutateDebounced,
    commit,
    onRequestClose,
    registerOnDragStartedElsewhere,
    fontFamily,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);

  const props_ = useNodeProperties({
    selectedNodeIds,
    data,
    mutate,
    mutateDebounced,
    commit,
  });

  const position = useAnchorPosition({
    anchorRef,
    camera,
    placement: 'right',
    offset: 12,
  });

  // Cleanup: flush buffered title + details writes on unmount. This is
  // the canonical "close → commit" edge for the editor. Calling commit
  // with the current selection key is safe even if nothing's buffered
  // (the underlying useGraphMutation no-ops on an unknown key).
  useEffect(() => {
    // Capture the commit closures so the cleanup operates on the values
    // observed at the LAST render before unmount (selection-key included).
    const commitTitleLocal = props_.commitTitle;
    const commitDetailsLocal = props_.commitDetails;
    return () => {
      commitTitleLocal();
      commitDetailsLocal();
    };
    // Intentionally do NOT depend on props_.commitTitle / commitDetails —
    // we want this cleanup to fire ONLY on unmount, not on every render.
    // The closure capture above gives us the latest values at unmount time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register the PR-4 drag-start callback. The parent owns the actual
  // gesture event; we just need to know when it fires.
  useEffect(() => {
    if (!registerOnDragStartedElsewhere) return;
    registerOnDragStartedElsewhere(() => onRequestClose());
  }, [registerOnDragStartedElsewhere, onRequestClose]);

  // Outside-click dismissal. We listen on `mousedown` (not `click`) so
  // the dismissal fires before any focus-shift the click would cause.
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      // Also ignore clicks that originate from the anchor itself —
      // re-selecting the same node shouldn't dismiss.
      const anchor = anchorRef.current;
      if (anchor && e.target instanceof Node && anchor.contains(e.target)) return;
      onRequestClose();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [anchorRef, onRequestClose]);

  if (selectedNodeIds.length === 0) return null;

  const headerText =
    selectedNodeIds.length === 1 ? 'Edit node' : `Editing ${selectedNodeIds.length} nodes`;

  return createPortal(
    <div
      ref={containerRef}
      className="node-editor fixed z-[150] bg-white rounded-lg shadow-xl border border-gray-200 p-3 w-72 text-sm"
      style={
        position
          ? { left: position.x, top: position.y, fontFamily }
          : // Hide off-screen until the first measure lands, so we don't
            // flash at (0, 0).
            { left: -9999, top: -9999, fontFamily }
      }
      onMouseDown={(e) => {
        // Clicks inside should NOT bubble out and trigger the outside-
        // click dismissal. Stopping propagation here also keeps the
        // node-component selection handler from re-firing.
        e.stopPropagation();
      }}
    >
      <div className="node-editor__header flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
        <span className="text-xs font-semibold text-gray-700">{headerText}</span>
        <button
          type="button"
          onClick={() => props_.deleteSelectedNodes()}
          className="p-1 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
          title={selectedNodeIds.length === 1 ? 'Delete node' : 'Delete nodes'}
          aria-label={selectedNodeIds.length === 1 ? 'Delete node' : 'Delete nodes'}
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Title (buffered + streamed). Multi-select shows placeholder when
          values differ. */}
      <label className="block">
        <span className="text-xs text-gray-600 mb-1 block">Title</span>
        <input
          type="text"
          aria-label="Node title"
          value={props_.title}
          placeholder={props_.isTitleMixed ? 'Multiple values' : 'Untitled'}
          onChange={(e) => props_.setTitle(e.target.value)}
          onBlur={() => props_.commitTitle()}
          className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          style={{ fontFamily }}
        />
      </label>

      {/* Visual controls: width + color. Both apply to every selected node. */}
      <div className="node-editor__visuals mt-3 flex items-center gap-3">
        <label className="flex items-center gap-2 flex-1">
          <span className="text-xs text-gray-600 whitespace-nowrap">Width</span>
          <input
            type="range"
            min={128}
            max={320}
            step={8}
            value={props_.width}
            onChange={(e) => props_.setWidth(parseInt(e.target.value, 10))}
            onPointerUp={() => props_.commitWidth()}
            onBlur={() => props_.commitWidth()}
            className="flex-1 h-1 bg-gray-200 rounded appearance-none cursor-pointer"
            aria-label="Node width"
          />
          <span className="text-xs text-gray-500 w-10 text-right tabular-nums">{props_.width}</span>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-xs text-gray-600">Color</span>
          <input
            type="color"
            value={props_.color}
            onChange={(e) => props_.setColor(e.target.value)}
            className="w-6 h-6 rounded border border-gray-300 cursor-pointer"
            aria-label="Node color"
          />
        </label>
      </div>

      {/* Details accordion (lazy MDXEditor). */}
      <div className="node-editor__details mt-3 pt-2 border-t border-gray-100">
        <DetailsEditor
          markdown={props_.details}
          onChange={(md) => props_.setDetails(md)}
          onCommit={() => props_.commitDetails()}
          placeholder={
            props_.isDetailsMixed ? 'Multiple values' : 'Add details (markdown supported)…'
          }
          fontFamily={fontFamily}
        />
      </div>
    </div>,
    document.body,
  );
}
