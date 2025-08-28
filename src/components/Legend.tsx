import React, { useCallback, useEffect } from "react"

interface LegendProps {
  legendPosition: { x: number; y: number }
  setLegendPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>
  isDraggingLegend: boolean
  setIsDraggingLegend: React.Dispatch<React.SetStateAction<boolean>>
  legendDragOffset: { x: number; y: number }
  setLegendDragOffset: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>
}

export function Legend({
  legendPosition,
  setLegendPosition,
  isDraggingLegend,
  setIsDraggingLegend,
  legendDragOffset,
  setLegendDragOffset,
}: LegendProps) {
  const handleLegendMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDraggingLegend(true)
    setLegendDragOffset({
      x: e.clientX - legendPosition.x,
      y: e.clientY - legendPosition.y
    })
  }, [legendPosition, setIsDraggingLegend, setLegendDragOffset])

  const handleLegendMouseMove = useCallback((e: MouseEvent) => {
    if (isDraggingLegend) {
      setLegendPosition({
        x: e.clientX - legendDragOffset.x,
        y: e.clientY - legendDragOffset.y
      })
    }
  }, [isDraggingLegend, legendDragOffset, setLegendPosition])

  const handleLegendMouseUp = useCallback(() => {
    setIsDraggingLegend(false)
  }, [setIsDraggingLegend])

  useEffect(() => {
    if (isDraggingLegend) {
      document.addEventListener('mousemove', handleLegendMouseMove)
      document.addEventListener('mouseup', handleLegendMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleLegendMouseMove)
        document.removeEventListener('mouseup', handleLegendMouseUp)
      }
    }
  }, [isDraggingLegend, handleLegendMouseMove, handleLegendMouseUp])

  return (
    <div 
      className={`absolute z-40 bg-white rounded-lg shadow-lg border border-gray-200 p-3 select-none ${
        isDraggingLegend ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      style={{
        left: `${legendPosition.x}px`,
        top: `${legendPosition.y}px`
      }}
      onMouseDown={handleLegendMouseDown}
    >
      <div className="text-xs font-medium text-gray-700 mb-2">Connection Confidence</div>
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <svg width="24" height="2" className="flex-shrink-0">
            <line x1="0" y1="1" x2="24" y2="1" stroke="#000000" strokeWidth="2" />
          </svg>
          <span className="text-xs text-gray-600">High</span>
        </div>
        <div className="flex items-center gap-3">
          <svg width="24" height="2" className="flex-shrink-0">
            <line x1="0" y1="1" x2="24" y2="1" stroke="#000000" strokeWidth="2" strokeDasharray="8 4" />
          </svg>
          <span className="text-xs text-gray-600">Medium</span>
        </div>
        <div className="flex items-center gap-3">
          <svg width="24" height="2" className="flex-shrink-0">
            <line x1="0" y1="1" x2="24" y2="1" stroke="#000000" strokeWidth="2" strokeDasharray="2 4" />
          </svg>
          <span className="text-xs text-gray-600">Low</span>
        </div>
      </div>
    </div>
  )
}