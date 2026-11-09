// Presentational contract of the drag landing indicator: a tinted gutter,
// pointer-transparent, never node-shaped, and nothing at all without an
// indicator.
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
        indicator={{ kind: 'gutter', left: 0, top: 0, width: 10, height: 10 }}
        zoomScale={1}
      />,
    );
    const el = find()!;
    expect(el.className).toContain('pointer-events-none');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});
