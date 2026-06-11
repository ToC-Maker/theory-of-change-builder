// PR #34 feedback (46): "nodes shouldn't overlap section titles."
//
// `yPosition` is the node's CENTER Y in column-content-local coords
// (y=0 is the top of the column body, which sits just below the section
// title bar). A center above `height/2` renders the node's top edge at
// a negative offset — i.e. over the title bar. `clampNodeCenterY` is
// the single constraint shared by every write path (drop, double-click
// create, arrow-key move) and by the render-time visual clamp for
// legacy data.
//
// `computeDropCenterY` is the drop-position math extracted from
// `handleDrop` (TheoryOfChangeGraph) so it is unit-testable:
//   - node-slot / over-node targets carry the cursor's column-local Y;
//     the node lands so the grab point stays under the cursor.
//   - targets with no cursor Y (new-column) take the legacy top-of-
//     column default.
//   - every result is clamped below the section title.
import { describe, it, expect } from 'vitest';
import {
  clampNodeCenterY,
  computeDropCenterY,
  DEFAULT_DROP_CENTER_Y,
} from '../../src/utils/nodePosition';

describe('clampNodeCenterY', () => {
  it('passes through centers whose top edge is inside the column body', () => {
    expect(clampNodeCenterY(100, 76)).toBe(100);
    expect(clampNodeCenterY(38, 76)).toBe(38); // top edge exactly at 0
  });

  it('clamps centers whose top edge would cross above the column top', () => {
    expect(clampNodeCenterY(10, 76)).toBe(38); // top would be -28
    expect(clampNodeCenterY(0, 76)).toBe(38);
    expect(clampNodeCenterY(-50, 76)).toBe(38);
  });

  it('scales the floor with node height', () => {
    expect(clampNodeCenterY(10, 30)).toBe(15);
    expect(clampNodeCenterY(20, 30)).toBe(20);
  });
});

describe('computeDropCenterY', () => {
  it('places the node so the grab point stays under the cursor (node-slot math)', () => {
    // Cursor at column-local 300, grabbed 30px below the node top,
    // zoom 1, height 76 → top = 270 → center = 308.
    expect(
      computeDropCenterY({
        cursorColumnLocalY: 300,
        pointerOffsetY: 30,
        zoomScale: 1,
        nodeHeight: 76,
      }),
    ).toBe(308);
  });

  it('divides the viewport-space pointer offset by the zoom scale', () => {
    // pointerOffset is captured in viewport px; at zoom 2 it spans half
    // as many container-local px.
    expect(
      computeDropCenterY({
        cursorColumnLocalY: 300,
        pointerOffsetY: 30,
        zoomScale: 2,
        nodeHeight: 76,
      }),
    ).toBe(300 - 15 + 38);
  });

  it('clamps drops aimed above the column top below the section title', () => {
    // Cursor near the column top, grabbed mid-node: raw top would be
    // -40 → raw center -2 → clamped to height/2.
    expect(
      computeDropCenterY({
        cursorColumnLocalY: 10,
        pointerOffsetY: 50,
        zoomScale: 1,
        nodeHeight: 76,
      }),
    ).toBe(38);
  });

  it('falls back to the clamped top-of-column default when no cursor Y (new-column)', () => {
    // Legacy default is 20; for a 76px node that is above the floor →
    // clamp to 38.
    expect(
      computeDropCenterY({
        cursorColumnLocalY: null,
        pointerOffsetY: 30,
        zoomScale: 1,
        nodeHeight: 76,
      }),
    ).toBe(38);
    // A short node keeps the legacy default when it already fits.
    expect(
      computeDropCenterY({
        cursorColumnLocalY: null,
        pointerOffsetY: 30,
        zoomScale: 1,
        nodeHeight: 30,
      }),
    ).toBe(DEFAULT_DROP_CENTER_Y);
  });
});
