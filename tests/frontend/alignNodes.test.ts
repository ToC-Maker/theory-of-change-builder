// `computeAlignedSections` — pure alignment math extracted from
// `TheoryOfChangeGraph.straightenEdges` (PR #34 round-4 feedback 67).
//
// The grouping algorithm is ported verbatim from the previous inline
// implementation (greedy first-fit on running group average, tolerance
// 40px, group average rounded). What changed is the WRITE: the previous
// code mutated the prior state in place through a shallow `{...prev}`
// copy, which corrupted App.tsx's undo snapshot (see
// `TheoryOfChangeGraph.alignment.test.tsx` for the full story). The
// pure function must never touch its input.

import { describe, expect, it } from 'vitest';
import { computeAlignedSections } from '../../src/utils/alignNodes';
import type { ToCData } from '../../src/types';

type Sections = ToCData['sections'];

const NODE_DEFAULTS = { title: 'n', text: '', connectionIds: [] as string[] };

function sectionsWith(nodes: Array<{ id: string; yPosition?: number }>): Sections {
  // One node per column, two columns per section, to spread nodes
  // around like a real chart. Geometry is irrelevant to the grouping
  // (it only reads center Y).
  return [
    {
      title: 'S1',
      columns: nodes.map((n) => ({ nodes: [{ ...NODE_DEFAULTS, ...n }] })),
    },
  ];
}

function yPositions(sections: Sections): Array<number | undefined> {
  return sections.flatMap((s) => s.columns.flatMap((c) => c.nodes.map((n) => n.yPosition)));
}

describe('computeAlignedSections', () => {
  it('snaps near-aligned nodes (within 40px of the group average) to the rounded average', () => {
    const input = sectionsWith([
      { id: 'a', yPosition: 100 },
      { id: 'b', yPosition: 140 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(yPositions(result)).toEqual([120, 120]);
  });

  it('does NOT mutate the input sections (undo snapshot integrity)', () => {
    const input = sectionsWith([
      { id: 'a', yPosition: 100 },
      { id: 'b', yPosition: 140 },
    ]);
    const snapshot = JSON.parse(JSON.stringify(input));
    computeAlignedSections(input, {});
    expect(input).toEqual(snapshot);
  });

  it('leaves singleton groups untouched and preserves their node identity', () => {
    const input = sectionsWith([
      { id: 'a', yPosition: 100 },
      { id: 'b', yPosition: 140 },
      { id: 'lone', yPosition: 600 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(yPositions(result)).toEqual([120, 120, 600]);
    // Untouched nodes keep object identity (memo-friendliness).
    expect(result[0].columns[2].nodes[0]).toBe(input[0].columns[2].nodes[0]);
  });

  it('uses the legacy default center for nodes without yPosition (idx*180 + 30 + height/2)', () => {
    // Node without yPosition at nodeIndex 0 with fallback height 76 →
    // default center 30 + 38 = 68. Grouped with an explicit 100 →
    // average 84.
    const input: Sections = [
      {
        title: 'S1',
        columns: [
          { nodes: [{ ...NODE_DEFAULTS, id: 'implicit' }] },
          { nodes: [{ ...NODE_DEFAULTS, id: 'explicit', yPosition: 100 }] },
        ],
      },
    ];
    const result = computeAlignedSections(input, {});
    expect(yPositions(result)).toEqual([84, 84]);
  });

  it('respects measured node heights for the default center', () => {
    // Height 100 → default center 30 + 50 = 80; partner at 120 →
    // average 100.
    const input: Sections = [
      {
        title: 'S1',
        columns: [
          { nodes: [{ ...NODE_DEFAULTS, id: 'tall' }] },
          { nodes: [{ ...NODE_DEFAULTS, id: 'partner', yPosition: 120 }] },
        ],
      },
    ];
    const result = computeAlignedSections(input, { tall: 100 });
    expect(yPositions(result)).toEqual([100, 100]);
  });

  it('returns the input sections array unchanged (same reference) when nothing needs aligning', () => {
    const input = sectionsWith([
      { id: 'a', yPosition: 100 },
      { id: 'far', yPosition: 500 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(result).toBe(input);
  });

  it('rounds the group average like the previous implementation', () => {
    // 100 + 101 + 105 → avg 102 (Math.round of 102.0); 100/101/105 are
    // all within 40 of the running averages, forming one group.
    const input = sectionsWith([
      { id: 'a', yPosition: 100 },
      { id: 'b', yPosition: 101 },
      { id: 'c', yPosition: 105 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(yPositions(result)).toEqual([102, 102, 102]);
  });
});

// PR #34 round-4 feedback 68: custom waypoints must FOLLOW alignment.
// Alignment previously moved nodes through a write path that never ran
// the drag path's waypoint translation, leaving the user's bend parked
// at stale absolute coordinates (live evidence: endpoints moved ±10px,
// waypoint stayed put). Decision: translate each connection's
// waypoints by the MEAN of its two endpoints' alignment deltas — the
// exact generalization of the drag path's half-delta rule
// (TheoryOfChangeGraph.handleDrop: one endpoint moved by d → waypoints
// shift d/2; here both endpoints may move, contributing d/2 each).
// Because the translation happens inside the same pure computation,
// alignment stays ONE mutation → ONE undo entry, and undo restores the
// waypoints exactly (purity test above).
describe('computeAlignedSections — waypoint translation (feedback 68)', () => {
  function connected(
    nodes: Array<{
      id: string;
      yPosition?: number;
      connections?: Array<{
        targetId: string;
        confidence: number;
        waypoints?: Array<{ x: number; y: number }>;
      }>;
    }>,
  ): Sections {
    return [
      {
        title: 'S1',
        columns: nodes.map((n) => ({ nodes: [{ ...NODE_DEFAULTS, ...n }] })),
      },
    ];
  }

  it('shifts a waypoint by half the delta when only the source endpoint moves', () => {
    // a (100) groups with partner (140) → both to 120; a's delta +20.
    // far (500) is alone → delta 0. Waypoint on a→far shifts by
    // (+20 + 0) / 2 = +10 in y; x untouched.
    const input = connected([
      {
        id: 'a',
        yPosition: 100,
        connections: [{ targetId: 'far', confidence: 75, waypoints: [{ x: 300, y: 250 }] }],
      },
      { id: 'partner', yPosition: 140 },
      { id: 'far', yPosition: 500 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(result[0].columns[0].nodes[0].connections![0].waypoints).toEqual([{ x: 300, y: 260 }]);
  });

  it('shifts a waypoint by half the delta when only the target endpoint moves', () => {
    const input = connected([
      {
        id: 'far',
        yPosition: 500,
        connections: [{ targetId: 'a', confidence: 75, waypoints: [{ x: 300, y: 250 }] }],
      },
      { id: 'a', yPosition: 100 },
      { id: 'partner', yPosition: 140 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(result[0].columns[0].nodes[0].connections![0].waypoints).toEqual([{ x: 300, y: 260 }]);
  });

  it('sums both endpoint contributions when source and target both move', () => {
    // Groups: {a:100, p1:140} → 120 (a +20) and {b:400, p2:420} → 410
    // (b +10). Waypoint on a→b shifts by (+20 + +10) / 2 = +15.
    const input = connected([
      {
        id: 'a',
        yPosition: 100,
        connections: [{ targetId: 'b', confidence: 75, waypoints: [{ x: 300, y: 250 }] }],
      },
      { id: 'p1', yPosition: 140 },
      { id: 'b', yPosition: 400 },
      { id: 'p2', yPosition: 420 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(result[0].columns[0].nodes[0].connections![0].waypoints).toEqual([{ x: 300, y: 265 }]);
  });

  it('leaves the waypoint alone when both endpoints are in the same two-node group (deltas cancel)', () => {
    const input = connected([
      {
        id: 'a',
        yPosition: 100,
        connections: [{ targetId: 'b', confidence: 75, waypoints: [{ x: 300, y: 250 }] }],
      },
      { id: 'b', yPosition: 140 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(result[0].columns[0].nodes[0].connections![0].waypoints).toEqual([{ x: 300, y: 250 }]);
  });

  it('translates every entry of a legacy multi-waypoint array', () => {
    const input = connected([
      {
        id: 'a',
        yPosition: 100,
        connections: [
          {
            targetId: 'far',
            confidence: 75,
            waypoints: [
              { x: 300, y: 250 },
              { x: 350, y: 280 },
            ],
          },
        ],
      },
      { id: 'partner', yPosition: 140 },
      { id: 'far', yPosition: 500 },
    ]);
    const result = computeAlignedSections(input, {});
    expect(result[0].columns[0].nodes[0].connections![0].waypoints).toEqual([
      { x: 300, y: 260 },
      { x: 350, y: 290 },
    ]);
  });

  it('keeps connection identity when neither endpoint moved', () => {
    const input = connected([
      { id: 'a', yPosition: 100 },
      { id: 'partner', yPosition: 140 },
      {
        id: 'far',
        yPosition: 500,
        connections: [{ targetId: 'far2', confidence: 75, waypoints: [{ x: 300, y: 250 }] }],
      },
      { id: 'far2', yPosition: 700 },
    ]);
    const result = computeAlignedSections(input, {});
    // far/far2 are singleton groups: untouched, identity preserved.
    expect(result[0].columns[2].nodes[0]).toBe(input[0].columns[2].nodes[0]);
  });

  it('does not mutate the input when translating waypoints', () => {
    const input = connected([
      {
        id: 'a',
        yPosition: 100,
        connections: [{ targetId: 'far', confidence: 75, waypoints: [{ x: 300, y: 250 }] }],
      },
      { id: 'partner', yPosition: 140 },
      { id: 'far', yPosition: 500 },
    ]);
    const snapshot = JSON.parse(JSON.stringify(input));
    computeAlignedSections(input, {});
    expect(input).toEqual(snapshot);
  });
});
