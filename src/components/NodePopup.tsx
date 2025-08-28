import React from "react"

interface NodePopupProps {
  nodePopup: {
    id: string
    title: string
    text: string
  }
  setNodePopup: React.Dispatch<React.SetStateAction<{ id: string; title: string; text: string } | null>>
  svgSize: { width: number; height: number }
}

export function NodePopup({
  nodePopup,
  setNodePopup,
  svgSize,
}: NodePopupProps) {
  return (
    <div 
      className="absolute z-50 flex items-center justify-center transition-all duration-150 ease-out"
      style={{
        top: 0,
        left: 0,
        width: `${svgSize.width}px`,
        height: `${svgSize.height}px`,
        pointerEvents: 'auto',
        animation: 'fadeIn 0.15s ease-out'
      }}
    >
      {/* Backdrop with blur */}
      <div 
        className="absolute bg-black bg-opacity-40 backdrop-blur-[2px]"
        style={{
          top: 0,
          left: 0,
          width: '100%',
          height: '100%'
        }}
        onClick={() => setNodePopup(null)}
      />
      
      {/* Modal content */}
      <div 
        className="relative bg-white rounded-xl shadow-2xl p-8 overflow-y-auto max-h-[500px] transform transition-all duration-150 ease-out"
        style={{
          width: '600px',
          animation: 'scaleIn 0.15s ease-out'
        }}
      >
        {/* Close button */}
        <button
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl leading-none"
          onClick={() => setNodePopup(null)}
        >
          ×
        </button>
        
        {/* Header */}
        <div className="mb-6">
          <h2 className="text-lg font-bold text-gray-900 mb-2">
            {nodePopup.title}
          </h2>
        </div>
        
        {/* Content */}
        <div className="space-y-6">
          <div>
            <hr className="border-gray-300 mb-3" />
            <p className="text-gray-600 leading-relaxed text-sm">
              {nodePopup.text}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}