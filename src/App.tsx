import { ToC } from "./stories/ToC"
import { CharityEntrepreneurship } from "./stories/ToC.stories"
import "./App.css"

function App() {
  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col p-4 overflow-hidden fixed inset-0">
      <h1 className="text-3xl font-bold mb-4 text-center text-gray-800 flex-shrink-0">
        Theory of Change: Charity Entrepreneurship
      </h1>
      <div className="flex-1 bg-white rounded-xl shadow-lg p-4 overflow-auto min-h-0">
        <ToC data={CharityEntrepreneurship.args.data} />
      </div>
    </div>
  )
}

export default App
