// PR #34 feedback (46): "nodes shouldn't overlap section titles."
//
// `yPosition` is the node's CENTER Y in column-content-local coords;
// the renderer derives the wrapper's `top` as `yPosition - height/2`.
// Data may legitimately contain out-of-range values (old charts, AI
// edits, pre-fix drops), so the renderer clamps the *visual* position
// to the column body (top ≥ 0 keeps the node below the section title
// bar) without rewriting the stored yPosition.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

const makeData = (yPosition: number): ToCData => ({
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
              connections: [],
              yPosition,
            },
          ],
        },
      ],
    },
  ],
});

// The absolutely-positioned slot wrapper is the node root's ancestor
// that carries the inline `top`.
function nodeWrapperTop(): string {
  const root = document.getElementById('node-n-1');
  expect(root).not.toBeNull();
  const wrapper = root!.closest('.absolute') as HTMLElement | null;
  expect(wrapper).not.toBeNull();
  return wrapper!.style.top;
}

describe('TheoryOfChangeGraph node render clamp (PR #34 fb 46)', () => {
  it('renders in-range yPositions at center - height/2 (unchanged behavior)', () => {
    // jsdom measures no heights → the 76px default applies: top = 200 - 38.
    render(<ToC data={makeData(200)} showEditButton={true} />);
    expect(nodeWrapperTop()).toBe('162px');
  });

  it('clamps an out-of-range yPosition to the top of the column body', () => {
    // yPosition 10 with the 76px default height → raw top would be
    // -28px, poking above the column body into the section title bar.
    render(<ToC data={makeData(10)} showEditButton={true} />);
    expect(nodeWrapperTop()).toBe('0px');
  });

  it('clamps in view-only mode too', () => {
    render(<ToC data={makeData(-100)} showEditButton={false} />);
    expect(nodeWrapperTop()).toBe('0px');
  });
});
