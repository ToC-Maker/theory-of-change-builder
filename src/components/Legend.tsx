import React, { useCallback, useEffect } from 'react';
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
  legendPosition: { x: number; y: number };
  setLegendPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  isDraggingLegend: boolean;
  setIsDraggingLegend: React.Dispatch<React.SetStateAction<boolean>>;
  legendDragOffset: { x: number; y: number };
  setLegendDragOffset: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  editMode?: boolean;
  fontFamily?: string;
}

export function Legend({
  legendPosition,
  setLegendPosition,
  isDraggingLegend,
  setIsDraggingLegend,
  legendDragOffset,
  setLegendDragOffset,
  editMode = true,
  fontFamily,
}: LegendProps) {
  const handleLegendMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!editMode) return; // Don't allow dragging in view mode
      setIsDraggingLegend(true);
      setLegendDragOffset({
        x: e.clientX - legendPosition.x,
        y: e.clientY - legendPosition.y,
      });
    },
    [legendPosition, setIsDraggingLegend, setLegendDragOffset, editMode],
  );

  const handleLegendMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isDraggingLegend) {
        setLegendPosition({
          x: e.clientX - legendDragOffset.x,
          y: e.clientY - legendDragOffset.y,
        });
      }
    },
    [isDraggingLegend, legendDragOffset, setLegendPosition],
  );

  const handleLegendMouseUp = useCallback(() => {
    setIsDraggingLegend(false);
  }, [setIsDraggingLegend]);

  useEffect(() => {
    if (isDraggingLegend) {
      document.addEventListener('mousemove', handleLegendMouseMove);
      document.addEventListener('mouseup', handleLegendMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleLegendMouseMove);
        document.removeEventListener('mouseup', handleLegendMouseUp);
      };
    }
  }, [isDraggingLegend, handleLegendMouseMove, handleLegendMouseUp]);

  return (
    <div
      // PR 1 polish: dropped `shadow-lg` per plan failure-mode #8
      // (shadow makes the legend look clickable). Keep the border so it
      // stays visually grouped against the canvas.
      className={`absolute z-40 bg-white rounded-lg border border-gray-200 p-3 select-none ${
        editMode ? (isDraggingLegend ? 'cursor-grabbing' : 'cursor-grab') : ''
      }`}
      style={{
        left: `${legendPosition.x}px`,
        top: `${legendPosition.y}px`,
      }}
      onMouseDown={handleLegendMouseDown}
    >
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
