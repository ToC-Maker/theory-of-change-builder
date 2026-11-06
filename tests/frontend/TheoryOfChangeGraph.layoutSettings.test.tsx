// Undo restores the chart data, including a layout setting that was not
// set yet. The graph must then render that setting's default again
// instead of keeping the value it showed before the undo.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

const sections: ToCData['sections'] = [
  {
    title: 'S1',
    columns: [{ nodes: [] }],
  },
  {
    title: 'S2',
    columns: [{ nodes: [] }],
  },
];

const configured: ToCData = {
  title: 'Settings fixture',
  sections,
  columnPadding: 48,
  sectionPadding: 64,
  textSize: 1.5,
  fontFamily: "'Roboto', sans-serif",
};

const unset: ToCData = { title: 'Settings fixture', sections };

const width = (testId: string) =>
  (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement).style.width;
const title = () => document.querySelector('h1') as HTMLElement;

describe('layout settings follow the data prop, including when a setting is unset', () => {
  it('renders the configured values', () => {
    render(<ToC data={configured} showEditButton={true} />);
    expect(width('add-column-after-0-0')).toBe('48px');
    expect(width('add-section-after-last')).toBe('64px');
    expect(title().style.fontSize).toBe('3.375rem');
    expect(title().style.fontFamily).toContain('Roboto');
  });

  it('renders the defaults when the settings are not set', () => {
    render(<ToC data={unset} showEditButton={true} />);
    expect(width('add-column-after-0-0')).toBe('24px');
    expect(width('add-section-after-last')).toBe('32px');
    expect(title().style.fontSize).toBe('2.25rem');
    expect(title().style.fontFamily).toContain('Ubuntu');
  });

  it('returns to the defaults when the data changes from configured to unset', () => {
    const { rerender } = render(<ToC data={configured} showEditButton={true} />);
    rerender(<ToC data={unset} showEditButton={true} />);
    expect(width('add-column-after-0-0')).toBe('24px');
    expect(width('add-section-after-last')).toBe('32px');
    expect(title().style.fontSize).toBe('2.25rem');
    expect(title().style.fontFamily).toContain('Ubuntu');
  });
});
