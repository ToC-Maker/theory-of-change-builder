// Unit tests for `src/utils/validateChartImport.ts` — deep shape
// validation for imported / programmatically supplied ToC JSON.
//
// The validator is used by `FileMenu.handleFileChosen` (before
// `onImportJson`) and by `App.tsx#handleUploadJSON` (defense in depth
// for non-FileMenu callers). It must:
//   - Accept a well-formed chart (with and without optional fields) and hand
//     it back normalised: ids on every section and column, canonical
//     connections.
//   - Reject any malformation along the sections → columns → nodes →
//     connections → waypoints chain, with a path-stamped reason.
//   - Tolerate optional fields being absent (no `connections`,
//     no `waypoints`, etc.).
import { describe, expect, it } from 'vitest';
import { validateChartImport } from '../../src/utils/validateChartImport';

describe('validateChartImport', () => {
  it('accepts the minimal well-formed shape', () => {
    const result = validateChartImport({
      sections: [{ title: 'A', columns: [{ nodes: [] }] }],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts nodes with optional connections + finite-numeric waypoint offsets', () => {
    const result = validateChartImport({
      sections: [
        {
          title: 'A',
          columns: [
            {
              nodes: [
                {
                  id: 'n1',
                  title: 'A',
                  text: 'a',
                  connectionIds: [],
                  connections: [
                    {
                      targetId: 'n2',
                      confidence: 80,
                      waypoints: [{ dx: 10, dy: 20 }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a file whose waypoints are in the old absolute {x, y} format, and passes them through', () => {
    // Old entries render as the automatic curve and are replaced by the
    // next drag; a file is not rejected just for carrying them.
    const chart = {
      sections: [
        {
          title: 'A',
          columns: [
            {
              nodes: [
                {
                  id: 'n1',
                  title: 'A',
                  text: 'a',
                  connectionIds: [],
                  connections: [{ targetId: 'n2', confidence: 80, waypoints: [{ x: 10, y: 20 }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = validateChartImport(chart);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.sections[0].columns[0].nodes[0].connections?.[0].waypoints).toEqual([
        { x: 10, y: 20 },
      ]);
    }
  });

  it('accepts a node whose connections is not an array and draws it from its connectionIds', () => {
    const result = validateChartImport({
      sections: [
        {
          columns: [
            {
              nodes: [
                { id: 'n1', connections: null, connectionIds: ['n2'] },
                { id: 'n2', connectionIds: [] },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.sections[0].columns[0].nodes[0].connections).toEqual([
        { targetId: 'n2', confidence: 50 },
      ]);
    }
  });

  it('accepts a node whose connections is a string, number or object, as normalizeChart does', () => {
    for (const connections of ['x', 5, {}]) {
      const result = validateChartImport({
        sections: [
          {
            columns: [
              {
                nodes: [
                  { id: 'n1', connections, connectionIds: ['n2'] },
                  { id: 'n2', connectionIds: [] },
                ],
              },
            ],
          },
        ],
      });
      expect(result.ok, JSON.stringify(connections)).toBe(true);
    }
  });

  it('returns the chart normalised, with ids and canonical connections', () => {
    const result = validateChartImport({
      title: 'T',
      sections: [
        {
          title: 'A',
          columns: [
            {
              nodes: [
                { id: 'n1', title: 'A', text: '', connectionIds: ['n2'] },
                { id: 'n2', title: 'B', text: '', connectionIds: [] },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sections[0].id).toBe('s0');
    expect(result.data.sections[0].columns[0].id).toBe('c0.0');
    expect(result.data.sections[0].columns[0].nodes[0].connections).toEqual([
      { targetId: 'n2', confidence: 50 },
    ]);
  });

  it('names a bad waypoint by its position in the file, not in the normalised chart', () => {
    // Normalising drops the second connection to n2, which would shift the index.
    const result = validateChartImport({
      sections: [
        {
          columns: [
            {
              nodes: [
                {
                  id: 'n1',
                  connections: [
                    { targetId: 'n2', confidence: 50 },
                    { targetId: 'n2', confidence: 60 },
                    { targetId: 'n3', confidence: 70, waypoints: [null] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        'sections[0].columns[0].nodes[0].connections[2].waypoints[0] is not an object',
      );
    }
  });

  it.each([
    { input: null, expectedReason: /top-level is not an object/ },
    { input: 'not an object', expectedReason: /top-level is not an object/ },
    { input: { wrongShape: true }, expectedReason: /sections is not an array/ },
    {
      input: { sections: [{ columns: 'not-an-array' }] },
      expectedReason: /sections\[0\]\.columns is not an array/,
    },
    {
      input: { sections: [{ columns: [{ nodes: null }] }] },
      expectedReason: /sections\[0\]\.columns\[0\]\.nodes is not an array/,
    },
    {
      input: {
        sections: [
          {
            columns: [
              {
                nodes: [
                  {
                    connections: [{ waypoints: [{ dx: 'oops', dy: 10 }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      expectedReason: /waypoints\[0\] has invalid offsets/,
    },
    {
      input: {
        sections: [
          {
            columns: [
              {
                nodes: [
                  {
                    connections: [{ waypoints: [{ dx: NaN, dy: 0 }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      expectedReason: /waypoints\[0\] has invalid offsets/,
    },
    {
      input: {
        sections: [
          {
            columns: [
              {
                nodes: [
                  {
                    connections: [{ waypoints: [{ x: NaN, y: 0 }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      expectedReason: /waypoints\[0\] has invalid offsets/,
    },
    {
      input: {
        sections: [
          {
            columns: [
              {
                nodes: [
                  {
                    connections: [{ waypoints: [{ dx: 4 }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      expectedReason: /waypoints\[0\] has invalid offsets/,
    },
    {
      input: {
        sections: [
          {
            columns: [
              {
                nodes: [
                  {
                    connections: [{ waypoints: [{ dx: Infinity, dy: 1 }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      expectedReason: /waypoints\[0\] has invalid offsets/,
    },
    {
      input: {
        sections: [
          {
            columns: [
              {
                nodes: [
                  {
                    connections: [{ waypoints: [null] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      expectedReason: /waypoints\[0\] is not an object/,
    },
  ])(
    'rejects malformed input with a path-stamped reason ($expectedReason)',
    ({ input, expectedReason }) => {
      const result = validateChartImport(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(expectedReason);
      }
    },
  );
});
