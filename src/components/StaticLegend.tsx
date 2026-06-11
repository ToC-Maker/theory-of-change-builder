import { getConfidenceStrokeStyle } from '../utils';

/**
 * Non-draggable variant of the confidence legend. Dash geometry is
 * continuous in confidence (PR #34 feedback 51), so the legend shows
 * representative stops rendered by the same `getConfidenceStrokeStyle`
 * the canvas uses.
 */
const LEGEND_SAMPLES = [100, 75, 50, 25] as const;

export function StaticLegend() {
  return (
    <div>
      <div className="text-xs font-medium text-gray-700 mb-2">Connection Confidence</div>
      <div className="space-y-2">
        {LEGEND_SAMPLES.map((confidence) => {
          const style = getConfidenceStrokeStyle(confidence);
          return (
            <div key={confidence} className="flex items-center gap-3">
              <svg width="40" height="2" className="flex-shrink-0">
                <line
                  x1="0"
                  y1="1"
                  x2="40"
                  y2="1"
                  stroke={style.stroke}
                  strokeWidth="2"
                  strokeDasharray={
                    style.strokeDasharray === 'none' ? undefined : style.strokeDasharray
                  }
                />
              </svg>
              <span className="text-xs text-gray-600">{confidence}%</span>
            </div>
          );
        })}
        <div className="text-[10px] text-gray-400 max-w-[120px]">Gaps grow as confidence drops</div>
      </div>
    </div>
  );
}
