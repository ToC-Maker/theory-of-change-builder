// Connection anchors and relative waypoints.
//
// A waypoint is stored as a pixel offset `{dx, dy}` from the midpoint of
// the straight line between the connection's source and target anchors.
// Whatever moves the nodes therefore moves the bend with them, with no
// per-operation translation. These tests pin the conversion both ways and
// the rule that anything that is not a finite `{dx, dy}` (old absolute
// `{x, y}` entries, junk) is ignored so the automatic curve renders.

import { describe, expect, it } from 'vitest';
import {
  computeConnectionAnchors,
  getConnectionDirection,
  lineMidpoint,
  offsetFromMidpoint,
  resolveWaypoints,
  validWaypointOffsets,
} from '../../src/utils/connectionGeometry';

const box = (x: number, y: number, width = 100, height = 60) => ({ x, y, width, height });

describe('getConnectionDirection', () => {
  it('is vertical within one column', () => {
    expect(
      getConnectionDirection(
        { sectionIndex: 1, columnIndex: 2 },
        { sectionIndex: 1, columnIndex: 2 },
      ),
    ).toBe('vertical');
  });

  it('is forward toward a later column or section', () => {
    expect(
      getConnectionDirection(
        { sectionIndex: 0, columnIndex: 0 },
        { sectionIndex: 0, columnIndex: 1 },
      ),
    ).toBe('forward');
    expect(
      getConnectionDirection(
        { sectionIndex: 0, columnIndex: 3 },
        { sectionIndex: 1, columnIndex: 0 },
      ),
    ).toBe('forward');
  });

  it('is backward toward an earlier column or section', () => {
    expect(
      getConnectionDirection(
        { sectionIndex: 0, columnIndex: 1 },
        { sectionIndex: 0, columnIndex: 0 },
      ),
    ).toBe('backward');
    expect(
      getConnectionDirection(
        { sectionIndex: 2, columnIndex: 0 },
        { sectionIndex: 1, columnIndex: 5 },
      ),
    ).toBe('backward');
  });
});

describe('computeConnectionAnchors', () => {
  it('forward: leaves the right edge of the source, ends 14px before the target left edge', () => {
    const { source, target } = computeConnectionAnchors(box(0, 100), box(300, 200), 'forward');
    expect(source).toEqual({ x: 100, y: 130 });
    expect(target).toEqual({ x: 286, y: 230 });
  });

  it('backward: leaves the left edge of the source, ends 14px past the target right edge', () => {
    const { source, target } = computeConnectionAnchors(box(300, 100), box(0, 200), 'backward');
    expect(source).toEqual({ x: 300, y: 130 });
    expect(target).toEqual({ x: 114, y: 230 });
  });

  it('vertical, source above: bottom centre of the source to 14px above the target', () => {
    const { source, target } = computeConnectionAnchors(box(0, 0), box(0, 200), 'vertical');
    expect(source).toEqual({ x: 50, y: 60 });
    expect(target).toEqual({ x: 50, y: 186 });
  });

  it('vertical, source below: top centre of the source to 14px below the target', () => {
    const { source, target } = computeConnectionAnchors(box(0, 200), box(0, 0), 'vertical');
    expect(source).toEqual({ x: 50, y: 200 });
    expect(target).toEqual({ x: 50, y: 74 });
  });
});

describe('lineMidpoint', () => {
  it('is the middle of the straight line between the anchors', () => {
    expect(lineMidpoint({ x: 0, y: 10 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 30 });
  });
});

describe('offsetFromMidpoint / resolveWaypoints', () => {
  const mid = { x: 200, y: 100 };

  it('resolves an offset to the midpoint plus the offset', () => {
    expect(resolveWaypoints([{ dx: 15, dy: -40 }], mid)).toEqual([{ x: 215, y: 60 }]);
  });

  it('round-trips a dragged absolute point', () => {
    const dragged = { x: 333.5, y: 12.25 };
    const offset = offsetFromMidpoint(dragged, mid);
    expect(offset).toEqual({ dx: 133.5, dy: -87.75 });
    expect(resolveWaypoints([offset], mid)).toEqual([dragged]);
  });

  it('moves with the line: translating both anchors translates the resolved point equally', () => {
    const offsets = [{ dx: 20, dy: -30 }];
    const before = resolveWaypoints(offsets, lineMidpoint({ x: 0, y: 0 }, { x: 100, y: 40 }))[0];
    const after = resolveWaypoints(offsets, lineMidpoint({ x: 70, y: 25 }, { x: 170, y: 65 }))[0];
    expect({ x: after.x - before.x, y: after.y - before.y }).toEqual({ x: 70, y: 25 });
  });

  it('keeps the offset when the line shrinks (fixed pixels, not a proportion)', () => {
    const offsets = [{ dx: 0, dy: -50 }];
    const long = resolveWaypoints(offsets, lineMidpoint({ x: 0, y: 0 }, { x: 400, y: 0 }))[0];
    const short = resolveWaypoints(offsets, lineMidpoint({ x: 0, y: 0 }, { x: 40, y: 0 }))[0];
    // Both lines sit on y = 0, so the resolved y is the offset itself.
    expect(long.y).toBe(-50);
    expect(short.y).toBe(-50);
  });
});

describe('ignoring entries that are not finite {dx, dy}', () => {
  const mid = { x: 0, y: 0 };

  it('drops old absolute {x, y} entries so the automatic curve renders', () => {
    expect(resolveWaypoints([{ x: 120, y: 240 }], mid)).toEqual([]);
  });

  it.each([
    ['NaN', [{ dx: Number.NaN, dy: 1 }]],
    ['Infinity', [{ dx: 1, dy: Number.POSITIVE_INFINITY }]],
    ['strings', [{ dx: '1', dy: '2' }]],
    ['null entry', [null]],
    ['number entry', [7]],
    ['missing dy', [{ dx: 1 }]],
    ['not an array', { dx: 1, dy: 2 }],
    ['undefined', undefined],
  ])('drops malformed input: %s', (_label, input) => {
    expect(resolveWaypoints(input, mid)).toEqual([]);
    expect(validWaypointOffsets(input)).toEqual([]);
  });

  it('keeps the valid entries next to junk ones', () => {
    expect(
      resolveWaypoints(
        [
          { x: 1, y: 2 },
          { dx: 5, dy: 6 },
        ],
        mid,
      ),
    ).toEqual([{ x: 5, y: 6 }]);
  });
});
