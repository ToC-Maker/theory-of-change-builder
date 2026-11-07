import { describe, expect, it } from 'vitest';
import {
  ChartShapeError,
  deepEqual,
  idOf,
  newColumnId,
  newNodeId,
  newSectionId,
  normalizeChart,
  type ToCData,
} from '../../shared/chart-model';

type Raw = Record<string, unknown>;

const withId = (id?: string): Raw => (id === undefined ? {} : { id });
const node = (id?: string, extra: Raw = {}): Raw => ({
  ...withId(id),
  title: '',
  text: '',
  connectionIds: [],
  ...extra,
});
const column = (nodes: Raw[], id?: string): Raw => ({ ...withId(id), nodes });
const section = (columns: Raw[], id?: string): Raw => ({ ...withId(id), title: 't', columns });

const sectionIds = (c: ToCData) => c.sections.map((s) => s.id);
const columnIds = (c: ToCData) => c.sections.flatMap((s) => s.columns.map((col) => col.id));
const nodeIds = (c: ToCData) =>
  c.sections.flatMap((s) => s.columns.flatMap((col) => col.nodes.map((n) => n.id)));
const firstNode = (c: ToCData) => c.sections[0].columns[0].nodes[0];

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

describe('normalizeChart ids', () => {
  it('assigns_positional_ids_to_idless_containers', () => {
    const out = normalizeChart({
      sections: [section([column([]), column([])]), section([column([])])],
    });
    expect(sectionIds(out)).toEqual(['s0', 's1']);
    expect(columnIds(out)).toEqual(['c0.0', 'c0.1', 'c1.0']);
  });

  it('normalize_is_deterministic_across_reads', () => {
    const raw = JSON.stringify({
      sections: [section([column([node(), node('a')]), column([])]), section([column([node()])])],
    });
    expect(deepEqual(normalizeChart(JSON.parse(raw)), normalizeChart(JSON.parse(raw)))).toBe(true);
  });

  it('suffixes_a_positional_id_already_taken', () => {
    const sections = normalizeChart({
      sections: [section([], 's1'), section([]), section([])],
    });
    expect(sectionIds(sections)).toEqual(['s1', 's1~2', 's2']);

    const columns = normalizeChart({
      sections: [section([column([], 'c0.1'), column([]), column([])])],
    });
    expect(columnIds(columns)).toEqual(['c0.1', 'c0.1~2', 'c0.2']);
  });

  it('stored_ids_are_never_renamed', () => {
    // The id-less section at index 0 would take the positional id `s0`, which
    // the stored id of the section after it already holds, so it is suffixed.
    const sections = normalizeChart({ sections: [section([]), section([], 's0')] });
    expect(sectionIds(sections)).toEqual(['s0~2', 's0']);

    const columns = normalizeChart({
      sections: [section([column([]), column([], 'c0.0')])],
    });
    expect(columnIds(columns)).toEqual(['c0.0~2', 'c0.0']);
  });

  it('dedupes_and_fills_node_ids', () => {
    const out = normalizeChart({
      sections: [section([column([node('a'), node('a'), node()])])],
    });
    expect(nodeIds(out)).toEqual(['a', 'a~2', 'n0.0.2']);
  });

  it('duplicate_node_id_skips_a_stored_suffixed_id', () => {
    const out = normalizeChart({
      sections: [section([column([node('a'), node('a'), node('a~2')])])],
    });
    expect(nodeIds(out)).toEqual(['a', 'a~3', 'a~2']);
  });

  it('node_ids_are_unique_across_the_whole_chart', () => {
    const out = normalizeChart({
      sections: [section([column([node('a')])]), section([column([node('a')])])],
    });
    expect(nodeIds(out)).toEqual(['a', 'a~2']);
  });

  it('duplicate_section_and_column_ids_stay_unique_and_the_first_keeps_its_id', () => {
    const out = normalizeChart({
      sections: [section([column([], 'x'), column([], 'x')], 'x'), section([column([], 'x')], 'x')],
    });
    expect(sectionIds(out)[0]).toBe('x');
    expect(new Set(sectionIds(out)).size).toBe(2);
    expect(columnIds(out)[0]).toBe('x');
    expect(new Set(columnIds(out)).size).toBe(3);
  });
});

describe('normalizeChart connections', () => {
  const nodeOf = (n: Raw) => firstNode(normalizeChart({ sections: [section([column([n])])] }));

  it('builds_connections_from_legacy_connectionIds', () => {
    const out = nodeOf(node('a', { connectionIds: ['b'] }));
    expect(out.connections).toEqual([{ targetId: 'b', confidence: 50 }]);
    expect(out.connectionIds).toEqual(['b']);
  });

  it('keeps_first_of_duplicate_targets', () => {
    const out = nodeOf(
      node('a', {
        connections: [
          { targetId: 'b', confidence: 80, evidence: 'e', waypoints: [{ dx: 1, dy: 2 }] },
          { targetId: 'b', confidence: 20 },
          { targetId: 'c', confidence: 30 },
        ],
      }),
    );
    expect(out.connections).toEqual([
      { targetId: 'b', confidence: 80, evidence: 'e', waypoints: [{ dx: 1, dy: 2 }] },
      { targetId: 'c', confidence: 30 },
    ]);
    expect(out.connectionIds).toEqual(['b', 'c']);
  });

  it('collapses_duplicate_legacy_connectionIds', () => {
    const out = nodeOf(node('a', { connectionIds: ['b', 'b'] }));
    expect(out.connections).toEqual([{ targetId: 'b', confidence: 50 }]);
    expect(out.connectionIds).toEqual(['b']);
  });

  it('connections_take_precedence_over_a_stale_connectionIds', () => {
    // The renderer draws `connections` whenever it is an array, even empty.
    const stale = nodeOf(
      node('a', { connectionIds: ['x'], connections: [{ targetId: 'b', confidence: 70 }] }),
    );
    expect(stale.connectionIds).toEqual(['b']);
    expect(stale.connections).toEqual([{ targetId: 'b', confidence: 70 }]);

    const empty = nodeOf(node('a', { connectionIds: ['x'], connections: [] }));
    expect(empty.connections).toEqual([]);
    expect(empty.connectionIds).toEqual([]);
  });

  it('gives_a_node_with_neither_field_no_connections', () => {
    const out = nodeOf({ id: 'a', title: '', text: '' });
    expect(out.connections).toEqual([]);
    expect(out.connectionIds).toEqual([]);
  });
});

describe('normalizeChart shape and purity', () => {
  const messy = (): Raw => ({
    title: 'Chart',
    sections: [
      section([column([node('a', { connectionIds: ['b', 'b'] }), node('a'), node()]), column([])]),
      section([column([node('b', { connections: [{ targetId: 'a', confidence: 10 }] })])], 's0'),
      section([], 's0'),
    ],
  });

  it('normalize_is_idempotent', () => {
    const once = normalizeChart(messy());
    expect(deepEqual(normalizeChart(once), once)).toBe(true);
  });

  it('keeps_unknown_fields', () => {
    const out = normalizeChart({
      topLevel: { deep: [1] },
      sections: [
        {
          ...section([
            {
              ...column([
                node('a', { foo: 1, connections: [{ targetId: 'b', confidence: 5, bar: 2 }] }),
              ]),
              colExtra: 'c',
            },
          ]),
          secExtra: 's',
        },
      ],
    }) as ToCData & Raw;
    expect(out.topLevel).toEqual({ deep: [1] });
    expect(out.sections[0]).toMatchObject({ secExtra: 's' });
    expect(out.sections[0].columns[0]).toMatchObject({ colExtra: 'c' });
    expect(firstNode(out)).toMatchObject({ foo: 1 });
    expect(firstNode(out).connections).toEqual([{ targetId: 'b', confidence: 5, bar: 2 }]);
  });

  it('throws_shape_error_without_sections_array', () => {
    for (const bad of [
      {},
      { sections: 'x' },
      { sections: { 0: {} } },
      null,
      undefined,
      'chart',
      7,
      [],
    ]) {
      let thrown: unknown;
      try {
        normalizeChart(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ChartShapeError);
      expect((thrown as ChartShapeError).raw).toBe(bad);
    }
  });

  it('does_not_mutate_its_input', () => {
    // A frozen input makes any write throw; the result must still be complete.
    const out = normalizeChart(deepFreeze(messy()));
    expect(nodeIds(out)).toEqual(['a', 'a~2', 'n0.0.2', 'b']);
  });
});

describe('deepEqual', () => {
  it('deepEqual_ignores_key_order_and_undefined', () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqual({ x: 1, y: 2 }, { y: 2, x: 1 })).toBe(true);
    expect(deepEqual({ o: { x: [{ p: 1, q: undefined }] } }, { o: { x: [{ p: 1 }] } })).toBe(true);
  });

  it('deepEqual_distinguishes_different_values', () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 0 })).toBe(false);
    expect(deepEqual({ a: null }, {})).toBe(false);
    expect(deepEqual({ a: 1 }, { a: '1' })).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('ids', () => {
  it('mints_prefixed_random_container_ids', () => {
    expect(newSectionId()).toMatch(/^sec-[0-9a-z]{10}$/);
    expect(newColumnId()).toMatch(/^col-[0-9a-z]{10}$/);
    expect(newSectionId()).not.toBe(newSectionId());
    expect(newColumnId()).not.toBe(newColumnId());
  });

  it('mints_node_ids_in_the_established_format', () => {
    expect(newNodeId()).toMatch(/^node-\d+-[0-9a-z]{1,9}$/);
    expect(newNodeId()).not.toBe(newNodeId());
  });

  it('idOf_returns_the_id_and_throws_when_it_is_missing', () => {
    expect(idOf({ id: 'sec-1' })).toBe('sec-1');
    expect(() => idOf({})).toThrow(/id/);
  });
});
