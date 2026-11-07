// Deep shape validation for imported / programmatically supplied ToC
// JSON. Walks sections → columns → nodes → connections → waypoints,
// returning `{ ok: false, reason }` with a specific path on the first
// malformation. The shallow `Array.isArray(parsed.sections)` check
// passes file shapes that would silently render as empty charts (e.g.
// `columns: "not an array"`); we walk deeper before letting the
// import overwrite the user's graph.
//
// Single canonical validator: callers (FileMenu.handleFileChosen,
// App.handleUploadJSON) all route through this. Waypoints are
// `connections[].waypoints: {dx: number, dy: number}[]`, checked for
// finite numbers so garbage never reaches the SVG path builder. Entries
// in the earlier absolute `{x, y}` format are accepted too and kept
// as they are: the renderer ignores them (automatic curve) and the
// next drag on that connection replaces them.
import type { ToCData } from '../types';

function hasFiniteNumbers(value: object, a: string, b: string): boolean {
  const entry = value as Record<string, unknown>;
  return Number.isFinite(entry[a]) && Number.isFinite(entry[b]);
}

export function validateChartImport(
  parsed: unknown,
): { ok: true; data: ToCData } | { ok: false; reason: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'top-level is not an object' };
  }
  const top = parsed as { sections?: unknown };
  if (!Array.isArray(top.sections)) {
    return { ok: false, reason: 'sections is not an array' };
  }
  for (let i = 0; i < top.sections.length; i++) {
    const s = top.sections[i] as { columns?: unknown } | null;
    if (!s || typeof s !== 'object') {
      return { ok: false, reason: `sections[${i}] is not an object` };
    }
    if (!Array.isArray(s.columns)) {
      return { ok: false, reason: `sections[${i}].columns is not an array` };
    }
    for (let j = 0; j < s.columns.length; j++) {
      const c = s.columns[j] as { nodes?: unknown } | null;
      if (!c || typeof c !== 'object') {
        return { ok: false, reason: `sections[${i}].columns[${j}] is not an object` };
      }
      if (!Array.isArray(c.nodes)) {
        return { ok: false, reason: `sections[${i}].columns[${j}].nodes is not an array` };
      }
      for (let k = 0; k < c.nodes.length; k++) {
        const n = c.nodes[k] as { connections?: unknown } | null;
        if (!n || typeof n !== 'object') {
          return {
            ok: false,
            reason: `sections[${i}].columns[${j}].nodes[${k}] is not an object`,
          };
        }
        // `connections` is optional (older charts use `connectionIds`).
        // When present it must be an array of objects; waypoints (when
        // present) must be `{dx, dy}` (or the old `{x, y}`) with finite
        // numbers.
        if (n.connections !== undefined) {
          if (!Array.isArray(n.connections)) {
            return {
              ok: false,
              reason: `sections[${i}].columns[${j}].nodes[${k}].connections is not an array`,
            };
          }
          for (let m = 0; m < n.connections.length; m++) {
            const conn = n.connections[m] as { waypoints?: unknown } | null;
            if (!conn || typeof conn !== 'object') {
              return {
                ok: false,
                reason: `sections[${i}].columns[${j}].nodes[${k}].connections[${m}] is not an object`,
              };
            }
            if (conn.waypoints !== undefined) {
              if (!Array.isArray(conn.waypoints)) {
                return {
                  ok: false,
                  reason: `sections[${i}].columns[${j}].nodes[${k}].connections[${m}].waypoints is not an array`,
                };
              }
              for (let w = 0; w < conn.waypoints.length; w++) {
                const wp = conn.waypoints[w] as object | null;
                if (!wp || typeof wp !== 'object') {
                  return {
                    ok: false,
                    reason: `sections[${i}].columns[${j}].nodes[${k}].connections[${m}].waypoints[${w}] is not an object`,
                  };
                }
                if (!hasFiniteNumbers(wp, 'dx', 'dy') && !hasFiniteNumbers(wp, 'x', 'y')) {
                  return {
                    ok: false,
                    reason: `sections[${i}].columns[${j}].nodes[${k}].connections[${m}].waypoints[${w}] has invalid offsets (expected finite numeric {dx, dy})`,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
  return { ok: true, data: parsed as ToCData };
}
