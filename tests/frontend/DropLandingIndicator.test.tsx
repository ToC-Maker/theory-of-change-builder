// Presentational contract of the drag landing indicator: a thin line or a
// tinted gutter, pointer-transparent, never node-shaped, and nothing at all
// without an indicator.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DropLandingIndicator } from '../../src/components/canvas/DropLandingIndicator';

afterEach(() => {
  cleanup();
});

const find = () => document.querySelector<HTMLElement>('[data-testid="drop-landing-indicator"]');

describe('DropLandingIndicator', () => {
  it('renders nothing without an indicator', () => {
    render(<DropLandingIndicator indicator={null} zoomScale={1} />);
    expect(find()).toBeNull();
  });

  it('draws the line centred on the given top edge, spanning the column', () => {
    render(
      <DropLandingIndicator
        indicator={{ kind: 'line', left: 50, top: 370, width: 200 }}
        zoomScale={1}
      />,
    );
    const el = find()!;
    expect(el.dataset.kind).toBe('line');
    expect(el.style.left).toBe('50px');
    expect(el.style.width).toBe('200px');
    // 3px thick, centred on the edge: 370 - 1.5.
    expect(el.style.height).toBe('3px');
    expect(el.style.top).toBe('368.5px');
  });

  it('keeps the line 3 screen px thick at any zoom', () => {
    render(
      <DropLandingIndicator
        indicator={{ kind: 'line', left: 0, top: 100, width: 10 }}
        zoomScale={0.5}
      />,
    );
    expect(find()!.style.height).toBe('6px');
  });

  it('draws the gutter as a tinted strip with a centred line', () => {
    render(
      <DropLandingIndicator
        indicator={{ kind: 'gutter', left: 250, top: 100, width: 24, height: 800 }}
        zoomScale={1}
      />,
    );
    const el = find()!;
    expect(el.dataset.kind).toBe('gutter');
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual([
      '250px',
      '100px',
      '24px',
      '800px',
    ]);
    expect(el.firstElementChild).not.toBeNull();
  });

  it('never intercepts the pointer and is hidden from assistive tech', () => {
    render(
      <DropLandingIndicator
        indicator={{ kind: 'line', left: 0, top: 0, width: 10 }}
        zoomScale={1}
      />,
    );
    const el = find()!;
    expect(el.className).toContain('pointer-events-none');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});
