import { useState } from "react"
import { ToC } from "./stories/ToC"
import { CharityEntrepreneurship } from "./stories/ToC.stories"
import "./App.css"

function App() {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col items-center justify-start py-4 px-4 overflow-auto fixed inset-0">
      <h1 className="text-3xl font-bold mb-4 text-center text-gray-800 flex-shrink-0">
        Theory of Change: Charity Entrepreneurship
      </h1>
      <div 
        className="bg-white rounded-xl shadow-lg p-4"
        style={{
          width: containerSize.width > 0 ? `${containerSize.width + 32}px` : 'auto',
          height: containerSize.height > 0 ? `${containerSize.height + 32}px` : 'auto',
          minWidth: containerSize.width > 0 ? `${containerSize.width + 32}px` : 'auto',
          minHeight: containerSize.height > 0 ? `${containerSize.height + 32}px` : 'auto',
          maxWidth: containerSize.width > 0 ? `${containerSize.width + 32}px` : 'none',
          maxHeight: containerSize.height > 0 ? `${containerSize.height}px` : 'none'
        }}
      >
        <ToC data={CharityEntrepreneurship.args.data} onSizeChange={setContainerSize} />
      </div>
    </div>
  )
}

export default App
