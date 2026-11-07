// Checks every scenario ends with: the pages and the server agree, and the chart is sound.
import { Checks } from './checks.mjs';
import { duplicateIds } from './chart.mjs';
import { settle } from './editors.mjs';

/**
 * Waits for the pages and server to agree, then records a loss for each way they do not or the
 * chart is unsound. Returns `{ checks, server, models }` for the scenario's own predictions.
 */
export async function settleAndCheck({ mock, token, pages, checks = new Checks(), ...options }) {
  const settled = await settle({ mock, token, pages, ...options });
  checks.ok('pages and server converge', settled.converged, settled.why);
  checks.eq('duplicate node ids on the server', duplicateIds(settled.server.chart), []);
  if (settled.models.length > 1) {
    const [first, ...rest] = settled.models;
    rest.forEach((m, i) => {
      checks.ok(
        `layout of page ${i + 1} equals page 0`,
        sameLayout(m.layout, first.layout),
        `${JSON.stringify(m.layout)} vs ${JSON.stringify(first.layout)}`,
      );
    });
  }
  return { checks, ...settled };
}

// Pages may differ by a pixel or two from sub-pixel rounding.
function sameLayout(a, b, tolerance = 3) {
  const ids = Object.keys(a);
  return (
    ids.length === Object.keys(b).length &&
    ids.every((id) => b[id] && a[id].every((v, i) => Math.abs(v - b[id][i]) <= tolerance))
  );
}
