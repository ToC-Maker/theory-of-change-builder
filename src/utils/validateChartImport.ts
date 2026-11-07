// Validation of an imported (or otherwise programmatically supplied) chart.
// The structure checks are `normalizeChart`'s: a chart that normalises is
// shaped well enough to render, and the result comes back normalised so every
// section and column has an id. What this adds is the waypoint check:
// `connections[].waypoints` must be `{dx: number, dy: number}` entries with
// finite numbers so garbage never reaches the SVG path builder. Entries in the
// earlier absolute `{x, y}` format are accepted too and kept as they are: the
// renderer ignores them (automatic curve) and the next drag on that connection
// replaces them.
//
// Single canonical validator: callers (FileMenu.handleFileChosen,
// App.handleUploadJSON) all route through this. A `reason` names the first
// malformed part by its index path in the file.
import { ChartShapeError, normalizeChart, type ToCData } from '../types';

function hasFiniteNumbers(value: object, a: string, b: string): boolean {
  const entry = value as Record<string, unknown>;
  return Number.isFinite(entry[a]) && Number.isFinite(entry[b]);
}

// The first bad waypoint, by its position in `parsed`, which `normalizeChart`
// has already shown to be a well-shaped chart. Walked on the file's own
// structure because normalising drops repeated connections and would shift
// the indices.
function waypointProblem(parsed: unknown): string | null {
  const sections = (parsed as { sections: { columns: { nodes: unknown[] }[] }[] }).sections;
  for (const [i, section] of sections.entries()) {
    for (const [j, column] of section.columns.entries()) {
      for (const [k, node] of column.nodes.entries()) {
        const connections = (node as { connections?: { waypoints?: unknown }[] }).connections ?? [];
        for (const [m, connection] of connections.entries()) {
          const { waypoints } = connection;
          if (waypoints === undefined) continue;
          const at = `sections[${i}].columns[${j}].nodes[${k}].connections[${m}].waypoints`;
          if (!Array.isArray(waypoints)) return `${at} is not an array`;
          for (const [w, waypoint] of waypoints.entries()) {
            if (!waypoint || typeof waypoint !== 'object') return `${at}[${w}] is not an object`;
            if (!hasFiniteNumbers(waypoint, 'dx', 'dy') && !hasFiniteNumbers(waypoint, 'x', 'y')) {
              return `${at}[${w}] has invalid offsets (expected finite numeric {dx, dy})`;
            }
          }
        }
      }
    }
  }
  return null;
}

export function validateChartImport(
  parsed: unknown,
): { ok: true; data: ToCData } | { ok: false; reason: string } {
  let data: ToCData;
  try {
    data = normalizeChart(parsed);
  } catch (err) {
    // Instead of throwing: a file that is not a chart is the user's mistake, and
    // the import dialog shows the reason.
    if (err instanceof ChartShapeError) return { ok: false, reason: err.reason };
    throw err;
  }
  const problem = waypointProblem(parsed);
  return problem === null ? { ok: true, data } : { ok: false, reason: problem };
}
