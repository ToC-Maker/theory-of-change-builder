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
// A node's edges are its `connections: Array<{targetId, confidence,
// evidence, assumptions}>`. Charts from outside the tab are normalised on the
// way in (`normalizeChart` builds `connections` from the legacy
// `connectionIds`), so this reads `connections` only; `connectionIds` is kept
// listing the same targets for the code that still reads it.
//
// `deleteConnection` removes the target from BOTH arrays atomically, so
// subsequent reads through either see the connection as gone.
import { useCallback, useMemo } from 'react';
import type { SetStateAction } from 'react';
import { useFieldBuffer } from '../../hooks/useFieldBuffer';
import { validWaypointOffsets } from '../../utils/connectionGeometry';
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
  /**
   * True when the connection has at least one custom waypoint that
   * renders (old-format or malformed entries draw the automatic curve,
   * so there is nothing to reset). Gates the EdgeEditor's "Reset path"
   * button.
   */
  hasWaypoints: boolean;
  setConfidence: (next: number) => void;
  setEvidence: (next: string) => void;
  setAssumptions: (next: string) => void;
  commitConfidence: () => void;
  commitEvidence: () => void;
  commitAssumptions: () => void;
  deleteConnection: () => void;
}

const DEFAULT_CONFIDENCE = 50;

function findAllNodes(data: ToCData): GraphNode[] {
  return data.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes));
}

function readConnection(node: GraphNode, targetId: string): Connection | undefined {
  return node.connections?.find((c) => c.targetId === targetId);
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

  // Local buffers for the typing inputs. They reset when the (sourceId,
  // targetId) pair changes (user clicks a different connection) and adopt
  // any value of the connection the user did not write, which is how a
  // collaborator's change reaches the open editor (see `useFieldBuffer`).
  const [evidenceBuffer, setEvidenceBuffer] = useFieldBuffer(sourceEvidence, edgeKey);
  const [assumptionsBuffer, setAssumptionsBuffer] = useFieldBuffer(sourceAssumptions, edgeKey);

  /**
   * Map an updater over the source node's connections array, patching the
   * record for `targetId`. A connection that is not in the chart (the
   * editor stayed open after someone deleted it) is left absent, not
   * created from the patch, and the chart comes back as it was.
   */
  const patchConnection = useCallback(
    (patch: Partial<Connection>) => {
      return (prev: ToCData): ToCData => {
        const source = findAllNodes(prev).find((n) => n.id === sourceId);
        if (!source || !readConnection(source, targetId)) return prev;
        return {
          ...prev,
          sections: prev.sections.map((section) => ({
            ...section,
            columns: section.columns.map((column) => ({
              ...column,
              nodes: column.nodes.map((node) =>
                node.id === sourceId
                  ? {
                      ...node,
                      connections: node.connections?.map((c) =>
                        c.targetId === targetId ? { ...c, ...patch } : c,
                      ),
                    }
                  : node,
              ),
            })),
          })),
        };
      };
    },
    [sourceId, targetId],
  );

  // --- streaming setters

  const setConfidence = useCallback(
    (next: number) => {
      mutateDebounced(patchConnection({ confidence: next }), `confidence-${edgeKey}`);
    },
    [mutateDebounced, patchConnection, edgeKey],
  );

  const setEvidence = useCallback(
    (next: string) => {
      setEvidenceBuffer(next);
      mutateDebounced(patchConnection({ evidence: next }), `evidence-${edgeKey}`);
    },
    [setEvidenceBuffer, mutateDebounced, patchConnection, edgeKey],
  );

  const setAssumptions = useCallback(
    (next: string) => {
      setAssumptionsBuffer(next);
      mutateDebounced(patchConnection({ assumptions: next }), `assumptions-${edgeKey}`);
    },
    [setAssumptionsBuffer, mutateDebounced, patchConnection, edgeKey],
  );

  // --- commits

  const commitConfidence = useCallback(() => {
    commit(`confidence-${edgeKey}`);
  }, [commit, edgeKey]);

  const commitEvidence = useCallback(() => {
    commit(`evidence-${edgeKey}`);
  }, [commit, edgeKey]);

  const commitAssumptions = useCallback(() => {
    commit(`assumptions-${edgeKey}`);
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
    hasWaypoints: validWaypointOffsets(conn?.waypoints).length > 0,
    setConfidence,
    setEvidence,
    setAssumptions,
    commitConfidence,
    commitEvidence,
    commitAssumptions,
    deleteConnection,
  };
}
