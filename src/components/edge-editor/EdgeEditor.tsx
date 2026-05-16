// `EdgeEditor` — the unified anchored connection-property editor that
// replaced `<EdgePopup>` (the full-page modal) in PR 3.
//
// Anchored to the connection midpoint via `useAnchorPosition` (the
// caller provides an anchor ref pointing at an invisible 1x1 element
// at the midpoint, or a sibling element). Renders three controls:
//   - Confidence slider (live via mutateDebounced + commit on pointerup).
//   - Evidence textarea (buffered local; commit on blur).
//   - Assumptions textarea (buffered local; commit on blur).
//   - Delete button (removes the connection from the source node).
//
// Single-edge only by design — edges are addressed by (source, target)
// and there's no top-level collection of edges, so a multi-edge UI
// wouldn't have a useful aggregate operation.
//
// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
//
// Unmount cleanup flushes buffered evidence + assumptions writes via
// commit(). The pattern mirrors NodeEditor.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TrashIcon } from '@heroicons/react/24/outline';
import type { SetStateAction } from 'react';
import type { ToCData } from '../../types';
import { useEdgeProperties } from './useEdgeProperties';
import { useAnchorPosition } from '../node-editor/useAnchorPosition';

type GraphUpdater = SetStateAction<ToCData>;

interface EdgeEditorProps {
  sourceId: string;
  targetId: string;
  data: ToCData;
  anchorRef: React.RefObject<HTMLElement | null>;
  camera: { x: number; y: number; z: number };
  mutate: (updater: GraphUpdater) => void;
  mutateDebounced: (updater: GraphUpdater, key: string) => void;
  commit: (key?: string) => void;
  onRequestClose: () => void;
  fontFamily?: string;
}

export function EdgeEditor(props: EdgeEditorProps) {
  const {
    sourceId,
    targetId,
    data,
    anchorRef,
    camera,
    mutate,
    mutateDebounced,
    commit,
    onRequestClose,
    fontFamily,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);

  const props_ = useEdgeProperties({
    sourceId,
    targetId,
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

  // Unmount: flush buffered evidence + assumptions. Confidence uses
  // streaming commit on pointerup, so it's already covered.
  useEffect(() => {
    const commitEvidenceLocal = props_.commitEvidence;
    const commitAssumptionsLocal = props_.commitAssumptions;
    return () => {
      commitEvidenceLocal();
      commitAssumptionsLocal();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside-click dismissal — same pattern as NodeEditor.
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      const anchor = anchorRef.current;
      if (anchor && e.target instanceof Node && anchor.contains(e.target)) return;
      onRequestClose();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [anchorRef, onRequestClose]);

  const handleDelete = () => {
    props_.deleteConnection();
    onRequestClose();
  };

  return createPortal(
    <div
      ref={containerRef}
      className="edge-editor fixed z-[150] bg-white rounded-lg shadow-xl border border-gray-200 p-3 w-80 text-sm"
      style={
        position
          ? { left: position.x, top: position.y, fontFamily }
          : { left: -9999, top: -9999, fontFamily }
      }
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="edge-editor__header flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
        <span className="text-xs font-semibold text-gray-700">Connection</span>
        <button
          type="button"
          onClick={handleDelete}
          className="p-1 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
          title="Delete connection"
          aria-label="Delete connection"
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Confidence */}
      <label className="block mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-600">Confidence</span>
          <span className="text-xs text-gray-500 tabular-nums">
            {Math.round(props_.confidence)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={props_.confidence}
          aria-label="Confidence"
          onChange={(e) => props_.setConfidence(parseInt(e.target.value, 10))}
          onPointerUp={() => props_.commitConfidence()}
          onBlur={() => props_.commitConfidence()}
          className="w-full h-1 bg-gray-200 rounded appearance-none cursor-pointer"
        />
      </label>

      {/* Evidence */}
      <label className="block mb-3">
        <span className="text-xs text-gray-600 mb-1 block">Evidence</span>
        <textarea
          aria-label="Evidence"
          value={props_.evidence}
          onChange={(e) => props_.setEvidence(e.target.value)}
          onBlur={() => props_.commitEvidence()}
          placeholder="What evidence supports this connection?"
          rows={3}
          className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
          style={{ fontFamily }}
        />
      </label>

      {/* Assumptions */}
      <label className="block">
        <span className="text-xs text-gray-600 mb-1 block">Assumptions</span>
        <textarea
          aria-label="Assumptions"
          value={props_.assumptions}
          onChange={(e) => props_.setAssumptions(e.target.value)}
          onBlur={() => props_.commitAssumptions()}
          placeholder="What assumptions hold for this connection?"
          rows={3}
          className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
          style={{ fontFamily }}
        />
      </label>
    </div>,
    document.body,
  );
}
