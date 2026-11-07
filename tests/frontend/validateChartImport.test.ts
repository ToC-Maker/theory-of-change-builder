// Unit tests for `src/utils/validateChartImport.ts` — deep shape
// validation for imported / programmatically supplied ToC JSON.
//
// The validator is used by `FileMenu.handleFileChosen` (before
// `onImportJson`) and by `App.tsx#handleUploadJSON` (defense in depth
// for non-FileMenu callers). It must:
//   - Accept a well-formed ToCData (with and without optional fields).
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
    if (result.ok) expect(result.data).toBe(chart);
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
                    connections: 'not-an-array',
                  },
                ],
              },
            ],
          },
        ],
      },
      expectedReason: /connections is not an array/,
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
