// The reply of Generate mode is model output, so what comes out of the parser
// must be a chart the app can load, or nothing: the chat then shows its parse
// error instead of loading something half-shaped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasGeneratedGraph, parseGeneratedGraph } from '../../src/utils/parseGeneratedGraph';

const wrap = (json: unknown) =>
  `Here you go.\n[GRAPH_JSON]\n${JSON.stringify(json)}\n[/GRAPH_JSON]`;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseGeneratedGraph', () => {
  it('returns the chart normalised: ids on every section and column, canonical connections', () => {
    const chart = parseGeneratedGraph(
      wrap({
        title: 'Generated',
        sections: [
          {
            title: 'Inputs',
            columns: [
              {
                nodes: [
                  { id: 'a', title: 'A', text: '', connectionIds: ['b'] },
                  { id: 'b', title: 'B', text: '', connectionIds: [] },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(chart?.sections[0].id).toBe('s0');
    expect(chart?.sections[0].columns[0].id).toBe('c0.0');
    expect(chart?.sections[0].columns[0].nodes[0].connections).toEqual([
      { targetId: 'b', confidence: 50 },
    ]);
  });

  it.each([
    ['no delimiters', 'just prose'],
    ['not JSON', '[GRAPH_JSON]{oops[/GRAPH_JSON]'],
    ['no sections array', wrap({ title: 'x' })],
    ['a section without columns', wrap({ sections: [{ title: 'S' }] })],
    ['a node that is not an object', wrap({ sections: [{ columns: [{ nodes: ['a'] }] }] })],
  ])('returns null for %s', (_label, content) => {
    expect(parseGeneratedGraph(content)).toBeNull();
  });

  it('knows whether a message holds a graph', () => {
    expect(hasGeneratedGraph(wrap({ sections: [] }))).toBe(true);
    expect(hasGeneratedGraph('no graph')).toBe(false);
  });
});
