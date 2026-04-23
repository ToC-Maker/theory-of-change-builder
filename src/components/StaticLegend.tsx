export function StaticLegend() {
  return (
    <div>
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