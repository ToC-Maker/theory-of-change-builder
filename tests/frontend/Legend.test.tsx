// PR #34 round-7 feedback (76): "why is the connection strength legend
// draggable? Tbh I'm not sure it's even necessary here? At least not
// on the edit mode."
//
// Contract after the fix:
//   - The legend is VIEW-MODE chrome. The editor canvas does not render
//     it at all — editors read confidence numerically in the EdgeEditor.
//     The view-only route mounts it as a fixed bottom-left overlay
//     OUTSIDE the zoom/pan transform, so it neither scales with zoom
//     nor permanently covers chart content (panning moves content out
//     from under it).
//   - The drag machinery is gone entirely. It dated from the legend's
//     birth commit (23bf0b8), where the default position was top-left
//     over the first column and dragging was the only escape; with a
//     fixed corner placement there is nothing to escape.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { Legend } from '../../src/components/Legend';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import { getConfidenceStrokeStyle } from '../../src/utils';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

const makeBaseData = (): ToCData => ({
  title: 'Test',
  sections: [
    {
      title: 'Inputs',
      columns: [
        {
          nodes: [
            {
              id: 'n-1',
              title: 'A',
              text: '',
              connectionIds: [],
              connections: [{ targetId: 'n-2', confidence: 70 }],
              yPosition: 100,
            },
            {
              id: 'n-2',
              title: 'B',
              text: '',
              connectionIds: [],
              connections: [],
              yPosition: 240,
            },
          ],
        },
      ],
    },
  ],
});

describe('Legend (static connection-strength key)', () => {
  it('renders one sample line per stop, drawn by getConfidenceStrokeStyle (single source of truth)', () => {
    const { container } = render(<Legend />);
    const lines = container.querySelectorAll('svg line');
    expect(lines.length).toBe(4);

    // Stops are user-visible contract: solid top end + descending
    // dashed stops, each labelled with its confidence.
    for (const stop of [100, 75, 50, 25]) {
      expect(screen.getByText(`${stop}%`)).toBeTruthy();
      const style = getConfidenceStrokeStyle(stop);
      const line = [...lines].find(
        (l) =>
          (style.strokeDasharray === 'none' && !l.getAttribute('stroke-dasharray')) ||
          l.getAttribute('stroke-dasharray') === style.strokeDasharray,
      );
      expect(line, `no sample line matching confidence ${stop}`).toBeTruthy();
    }
  });

  it('is a fixed-corner overlay with no drag affordance', () => {
    render(<Legend />);
    const root = screen.getByText('Connection Confidence').parentElement as HTMLElement;

    // Fixed corner placement (bottom-left; bottom-right belongs to the
    // viewer's zoom controls), not absolute-positioned-inside-canvas.
    expect(root.className).toContain('fixed');
    expect(root.className).toContain('bottom-4');
    expect(root.className).toContain('left-4');
    expect(root.className).not.toContain('absolute');

    // No grab cursor, no repositioning on mouse drag.
    expect(root.className).not.toContain('cursor-grab');
    fireEvent.mouseDown(root, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 300, clientY: 300 });
    fireEvent.mouseUp(document);
    expect(root.style.left).toBe('');
    expect(root.style.top).toBe('');
  });
});

describe('ToC does not own the legend anymore', () => {
  it('edit mode renders no legend (editors read confidence in the EdgeEditor)', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    expect(screen.queryByText('Connection Confidence')).toBeNull();
  });

  it('view mode renders no legend either — the viewer route mounts it outside the zoom transform', () => {
    render(<ToC data={makeBaseData()} showEditButton={false} />);
    expect(screen.queryByText('Connection Confidence')).toBeNull();
  });
});
