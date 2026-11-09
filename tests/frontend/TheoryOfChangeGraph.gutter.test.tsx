// Add controls for columns and sections.
//
// In edit mode every place a column or section can be added has an
// overlay zone: the outer edges of the chart, the gap between sections
// (three controls) and the gap between columns (one control). The zones
// are laid over the existing gaps, so they take no layout space. At rest
// a zone shows a faint cue; the controls appear when the pointer rests on
// the zone or the cue is tapped, and clicking one adds exactly one column
// or section through the standard mutation path. View mode has none of
// them.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import { MOVE_THRESHOLD_PX } from '../../src/hooks/usePointerDrag';
import {
  HOVER_GRACE_MS,
  HOVER_INTENT_MS,
  MOUSE_TARGET_PX,
  TOUCH_OPEN_MS,
  TOUCH_TARGET_PX,
} from '../../src/components/canvas/AddControlZone';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

// A fresh object per call, so no test sees another test's data.
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
              connections: [],
              yPosition: 100,
            },
          ],
        },
        { nodes: [] },
      ],
    },
    {
      title: 'Outputs',
      columns: [{ nodes: [] }],
    },
  ],
});

const testIdsIn = (zoneTestId: string) =>
  [...document.querySelectorAll(`[data-testid="${zoneTestId}"] [data-testid]`)].map((el) =>
    el.getAttribute('data-testid'),
  );

function lastData(onDataChange: ReturnType<typeof vi.fn>): ToCData {
  return onDataChange.mock.calls[onDataChange.mock.calls.length - 1][0] as ToCData;
}

describe('add controls', () => {
  it('lays one zone at each outer edge, one in each section gap and one in each column gap', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zones = [...document.querySelectorAll('[data-testid^="add-zone-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(zones.sort()).toEqual([
      'add-zone-column-gap-0-0',
      'add-zone-edge-end',
      'add-zone-edge-start',
      'add-zone-section-gap-0',
    ]);
  });

  it('puts three controls in a section gap, in left-to-right order of what they add', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    expect(testIdsIn('add-zone-section-gap-0')).toEqual([
      'add-column-after-0-1',
      'add-section-before',
      'add-column-before-1-0',
    ]);
  });

  it('offers section and first-column adds at the start edge, last-column and section adds at the end edge', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    expect(testIdsIn('add-zone-edge-start')).toEqual([
      'add-section-before',
      'add-column-before-0-0',
    ]);
    expect(testIdsIn('add-zone-edge-end')).toEqual([
      'add-column-after-1-0',
      'add-section-after-last',
    ]);
  });

  it('puts a single column control in the gap between two columns', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    expect(testIdsIn('add-zone-column-gap-0-0')).toEqual(['add-column-after-0-0']);
  });

  it('renders no controls in view-only mode', () => {
    render(<ToC data={makeBaseData()} showEditButton={false} />);
    expect(document.querySelector('[data-testid^="add-"]')).toBeNull();
    expect(document.querySelector('[data-add-cue], [data-add-badge]')).toBeNull();
  });

  it('sizes each zone to the gap it covers and attaches it to the side facing that gap', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zone = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.style;

    // Outer edges lie in the canvas card's padding (16px), the gap between
    // sections is sectionPadding (32px), the gap between columns is
    // columnPadding (24px).
    expect(zone('add-zone-edge-start')).toMatchObject({ width: '16px', right: '100%' });
    expect(zone('add-zone-edge-end')).toMatchObject({ width: '16px', left: '100%' });
    expect(zone('add-zone-section-gap-0')).toMatchObject({ width: '32px', left: '100%' });
    expect(zone('add-zone-column-gap-0-0')).toMatchObject({ width: '24px', left: '100%' });
  });

  it('marks every zone for exclusion from exports', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zones = document.querySelectorAll('[data-testid^="add-zone-"]');
    expect(zones.length).toBeGreaterThan(0);
    zones.forEach((zone) => expect(zone.hasAttribute('data-export-exclude')).toBe(true));
  });

  it('shows a faint cue in every zone at rest, with the controls hidden', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zones = document.querySelectorAll('[data-testid^="add-zone-"]');
    expect(zones.length).toBe(4);
    zones.forEach((zone) => {
      expect(zone.querySelector('[data-add-cue]')).not.toBeNull();
      expect(zone.querySelector('[data-add-badge]')).not.toBeNull();
      expect(zone.querySelector('[data-revealed]')!.getAttribute('data-revealed')).toBe('false');
    });
  });

  describe('revealing the controls', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const advance = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    const zoneOf = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
    const revealed = (zone: HTMLElement) =>
      zone.querySelector('[data-revealed]')!.getAttribute('data-revealed') === 'true';
    const GAP = 'add-zone-column-gap-0-0';
    const mouse = { pointerType: 'mouse', clientY: 200 };
    const touch = { pointerType: 'touch', clientY: 200 };

    it('shows the controls only after the pointer has rested on the zone, and hides them after a grace period', () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const zone = zoneOf(GAP);

      fireEvent.pointerEnter(zone, mouse);
      advance(HOVER_INTENT_MS - 1);
      expect(revealed(zone)).toBe(false);
      advance(1);
      expect(revealed(zone)).toBe(true);

      fireEvent.pointerLeave(zone, mouse);
      advance(HOVER_GRACE_MS - 1);
      expect(revealed(zone)).toBe(true);
      advance(1);
      expect(revealed(zone)).toBe(false);
    });

    it('shows nothing when the pointer sweeps through the zone', () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const zone = zoneOf(GAP);

      fireEvent.pointerEnter(zone, mouse);
      advance(HOVER_INTENT_MS - 20);
      fireEvent.pointerLeave(zone, mouse);
      advance(2 * HOVER_INTENT_MS);

      expect(revealed(zone)).toBe(false);
    });

    it('keeps the controls when the pointer leaves and comes back within the grace period', () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const zone = zoneOf(GAP);
      fireEvent.pointerEnter(zone, mouse);
      advance(HOVER_INTENT_MS);

      fireEvent.pointerLeave(zone, mouse);
      advance(HOVER_GRACE_MS - 50);
      fireEvent.pointerEnter(zone, mouse);
      advance(2 * HOVER_GRACE_MS);

      expect(revealed(zone)).toBe(true);
    });

    it('does not reveal controls while a mouse button is held (a drag is under way)', () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const zone = zoneOf(GAP);
      fireEvent.pointerEnter(zone, { ...mouse, buttons: 1 });
      advance(2 * HOVER_INTENT_MS);
      expect(revealed(zone)).toBe(false);
    });

    it('reveals after a drag that ends inside the zone once the pointer moves again', () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const zone = zoneOf(GAP);
      fireEvent.pointerEnter(zone, { ...mouse, buttons: 1 });
      advance(2 * HOVER_INTENT_MS);

      fireEvent.pointerMove(zone, mouse);
      advance(HOVER_INTENT_MS);

      expect(revealed(zone)).toBe(true);
    });

    it('opens at once on a click on the cue', () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const zone = zoneOf(GAP);
      fireEvent.click(zone.querySelector('[data-add-badge]')!, { clientY: 200 });
      expect(revealed(zone)).toBe(true);
    });

    describe('placement', () => {
      const rect = (left: number, top: number, width: number, height: number) =>
        ({
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
          x: left,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;

      // jsdom has no layout: give the zone, the section's columns and the
      // node next to the gap the rectangles a browser would.
      const layOut = (nodeTop: number, nodeHeight: number) =>
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
          this: Element,
        ) {
          if (this.matches('[data-testid="add-zone-section-gap-0"]')) return rect(100, 0, 32, 600);
          if (this.matches('[data-column]')) return rect(0, 60, 100, 540);
          if (this.matches('[data-tocb-node]')) return rect(60, nodeTop, 80, nodeHeight);
          return rect(0, 0, 0, 0);
        });

      const openAt = (clientY: number) => {
        render(<ToC data={makeBaseData()} showEditButton={true} />);
        const zone = zoneOf('add-zone-section-gap-0');
        fireEvent.pointerEnter(zone, { pointerType: 'mouse', clientY });
        advance(HOVER_INTENT_MS);
        return zone.querySelector<HTMLElement>('[data-revealed]')!;
      };

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('centres the controls on the pointer when nothing is in the way', () => {
        layOut(400, 80);
        const stack = openAt(150);
        // 81px tall: top = pointer 150 - 81 / 2.
        expect(stack.style.top).toBe('109.5px');
        expect(stack.className).toContain('z-[5]');
      });

      it('moves the controls clear of a node beside the gap', () => {
        layOut(200, 80);
        const stack = openAt(240);
        // The node and its handles' reach (12px) span 188-292: the nearest
        // free spot above it ends at 188.
        expect(stack.style.top).toBe('103.5px');
        expect(stack.className).toContain('z-[5]');
      });

      it('lifts the controls above nodes when no spot is clear, so none is hidden behind one', () => {
        layOut(0, 600);
        const stack = openAt(240);
        expect(stack.style.top).toBe('199.5px');
        expect(stack.className).toContain('z-30');
      });

      it('does not place the controls again when a click opens them inside the hover-intent window', () => {
        layOut(400, 80);
        render(<ToC data={makeBaseData()} showEditButton={true} />);
        const zone = zoneOf('add-zone-section-gap-0');
        fireEvent.pointerEnter(zone, { pointerType: 'mouse', clientY: 100 });
        advance(HOVER_INTENT_MS / 2);

        fireEvent.click(zone.querySelector('[data-add-badge]')!, { clientY: 300 });
        const stack = zone.querySelector<HTMLElement>('[data-revealed]')!;
        // Centred on the click: 300 - 81 / 2.
        expect(stack.style.top).toBe('259.5px');

        // The timer armed by the pointer entering must not fire a second
        // placement at the pointer's earlier position.
        advance(HOVER_INTENT_MS);
        expect(stack.style.top).toBe('259.5px');
      });

      it('keeps the controls within the columns, below the section title bar', () => {
        layOut(400, 80);
        const stack = openAt(10);
        expect(stack.style.top).toBe('60px');
      });

      describe('following the pointer', () => {
        const FRAME_MS = 16;
        const move = (el: Element, clientY: number, init: Record<string, unknown> = {}) => {
          fireEvent.pointerMove(el, { pointerType: 'mouse', clientY, ...init });
          advance(FRAME_MS);
        };
        const zoneRects = (spy: ReturnType<typeof layOut>) =>
          spy.mock.contexts.filter((el) =>
            (el as Element).matches('[data-testid="add-zone-section-gap-0"]'),
          ).length;

        it('moves the controls to the pointer as it travels along the zone, within the columns', () => {
          layOut(400, 80);
          const stack = openAt(150);
          const zone = zoneOf('add-zone-section-gap-0');
          expect(stack.style.top).toBe('109.5px');

          move(zone, 300);
          expect(stack.style.top).toBe('259.5px');
          // Clamped to the columns: no higher than the first column's top,
          // no lower than the zone's bottom less the controls' length.
          move(zone, 10);
          expect(stack.style.top).toBe('60px');
          move(zone, 590);
          expect(stack.style.top).toBe('519px');
        });

        it('avoids nodes while following', () => {
          layOut(200, 80);
          const stack = openAt(240);
          const zone = zoneOf('add-zone-section-gap-0');
          // The node and its handles' reach span 188-292: the nearest free
          // spot above it ends at 188; below it, the first 8px step past 292 is 295.5.
          expect(stack.style.top).toBe('103.5px');
          move(zone, 320);
          expect(stack.style.top).toBe('295.5px');
          move(zone, 500);
          expect(stack.style.top).toBe('459.5px');
        });

        it('stays put while the pointer is over the controls, so every one of them can be reached', () => {
          layOut(400, 80);
          const stack = openAt(150);
          const zone = zoneOf('add-zone-section-gap-0');
          const first = stack.querySelector('[data-testid="add-column-after-0-1"]')!;
          const last = stack.querySelector('[data-testid="add-column-before-1-0"]')!;

          move(first, 300);
          move(last, 450);
          move(stack, 200);
          expect(stack.style.top).toBe('109.5px');

          // Back on the strip, it follows again.
          move(zone, 300);
          expect(stack.style.top).toBe('259.5px');
        });

        it('follows over the resting badge as well, which stays under the pointer while the controls are open', () => {
          layOut(400, 80);
          const stack = openAt(150);
          const zone = zoneOf('add-zone-section-gap-0');
          move(zone.querySelector('[data-add-badge]')!, 330);
          expect(stack.style.top).toBe('289.5px');
        });

        it('does not follow while a mouse button is held (a pan is under way)', () => {
          layOut(400, 80);
          const stack = openAt(150);
          move(zoneOf('add-zone-section-gap-0'), 300, { buttons: 1 });
          expect(stack.style.top).toBe('109.5px');
        });

        it('places at most once per animation frame, at the latest pointer position', () => {
          const spy = layOut(400, 80);
          const stack = openAt(150);
          const zone = zoneOf('add-zone-section-gap-0');

          const before = zoneRects(spy);
          for (const y of [200, 220, 240, 260, 280]) {
            fireEvent.pointerMove(zone, { pointerType: 'mouse', clientY: y });
          }
          expect(stack.style.top).toBe('109.5px');
          advance(FRAME_MS);

          expect(stack.style.top).toBe('239.5px');
          expect(zoneRects(spy) - before).toBe(1);
        });

        it('does nothing once the pointer has left and the controls are closing', () => {
          layOut(400, 80);
          const stack = openAt(150);
          const zone = zoneOf('add-zone-section-gap-0');

          fireEvent.pointerMove(zone, { pointerType: 'mouse', clientY: 300 });
          fireEvent.pointerLeave(zone, { pointerType: 'mouse', clientY: 300 });
          advance(FRAME_MS);

          expect(stack.style.top).toBe('109.5px');
        });

        it('does not follow when a tap opened the controls', () => {
          layOut(400, 80);
          render(<ToC data={makeBaseData()} showEditButton={true} />);
          const zone = zoneOf('add-zone-section-gap-0');
          fireEvent.pointerDown(zone, touch);
          fireEvent.click(zone, { ...touch, clientY: 150 });
          const stack = zone.querySelector<HTMLElement>('[data-revealed]')!;
          // Touch-sized: 44px wide, 14px font, 92px long, centred on the tap.
          expect(stack.style.top).toBe('104px');

          move(zone, 300, { pointerType: 'touch' });
          move(zone, 400);
          expect(stack.style.top).toBe('104px');
        });
      });
    });

    describe('sizes', () => {
      const sizesAt = (zoomScale: number, pointer: Record<string, unknown>) => {
        render(<ToC data={makeBaseData()} showEditButton={true} zoomScale={zoomScale} />);
        const zone = zoneOf('add-zone-section-gap-0');
        fireEvent.pointerDown(zone, pointer);
        fireEvent.click(zone.querySelector('[data-add-badge]')!, pointer);
        const stack = zone.querySelector<HTMLElement>('[data-revealed]')!;
        const control = stack.querySelector<HTMLElement>('[role="button"]')!;
        return { stack, control };
      };

      it('are at least the mouse size on screen at any zoom: content size is the screen size divided by the zoom', () => {
        for (const zoom of [0.25, 1, 2]) {
          const { stack, control } = sizesAt(zoom, mouse);
          expect(stack.style.transform).toContain(`scale(${1 / zoom})`);
          expect(control.style.width).toBe(`${MOUSE_TARGET_PX}px`);
          expect(control.style.fontSize).toBe('12px');
          cleanup();
        }
      });

      it('are the touch size when opened by touch', () => {
        const { control } = sizesAt(0.25, touch);
        expect(control.style.width).toBe(`${TOUCH_TARGET_PX}px`);
        expect(parseFloat(control.style.height)).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
        expect(control.style.fontSize).toBe('14px');
      });

      it('grow inward from the card edge at the outer edges and centre on the gap elsewhere', () => {
        render(<ToC data={makeBaseData()} showEditButton={true} />);
        const stackStyle = (testId: string) =>
          zoneOf(testId).querySelector<HTMLElement>('[data-revealed]')!.style;
        expect(stackStyle('add-zone-edge-start')).toMatchObject({ left: '0px' });
        expect(stackStyle('add-zone-edge-end')).toMatchObject({ right: '0px' });
        expect(stackStyle('add-zone-section-gap-0')).toMatchObject({ left: '50%' });
      });
    });

    describe('by touch', () => {
      const ZONE = 'add-zone-section-gap-0';
      const sectionCount = () => document.querySelectorAll('[data-section-index]').length;
      const tap = (el: Element) => {
        fireEvent.pointerDown(el, touch);
        fireEvent.click(el, touch);
      };

      it('needs a second tap on a control: the first tap on the gap only opens them', async () => {
        render(<ToC data={makeBaseData()} showEditButton={true} />);
        const zone = zoneOf(ZONE);
        const before = sectionCount();

        tap(zone.querySelector('[data-add-badge]')!);
        await act(async () => Promise.resolve());
        expect(revealed(zone)).toBe(true);
        expect(sectionCount()).toBe(before);

        tap(zone.querySelector('[data-testid="add-section-before"]')!);
        await act(async () => Promise.resolve());
        expect(sectionCount()).toBe(before + 1);
      });

      it('opens on a tap on the bare gap too, and adds nothing', async () => {
        render(<ToC data={makeBaseData()} showEditButton={true} />);
        const zone = zoneOf(ZONE);
        const before = sectionCount();
        tap(zone);
        await act(async () => Promise.resolve());
        expect(revealed(zone)).toBe(true);
        expect(sectionCount()).toBe(before);
      });

      it('closes after a tap elsewhere', () => {
        render(<ToC data={makeBaseData()} showEditButton={true} />);
        const zone = zoneOf(ZONE);
        tap(zone);
        expect(revealed(zone)).toBe(true);

        fireEvent.pointerDown(document.body, touch);

        expect(revealed(zone)).toBe(false);
      });

      it('closes on its own when no second tap follows', () => {
        render(<ToC data={makeBaseData()} showEditButton={true} />);
        const zone = zoneOf(ZONE);
        tap(zone);
        advance(TOUCH_OPEN_MS - 1);
        expect(revealed(zone)).toBe(true);
        advance(1);
        expect(revealed(zone)).toBe(false);
      });

      it('ignores the pointer-enter that a touch produces, so a swipe across the chart opens nothing', () => {
        render(<ToC data={makeBaseData()} showEditButton={true} />);
        const zone = zoneOf(ZONE);
        fireEvent.pointerEnter(zone, touch);
        advance(2 * HOVER_INTENT_MS);
        expect(revealed(zone)).toBe(false);
      });
    });
  });

  it('a section-gap click on "+ Section" adds one section between the two neighbours', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    const gapZone = document.querySelector('[data-testid="add-zone-section-gap-0"]')!;
    fireEvent.click(gapZone.querySelector('[data-testid="add-section-before"]')!);

    return Promise.resolve().then(() => {
      const sections = lastData(onDataChange).sections;
      expect(sections.map((section) => section.title)).toEqual([
        'Inputs',
        'New Section',
        'Outputs',
      ]);
    });
  });

  it('the first "+ Section" at the start edge adds one section before the first', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(
      document.querySelector(
        '[data-testid="add-zone-edge-start"] [data-testid="add-section-before"]',
      )!,
    );

    return Promise.resolve().then(() => {
      const sections = lastData(onDataChange).sections;
      expect(sections.map((section) => section.title)).toEqual([
        'New Section',
        'Inputs',
        'Outputs',
      ]);
    });
  });

  it('"+ Section" at the end edge adds one section after the last', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-section-after-last"]')!);

    return Promise.resolve().then(() => {
      const sections = lastData(onDataChange).sections;
      expect(sections.map((section) => section.title)).toEqual([
        'Inputs',
        'Outputs',
        'New Section',
      ]);
    });
  });

  it('"+ Column" before the first column of a section adds one column at index 0', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-before-0-0"]')!);

    return Promise.resolve().then(() => {
      const columns = lastData(onDataChange).sections[0].columns;
      expect(columns.map((column) => column.nodes.length)).toEqual([0, 1, 0]);
    });
  });

  it('"+ Column" in a section gap adds one column to the start of the section on its right', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-before-1-0"]')!);

    return Promise.resolve().then(() => {
      const data = lastData(onDataChange);
      expect(data.sections[0].columns.length).toBe(2);
      expect(data.sections[1].columns.length).toBe(2);
    });
  });

  it('"+ Column" in a section gap adds one column to the end of the section on its left', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-after-0-1"]')!);

    return Promise.resolve().then(() => {
      const columns = lastData(onDataChange).sections[0].columns;
      expect(columns.map((column) => column.nodes.length)).toEqual([1, 0, 0]);
    });
  });

  it('"+ Column" between two columns adds one column right after the left one', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-after-0-0"]')!);

    return Promise.resolve().then(() => {
      const columns = lastData(onDataChange).sections[0].columns;
      expect(columns.map((column) => column.nodes.length)).toEqual([1, 0, 0]);
    });
  });

  it('a section with no columns can still get its first column', () => {
    const onDataChange = vi.fn();
    const data = makeBaseData();
    data.sections[1].columns = [];
    render(<ToC data={data} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-before-1-0"]')!);

    return Promise.resolve().then(() => {
      expect(lastData(onDataChange).sections[1].columns.length).toBe(1);
    });
  });

  describe('press-and-drag on a control', () => {
    const columnCount = () => document.querySelectorAll('[data-column]').length;
    const flush = () => act(async () => Promise.resolve());

    it('a press that travels past the click threshold adds nothing on release', async () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const control = document.querySelector('[data-testid="add-column-after-0-0"]')!;
      const before = columnCount();

      // The canvas pans with the content following the cursor, so the
      // control is still under the pointer when it is released and the
      // browser reports a click.
      fireEvent.pointerDown(control, { clientX: 100, clientY: 100 });
      fireEvent.click(control, { clientX: 100 + MOVE_THRESHOLD_PX + 1, clientY: 100 });
      await flush();

      expect(columnCount()).toBe(before);
    });

    it('a press that stays within the click threshold adds exactly one column', async () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const control = document.querySelector('[data-testid="add-column-after-0-0"]')!;
      const before = columnCount();

      fireEvent.pointerDown(control, { clientX: 100, clientY: 100 });
      fireEvent.click(control, { clientX: 100 + MOVE_THRESHOLD_PX, clientY: 100 });
      await flush();

      expect(columnCount()).toBe(before + 1);
    });

    it('a drag leaves no trace: the next plain click still adds one', async () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const control = document.querySelector('[data-testid="add-column-after-0-0"]')!;
      const before = columnCount();

      fireEvent.pointerDown(control, { clientX: 100, clientY: 100 });
      fireEvent.click(control, { clientX: 300, clientY: 100 });
      fireEvent.click(control, { clientX: 300, clientY: 100 });
      await flush();

      expect(columnCount()).toBe(before + 1);
    });

    it('controls are not <button>s, because a press on a button never starts a canvas pan', () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const controls = document.querySelectorAll(
        '[data-testid^="add-column-"], [data-testid^="add-section-"]',
      );
      expect(controls.length).toBeGreaterThan(0);
      controls.forEach((control) => expect(control.closest('button')).toBeNull());
    });
  });

  // The add zones must not spill outside the canvas card, and column bodies
  // (the double-click-to-add-node area) must end where the card content does.
  describe('stay inside the canvas bounds', () => {
    it('graph container has no inline height in edit mode (content-driven)', async () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      // updateSize fires in an effect; wait a microtask for the state flush.
      await Promise.resolve();
      const container = document.querySelector('div.min-w-fit') as HTMLElement;
      expect(container).not.toBeNull();
      expect(container.style.height).toBe('');
    });

    it('graph container keeps its explicit height in view mode', () => {
      render(<ToC data={makeBaseData()} showEditButton={false} />);
      const container = document.querySelector('div.min-w-fit') as HTMLElement;
      expect(container).not.toBeNull();
      expect(container.style.height).not.toBe('');
    });

    it('column bodies budget the chart title block only when it takes space', async () => {
      // With a title: 800px minimum canvas - 62px section header - 80px
      // title block. Without one the block is an overlay and is not in the
      // layout, so the body is 80px taller.
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      await Promise.resolve();
      expect((document.querySelector('[data-column="0-0"]') as HTMLElement).style.height).toBe(
        '658px',
      );
      cleanup();
      render(<ToC data={{ ...makeBaseData(), title: '' }} showEditButton={true} />);
      await Promise.resolve();
      expect((document.querySelector('[data-column="0-0"]') as HTMLElement).style.height).toBe(
        '738px',
      );
    });
  });

  it('empty column body in edit mode shows the cursor-cell affordance class', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    // Section 1, column 0 is empty → its column div should carry
    // `cursor-cell` via the conditional class.
    const emptyCol = document.querySelector('[data-column="1-0"]') as HTMLElement | null;
    expect(emptyCol).not.toBeNull();
    expect(emptyCol!.className).toContain('cursor-cell');
  });

  it('non-empty column body does NOT carry cursor-cell (only empties do)', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const nonEmptyCol = document.querySelector('[data-column="0-0"]') as HTMLElement | null;
    expect(nonEmptyCol).not.toBeNull();
    expect(nonEmptyCol!.className).not.toContain('cursor-cell');
  });
});
