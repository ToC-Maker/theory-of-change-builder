// A new or empty column is laid out as wide as the node you then add to it,
// so adding the first node does not widen the section. Edit and view mode
// share the geometry.
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, act } from '@testing-library/react';
import type { ChartInput } from '../../src/types';
import { renderToC } from './helpers/renderToC';

afterEach(() => {
  cleanup();
});

const makeData = (): ChartInput => ({
  title: 'Programme',
  sections: [{ title: 'New Section', columns: [{ nodes: [] }] }],
});

const flush = () => act(async () => Promise.resolve());

const widths = (container: HTMLElement) => ({
  column: container.querySelector<HTMLElement>('[data-column="0-0"]')!.style.width,
  bar: container
    .querySelector<HTMLElement>('[data-section-index="0"]')!
    .children[0].getAttribute('style'),
});

describe('empty column width', () => {
  it.each([true, false])('is 192px, a new node, with edit mode %s', async (editMode) => {
    const { container } = renderToC(makeData(), { showEditButton: editMode });
    await flush();
    expect(widths(container).column).toBe('192px');
    expect(widths(container).bar).toContain('min-width: 192px');
  });

  it('does not change when the first node is added to it', async () => {
    const { container } = renderToC(makeData());
    await flush();
    const before = widths(container);

    fireEvent.doubleClick(container.querySelector('[data-column="0-0"]')!);
    await flush();

    expect(container.querySelectorAll('[data-tocb-node]').length).toBe(1);
    expect(widths(container)).toEqual(before);
    const node = container.querySelector<HTMLElement>('[data-tocb-node]')!;
    expect(node.style.width).toBe('192px');
  });
});
