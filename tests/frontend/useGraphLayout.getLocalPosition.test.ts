// Regression test for `getLocalPosition` — port of the inline impl
// previously in `ConnectionsComponent.tsx:698-713`. Walks the offsetParent
// chain to compute element position relative to a container, immune to
// CSS zoom/transforms (uses offsetLeft/offsetTop, not getBoundingClientRect).
import { describe, it, expect } from 'vitest';
import { getLocalPosition } from '../../src/hooks/useGraphLayout';

describe('getLocalPosition', () => {
  it('returns container-relative {x,y,width,height}', () => {
    const container = document.createElement('div');
    const middle = document.createElement('div');
    const inner = document.createElement('div');
    document.body.appendChild(container);
    container.appendChild(middle);
    middle.appendChild(inner);

    // jsdom doesn't run layout, so we stub offset* properties.
    // The function should sum offsets along the chain until it hits
    // the container.
    Object.defineProperty(middle, 'offsetLeft', { value: 10, configurable: true });
    Object.defineProperty(middle, 'offsetTop', { value: 20, configurable: true });
    Object.defineProperty(middle, 'offsetParent', { value: container, configurable: true });
    Object.defineProperty(inner, 'offsetLeft', { value: 5, configurable: true });
    Object.defineProperty(inner, 'offsetTop', { value: 7, configurable: true });
    Object.defineProperty(inner, 'offsetParent', { value: middle, configurable: true });
    Object.defineProperty(inner, 'offsetWidth', { value: 100, configurable: true });
    Object.defineProperty(inner, 'offsetHeight', { value: 50, configurable: true });

    const pos = getLocalPosition(inner, container);
    expect(pos).toEqual({ x: 15, y: 27, width: 100, height: 50 });

    document.body.removeChild(container);
  });

  it('returns offsetWidth/height even when offsetParent is null at the top', () => {
    const container = document.createElement('div');
    const inner = document.createElement('div');
    document.body.appendChild(container);
    container.appendChild(inner);

    // offsetParent === null after climbing past container should stop the walk.
    Object.defineProperty(inner, 'offsetLeft', { value: 11, configurable: true });
    Object.defineProperty(inner, 'offsetTop', { value: 13, configurable: true });
    Object.defineProperty(inner, 'offsetParent', { value: null, configurable: true });
    Object.defineProperty(inner, 'offsetWidth', { value: 100, configurable: true });
    Object.defineProperty(inner, 'offsetHeight', { value: 50, configurable: true });

    const pos = getLocalPosition(inner, container);
    // The element's own offsetLeft/Top are added; the chain ends at null.
    expect(pos.width).toBe(100);
    expect(pos.height).toBe(50);

    document.body.removeChild(container);
  });
});
