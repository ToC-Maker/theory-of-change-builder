import { useState, useEffect } from "react"
import { Routes, Route, useParams, Link } from "react-router-dom"
import { ToC } from "./stories/ToC"
import { CharityEntrepreneurship } from "./stories/ToC.stories"
import "./App.css"

interface ToCData {
  sections: any[]
  textSize?: number
  curvature?: number
}

function ToCViewer() {
  const { filename } = useParams<{ filename: string }>()
  const [data, setData] = useState<ToCData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setError(null)
      
      try {
        if (filename) {
          const response = await fetch(`/ToC-graphs/${filename}`)
          if (!response.ok) {
            throw new Error(`Failed to load ${filename}`)
          }
          const jsonData = await response.json()
          setData(jsonData)
        } else {
          // Default to Charity Entrepreneurship
          setData(CharityEntrepreneurship.args.data)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data')
        console.error('Error loading ToC data:', err)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [filename])

  if (loading) {
    return (
      <div className="h-screen w-screen bg-gray-50 flex items-center justify-center">
        <div className="text-xl text-gray-600">Loading Theory of Change...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-screen w-screen bg-gray-50 flex flex-col items-center justify-center">
        <div className="text-xl text-red-600 mb-4">Error: {error}</div>
        <Link to="/" className="text-blue-600 hover:underline">
          Return to Home
        </Link>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="h-screen w-screen bg-gray-50 flex items-center justify-center">
        <div className="text-xl text-gray-600">No data available</div>
      </div>
    )
  }

  const title = filename 
    ? filename.replace('.json', '').replace(/([A-Z])/g, ' $1').trim()
    : 'Charity Entrepreneurship'

  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col items-center justify-start py-4 px-4 overflow-auto fixed inset-0">
      <h1 className="text-3xl font-bold mb-4 text-center text-gray-800 flex-shrink-0">
        Theory of Change: {title}
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
        <ToC data={data} onSizeChange={setContainerSize} />
      </div>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<ToCViewer />} />
      <Route path="/:filename" element={<ToCViewer />} />
    </Routes>
  )
}

export default App
