// PR 5 Task 5.2 unit tests for `buildConnectionPath`.
//
// The path math was extracted from `ConnectionsComponent.tsx:670-714`
// (now reduced to a single `buildConnectionPath` call). These tests pin
// the SVG `d` shape so a regression in the shared utility surfaces
// loudly (both the select-2 ghost and the drag-to-connect ghost depend
// on the same output).

import { describe, it, expect } from 'vitest';
import { buildConnectionPath } from '../../src/components/canvas/connectionPath';

describe('buildConnectionPath', () => {
  it('forward bezier curves rightward with offset', () => {
    const d = buildConnectionPath({
      startX: 0,
      startY: 50,
      endX: 200,
      endY: 50,
      curvature: 0.5,
      direction: 'forward',
    });
    // baseOffset = 100; offset = 100 * (0.1 + 0.5 * 1.9) = 100 * 1.05 = 105.
    expect(d).toBe('M 0 50 C 105 50, 95 50, 200 50');
  });

  it('backward bezier mirrors the offset on the source side', () => {
    const d = buildConnectionPath({
      startX: 200,
      startY: 50,
      endX: 0,
      endY: 50,
      curvature: 0.5,
      direction: 'backward',
    });
    // baseOffset = 100; offset = 105. backward: source-offset, end+offset.
    expect(d).toBe('M 200 50 C 95 50, 105 50, 0 50');
  });

  it('vertical direction collapses to a straight bezier (offset=0)', () => {
    const d = buildConnectionPath({
      startX: 50,
      startY: 0,
      endX: 50,
      endY: 200,
      curvature: 0.5,
      direction: 'vertical',
    });
    expect(d).toBe('M 50 0 C 50 0, 50 200, 50 200');
  });

  it('curvature=0 produces zero offset on horizontal directions', () => {
    const d = buildConnectionPath({
      startX: 0,
      startY: 50,
      endX: 200,
      endY: 50,
      curvature: 0,
      direction: 'forward',
    });
    expect(d).toBe('M 0 50 C 0 50, 200 50, 200 50');
  });

  it('higher curvature produces a wider offset', () => {
    const dLow = buildConnectionPath({
      startX: 0,
      startY: 50,
      endX: 200,
      endY: 50,
      curvature: 0.1,
      direction: 'forward',
    });
    const dHigh = buildConnectionPath({
      startX: 0,
      startY: 50,
      endX: 200,
      endY: 50,
      curvature: 1.0,
      direction: 'forward',
    });
    // Extract the first control-point X from each:
    //   "M 0 50 C <cpx> 50, ..."
    const cpxLow = parseFloat(dLow.split(' C ')[1].split(' ')[0]);
    const cpxHigh = parseFloat(dHigh.split(' C ')[1].split(' ')[0]);
    expect(cpxHigh).toBeGreaterThan(cpxLow);
  });
});
