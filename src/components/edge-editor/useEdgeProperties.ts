// `useEdgeProperties` — bridges the EdgeEditor UI to `useGraphMutation`.
//
// Single-edge only: edges are addressed by (sourceId, targetId), so the
// UI can only meaningfully edit one at a time.
//
// Two flavors of write, mirroring useNodeProperties:
//   - Live (streaming):
//       setConfidence → mutateDebounced(key='confidence-${edgeKey}')
//                       commitConfidence() from <input onPointerUp>.
//   - Buffered (typing):
//       setEvidence    → keeps local state for instant preview AND streams
//                        via mutateDebounced(key='evidence-${edgeKey}').
//                        commitEvidence() flushes on blur / unmount.
//       setAssumptions → same shape, key 'assumptions-${edgeKey}'.
//
// `edgeKey` = `${sourceId}->${targetId}` (directed: a->b ≠ b->a).
//
// The graph data format has TWO shapes:
//   - New: `connections: Array<{targetId, confidence, evidence, assumptions}>`
//   - Old: `connectionIds: string[]` (legacy, no per-edge metadata)
//
// All writers below produce a `connections` array (creating one from the
// legacy `connectionIds` if necessary). All readers prefer `connections`
// and fall back to a `connectionIds` view with zeroed metadata.
//
// `deleteConnection` removes the target from BOTH the new and legacy
// arrays atomically, so subsequent reads through either format see the
// connection as gone.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import type { Connection, Node as GraphNode, ToCData } from '../../types';

type GraphUpdater = SetStateAction<ToCData>;

interface UseEdgePropertiesArgs {
  sourceId: string;
  targetId: string;
  data: ToCData;
  mutate: (updater: GraphUpdater) => void;
  mutateDebounced: (updater: GraphUpdater, key: string) => void;
  commit: (key?: string) => void;
}

export interface UseEdgePropertiesResult {
  confidence: number;
  evidence: string;
  assumptions: string;
  setConfidence: (next: number) => void;
  setEvidence: (next: string) => void;
  setAssumptions: (next: string) => void;
  commitConfidence: () => void;
  commitEvidence: () => void;
  commitAssumptions: () => void;
  deleteConnection: () => void;
  isDirty: boolean;
}

const DEFAULT_CONFIDENCE = 50;

function findAllNodes(data: ToCData): GraphNode[] {
  return data.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes));
}

/**
 * Normalize a node's outgoing connections to the new shape. If the node
 * uses the legacy `connectionIds` array we synthesize the metadata at
 * default values so write paths can patch a single record.
 */
function readConnections(node: GraphNode): Connection[] {
  if (node.connections) return node.connections;
  return node.connectionIds.map((id) => ({ targetId: id, confidence: DEFAULT_CONFIDENCE }));
}

function readConnection(node: GraphNode, targetId: string): Connection | undefined {
  return readConnections(node).find((c) => c.targetId === targetId);
}

export function useEdgeProperties(args: UseEdgePropertiesArgs): UseEdgePropertiesResult {
  const { sourceId, targetId, data, mutate, mutateDebounced, commit } = args;

  const edgeKey = useMemo(() => `${sourceId}->${targetId}`, [sourceId, targetId]);

  // Locate the current connection record (post any recent mutation —
  // dataRef-backed).
  const sourceNode = useMemo(
    () => findAllNodes(data).find((n) => n.id === sourceId),
    [data, sourceId],
  );
  const conn = sourceNode ? readConnection(sourceNode, targetId) : undefined;

  const sourceConfidence = conn?.confidence ?? DEFAULT_CONFIDENCE;
  const sourceEvidence = conn?.evidence ?? '';
  const sourceAssumptions = conn?.assumptions ?? '';

  // Local buffers for the typing inputs.
  const [evidenceBuffer, setEvidenceBuffer] = useState(sourceEvidence);
  const [assumptionsBuffer, setAssumptionsBuffer] = useState(sourceAssumptions);

  // Resync the local buffer when the (sourceId, targetId) pair changes
  // (e.g. user clicks a different connection).
  const lastEdgeKeyRef = useRef(edgeKey);
  useEffect(() => {
    if (lastEdgeKeyRef.current !== edgeKey) {
      lastEdgeKeyRef.current = edgeKey;
      setEvidenceBuffer(sourceEvidence);
      setAssumptionsBuffer(sourceAssumptions);
    }
  }, [edgeKey, sourceEvidence, sourceAssumptions]);

  const [isDirty, setIsDirty] = useState(false);
  useEffect(() => {
    setIsDirty(false);
  }, [edgeKey]);

  /**
   * Map an updater over the source node's connections array, patching the
   * record for `targetId`. Handles the legacy `connectionIds` → new-shape
   * upgrade in a single pass.
   */
  const patchConnection = useCallback(
    (patch: Partial<Connection>) => {
      return (prev: ToCData): ToCData => ({
        ...prev,
        sections: prev.sections.map((section) => ({
          ...section,
          columns: section.columns.map((column) => ({
            ...column,
            nodes: column.nodes.map((node) => {
              if (node.id !== sourceId) return node;
              // Upgrade legacy → new format if needed.
              const baseConnections: Connection[] = node.connections
                ? node.connections
                : node.connectionIds.map((cid) => ({
                    targetId: cid,
                    confidence: DEFAULT_CONFIDENCE,
                  }));
              const found = baseConnections.some((c) => c.targetId === targetId);
              const nextConnections: Connection[] = found
                ? baseConnections.map((c) => (c.targetId === targetId ? { ...c, ...patch } : c))
                : [...baseConnections, { targetId, confidence: DEFAULT_CONFIDENCE, ...patch }];
              return { ...node, connections: nextConnections };
            }),
          })),
        })),
      });
    },
    [sourceId, targetId],
  );

  // --- streaming setters

  const setConfidence = useCallback(
    (next: number) => {
      setIsDirty(true);
      mutateDebounced(patchConnection({ confidence: next }), `confidence-${edgeKey}`);
    },
    [mutateDebounced, patchConnection, edgeKey],
  );

  const setEvidence = useCallback(
    (next: string) => {
      setEvidenceBuffer(next);
      setIsDirty(true);
      mutateDebounced(patchConnection({ evidence: next }), `evidence-${edgeKey}`);
    },
    [mutateDebounced, patchConnection, edgeKey],
  );

  const setAssumptions = useCallback(
    (next: string) => {
      setAssumptionsBuffer(next);
      setIsDirty(true);
      mutateDebounced(patchConnection({ assumptions: next }), `assumptions-${edgeKey}`);
    },
    [mutateDebounced, patchConnection, edgeKey],
  );

  // --- commits

  const commitConfidence = useCallback(() => {
    commit(`confidence-${edgeKey}`);
    setIsDirty(false);
  }, [commit, edgeKey]);

  const commitEvidence = useCallback(() => {
    commit(`evidence-${edgeKey}`);
    setIsDirty(false);
  }, [commit, edgeKey]);

  const commitAssumptions = useCallback(() => {
    commit(`assumptions-${edgeKey}`);
    setIsDirty(false);
  }, [commit, edgeKey]);

  // --- destructive

  const deleteConnection = useCallback(() => {
    mutate((prev) => ({
      ...prev,
      sections: prev.sections.map((section) => ({
        ...section,
        columns: section.columns.map((column) => ({
          ...column,
          nodes: column.nodes.map((node) => {
            if (node.id !== sourceId) return node;
            return {
              ...node,
              connections: (node.connections ?? []).filter((c) => c.targetId !== targetId),
              connectionIds: node.connectionIds.filter((id) => id !== targetId),
            };
          }),
        })),
      })),
    }));
  }, [mutate, sourceId, targetId]);

  return {
    confidence: sourceConfidence,
    evidence: evidenceBuffer,
    assumptions: assumptionsBuffer,
    setConfidence,
    setEvidence,
    setAssumptions,
    commitConfidence,
    commitEvidence,
    commitAssumptions,
    deleteConnection,
    isDirty,
  };
}
