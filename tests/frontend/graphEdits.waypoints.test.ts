// Regression coverage for the AI-edit data-loss path flagged in PR #34
// round-7 review: the AI system prompts (src/prompts/*.md) had drifted from
// the live graph schema (src/types/index.ts) and could teach the model to
// rewrite a whole connection/node object from an INCOMPLETE field list,
// silently dropping UI-managed fields the prompt never documented.
//
// The two UI-managed fields at risk:
//   - Connection.waypoints — bezier routing handles the user drags by hand
//     (src/hooks/useWaypointDrag). The model is never told to author these,
//     so any whole-object connection rewrite it emits omits them.
//   - Node.width / Node.color — user-tuned layout/appearance.
//
// applyEdits is a generic JSON-Patch-like path editor: `update` REPLACES the
// value at the target path (src/utils/graphEdits.ts `setAtPath`,
// `target[lastKey] = value`). It does NOT merge. So a whole-object `update`
// is inherently lossy for any field the model omits; a granular path `update`
// touches only the addressed leaf and preserves siblings.
//
// These tests therefore characterise BOTH patterns:
//   1. whole-object `update`  -> documents the data-loss (the lossy pattern
//      the pre-fix prompt modelled in its example JSON).
//   2. granular path `update` -> proves the safe pattern the corrected prompt
//      now teaches preserves waypoints / width / color.
//
// Decision (see PR notes): the fix is PROMPT-ONLY. applyEdits keeps replace
// semantics; assertion (1) locks that in, so any future move to merge-on-
// update is a deliberate, test-breaking choice rather than a silent drift.
import { describe, expect, it } from 'vitest';
import { applyEdits, type EditInstruction } from '../../src/utils/graphEdits';
import type { ToCData, Connection, Node } from '../../src/types';

// Fresh graph per test. Carries every UI-managed field the prompt drift put
// at risk: a connection with hand-dragged `waypoints`, a node with custom
// `width`/`color`, and the ToCData-level format fields.
function baseGraph(): ToCData {
  return {
    title: 'Theory of Change for Example Org',
    color: '#374151',
    curvature: 0.5,
    textSize: 1.2,
    fontFamily: 'Inter',
    columnPadding: 24,
    sectionPadding: 32,
    sections: [
      {
        title: 'Inputs',
        columns: [
          {
            nodes: [
              {
                id: 'n1',
                title: 'Node one',
                text: 'description',
                connectionIds: [],
                connections: [
                  {
                    targetId: 'n2',
                    confidence: 50,
                    evidence: 'baseline evidence',
                    assumptions: 'baseline assumption',
                    waypoints: [{ x: 120, y: 240 }],
                  },
                ],
                yPosition: 100,
                width: 240,
                color: '#E3F2FD',
              },
            ],
          },
        ],
      },
    ],
  };
}

// Lint-clean accessors (no non-null assertions): throw if the optional chain
// is absent so a structural regression surfaces as a clear failure.
function firstNode(g: ToCData): Node {
  return g.sections[0].columns[0].nodes[0];
}
function firstConnection(g: ToCData): Connection {
  const conns = firstNode(g).connections;
  if (!conns || conns.length === 0) throw new Error('expected a connection at nodes.0');
  return conns[0];
}

describe('applyEdits — UI-managed field preservation (PR #34 prompt-schema drift)', () => {
  it('REPLACE semantics: a whole-connection update drops undocumented waypoints (the data-loss path)', () => {
    // Mirrors the lossy pattern the pre-fix chatModePrompt.md example taught:
    // "change confidence" by rewriting the entire connection object from the
    // documented field list {targetId, confidence, evidence, assumptions} —
    // which omits waypoints.
    const edits: EditInstruction[] = [
      {
        type: 'update',
        path: 'sections.0.columns.0.nodes.0.connections.0',
        value: {
          targetId: 'n2',
          confidence: 90,
          evidence: 'baseline evidence',
          assumptions: 'baseline assumption',
        },
      },
    ];
    const result = applyEdits<ToCData>(baseGraph(), edits);
    const conn = firstConnection(result);

    expect(conn.confidence).toBe(90); // the intended change landed
    expect(conn.waypoints).toBeUndefined(); // ...but the hand-dragged route is GONE
  });

  it('REPLACE semantics: a whole-node update drops undocumented width/color (and nested waypoints)', () => {
    // "make this title case" rewriting the whole node from a partial field
    // list — drops width/color and, because connections nest under the node,
    // the waypoints too.
    const edits: EditInstruction[] = [
      {
        type: 'update',
        path: 'sections.0.columns.0.nodes.0',
        value: {
          id: 'n1',
          title: 'Node One',
          text: 'description',
          connectionIds: [],
          connections: [
            {
              targetId: 'n2',
              confidence: 50,
              evidence: 'baseline evidence',
              assumptions: 'baseline assumption',
            },
          ],
          yPosition: 100,
        },
      },
    ];
    const result = applyEdits<ToCData>(baseGraph(), edits);
    const node = firstNode(result);

    expect(node.title).toBe('Node One'); // intended change landed
    expect(node.width).toBeUndefined(); // user-tuned width GONE
    expect(node.color).toBeUndefined(); // user-tuned color GONE
    expect(firstConnection(result).waypoints).toBeUndefined(); // nested route GONE
  });

  it('SAFE pattern: a granular confidence update preserves waypoints', () => {
    // The pattern the corrected prompt now teaches: edit only the leaf.
    const edits: EditInstruction[] = [
      {
        type: 'update',
        path: 'sections.0.columns.0.nodes.0.connections.0.confidence',
        value: 90,
      },
    ];
    const result = applyEdits<ToCData>(baseGraph(), edits);
    const conn = firstConnection(result);

    expect(conn.confidence).toBe(90);
    expect(conn.waypoints).toEqual([{ x: 120, y: 240 }]); // preserved
    expect(conn.evidence).toBe('baseline evidence'); // siblings untouched
  });

  it('SAFE pattern: a granular node-title update preserves width/color/waypoints', () => {
    const edits: EditInstruction[] = [
      {
        type: 'update',
        path: 'sections.0.columns.0.nodes.0.title',
        value: 'Node One',
      },
    ];
    const result = applyEdits<ToCData>(baseGraph(), edits);
    const node = firstNode(result);

    expect(node.title).toBe('Node One');
    expect(node.width).toBe(240); // preserved
    expect(node.color).toBe('#E3F2FD'); // preserved
    expect(firstConnection(result).waypoints).toEqual([{ x: 120, y: 240 }]); // preserved
  });

  it('SAFE pattern: granular node/connection edits never touch ToCData-level format fields', () => {
    // The format fields (curvature/textSize/fontFamily/columnPadding/
    // sectionPadding) only sit at the root, so node/connection edits leave
    // them intact. A whole-graph root `update` is the only thing that could
    // drop them, and the prompt does not teach that.
    const edits: EditInstruction[] = [
      {
        type: 'update',
        path: 'sections.0.columns.0.nodes.0.connections.0.confidence',
        value: 75,
      },
    ];
    const result = applyEdits<ToCData>(baseGraph(), edits);

    expect(result.curvature).toBe(0.5);
    expect(result.textSize).toBe(1.2);
    expect(result.fontFamily).toBe('Inter');
    expect(result.columnPadding).toBe(24);
    expect(result.sectionPadding).toBe(32);
  });
});
