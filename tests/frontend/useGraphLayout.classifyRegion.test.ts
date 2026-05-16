// Tests for `useGraphLayout.classifyRegion`.
//
// `classifyRegion(localPoint)` is called only during an active drag
// (PR 4's `usePointerDrag.onMove`) to decide where a drop would land.
// Outside of drag, add/select/delete affordances are CSS hover states
// (PR 5 design); there is no global pointermove subscription.
//
// X-axis zone partitioning (sections render side-by-side as horizontal
// flex siblings, no overlap):
//   'node-slot'    — X in column rect, Y not over existing node
//   'over-node'    — over an existing node (no drop slot)
//   'new-column'   — X in 24px column gutter inside same section
//   'new-section'  — X in 32px section padding (incl. leftmost/rightmost)
//   null           — void (above headers, below all columns, outside)
import { describe, it, expect } from 'vitest';
import { classifyRegion } from '../../src/hooks/useGraphLayout';
import type { LayoutSnapshot } from '../../src/hooks/useGraphLayout';

// Build a simple two-section layout snapshot.
//
// Section 0: [Col0 (200px wide)] [Col1 (200px wide)]
// Section 1: [Col0 (200px wide)]
//
// Column gutter = 24 px. Section gutter = 32 px.
// Y range for columns: 100..900.
// Node A in Sect0/Col0 at center y = 200, height 60 (rect 170..230).
const makeSnapshot = (): LayoutSnapshot => ({
  sectionPadding: 32,
  columnPadding: 24,
  // [sectionIdx][colIdx] → rect
  columnRects: [
    [
      // section 0
      { left: 32, right: 232, top: 100, bottom: 900 },
      { left: 232 + 24, right: 232 + 24 + 200, top: 100, bottom: 900 },
    ],
    [
      // section 1
      { left: 232 + 24 + 200 + 32, right: 232 + 24 + 200 + 32 + 200, top: 100, bottom: 900 },
    ],
  ],
  containerWidth: 232 + 24 + 200 + 32 + 200 + 32, // 752
  containerHeight: 1000,
  // Existing nodes — keyed by section+column → list of {top, bottom}
  nodeRects: {
    '0-0': [{ top: 170, bottom: 230, left: 32, right: 232 }],
    '0-1': [],
    '1-0': [],
  },
});

describe('classifyRegion', () => {
  it('returns "node-slot" inside a column with no node at that Y', () => {
    const snap = makeSnapshot();
    const r = classifyRegion(snap, { x: 100, y: 400 });
    expect(r).toEqual({
      kind: 'node-slot',
      sectionIdx: 0,
      columnIdx: 0,
      yPosition: 300, // 400 - top(100)
    });
  });

  it('returns "over-node" when Y is inside an existing node rect', () => {
    const snap = makeSnapshot();
    const r = classifyRegion(snap, { x: 100, y: 200 });
    expect(r?.kind).toBe('over-node');
    expect(r?.sectionIdx).toBe(0);
    expect(r?.columnIdx).toBe(0);
  });

  it('returns "new-column" when X is inside the column gutter inside a section', () => {
    const snap = makeSnapshot();
    // Gutter between Sect0/Col0 (right=232) and Sect0/Col1 (left=256).
    // X=240 lies in the gutter.
    const r = classifyRegion(snap, { x: 240, y: 400 });
    expect(r?.kind).toBe('new-column');
    expect(r?.sectionIdx).toBe(0);
    // columnIdx is the insertion point: 1 (between col 0 and col 1).
    expect(r?.columnIdx).toBe(1);
  });

  it('returns "new-section" when X is in the section padding between sections', () => {
    const snap = makeSnapshot();
    // Right edge of section 0 is 456 (Sect0/Col1 right). Left edge of
    // section 1's column 0 is 488 (456 + 32). X=470 sits in the
    // section gutter.
    const r = classifyRegion(snap, { x: 470, y: 400 });
    expect(r?.kind).toBe('new-section');
    expect(r?.sectionIdx).toBe(1); // insertion point: section 1
  });

  it('returns "new-section" at the leftmost edge (before section 0)', () => {
    const snap = makeSnapshot();
    const r = classifyRegion(snap, { x: 10, y: 400 });
    expect(r?.kind).toBe('new-section');
    expect(r?.sectionIdx).toBe(0); // insert before section 0
  });

  it('returns "new-section" at the rightmost edge (after last section)', () => {
    const snap = makeSnapshot();
    const r = classifyRegion(snap, { x: 745, y: 400 });
    expect(r?.kind).toBe('new-section');
    expect(r?.sectionIdx).toBe(2); // insert after the last section
  });

  it('returns null when Y is above the column rects (void above)', () => {
    const snap = makeSnapshot();
    const r = classifyRegion(snap, { x: 100, y: 50 });
    expect(r).toBeNull();
  });

  it('returns null when Y is below the column rects (void below)', () => {
    const snap = makeSnapshot();
    const r = classifyRegion(snap, { x: 100, y: 950 });
    expect(r).toBeNull();
  });

  it('handles empty chart (no sections) → null everywhere', () => {
    const snap: LayoutSnapshot = {
      sectionPadding: 32,
      columnPadding: 24,
      columnRects: [],
      containerWidth: 0,
      containerHeight: 0,
      nodeRects: {},
    };
    expect(classifyRegion(snap, { x: 0, y: 0 })).toBeNull();
    expect(classifyRegion(snap, { x: 100, y: 100 })).toBeNull();
  });

  it('handles single section / single column', () => {
    const snap: LayoutSnapshot = {
      sectionPadding: 32,
      columnPadding: 24,
      columnRects: [[{ left: 32, right: 232, top: 100, bottom: 900 }]],
      containerWidth: 264,
      containerHeight: 1000,
      nodeRects: { '0-0': [] },
    };
    expect(classifyRegion(snap, { x: 100, y: 400 })?.kind).toBe('node-slot');
    // Leftmost / rightmost still resolve to new-section.
    expect(classifyRegion(snap, { x: 10, y: 400 })?.kind).toBe('new-section');
    expect(classifyRegion(snap, { x: 250, y: 400 })?.kind).toBe('new-section');
  });
});
