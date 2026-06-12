import { getConfidenceStrokeStyle } from '../utils';

/**
 * Sample confidences rendered in the legend. The dash geometry is
 * CONTINUOUS in confidence (PR #34 feedback 51) — there are no style
 * buckets to enumerate — so the legend shows representative stops
 * along the scale, drawn by the exact same `getConfidenceStrokeStyle`
 * the canvas uses (single source of truth; the legend can't drift).
 */
const LEGEND_SAMPLES = [100, 75, 50, 25] as const;

function LegendSampleLine({ confidence }: { confidence: number }) {
  const style = getConfidenceStrokeStyle(confidence);
  return (
    <svg width="40" height="2" className="flex-shrink-0">
      <line
        x1="0"
        y1="1"
        x2="40"
        y2="1"
        stroke={style.stroke}
        strokeWidth="2"
        strokeDasharray={style.strokeDasharray === 'none' ? undefined : style.strokeDasharray}
      />
    </svg>
  );
}

interface LegendProps {
  fontFamily?: string;
}

/**
 * Connection-strength key. VIEW-MODE-ONLY chrome (PR #34 round-7
 * feedback 76): the editor doesn't render it — editors see confidence
 * numerically in the EdgeEditor — while view-only consumers have no
 * other key for the dash mapping.
 *
 * Mounted by the viewer route (`ToCViewerOnly`) OUTSIDE the zoom/pan
 * transform as a fixed bottom-LEFT overlay (bottom-right belongs to
 * the zoom controls): it never scales with zoom and can't permanently
 * cover content — panning moves content out from under it.
 *
 * Not draggable. The drag machinery that used to live here dated from
 * the legend's birth commit (23bf0b8), where the default position was
 * top-left OVER the first column and dragging was the only escape; a
 * fixed corner placement outside the canvas removes the need, and
 * round-7 feedback 76 explicitly questioned the affordance.
 */
export function Legend({ fontFamily }: LegendProps) {
  return (
    <div className="fixed bottom-4 left-4 z-40 bg-white rounded-lg border border-gray-200 p-3 select-none">
      <div className="text-xs font-medium text-gray-700 mb-2" style={{ fontFamily }}>
        Connection Confidence
      </div>
      <div className="space-y-2">
        {LEGEND_SAMPLES.map((confidence) => (
          <div key={confidence} className="flex items-center gap-3">
            <LegendSampleLine confidence={confidence} />
            <span className="text-xs text-gray-600" style={{ fontFamily }}>
              {confidence}%
            </span>
          </div>
        ))}
        <div className="text-[10px] text-gray-400 max-w-[120px]" style={{ fontFamily }}>
          Gaps grow as confidence drops
        </div>
      </div>
    </div>
  );
}
