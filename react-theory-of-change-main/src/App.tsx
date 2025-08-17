import { ToC } from "./stories/ToC"
import "./App.css"

const sampleData = {
  sections: [
    {
      title: "Approach needed for change",
      columns: [
        {
          nodes: [
            { id: "1", title: "Litigation", text: "Legal challenges to animal farming practices", connectionIds: ["2", "3"] },
            { id: "4", title: "Policy advocacy", text: "Lobbying for policy changes", connectionIds: ["2", "3", "5"] },
            { id: "6", title: "Corporate outreach", text: "Working with companies to change practices", connectionIds: ["7", "8"] },
            { id: "9", title: "Mass public education", text: "Educating the public about animal welfare", connectionIds: ["10", "11"] }
          ]
        }
      ]
    },
    {
      title: "Early changes",
      columns: [
        {
          nodes: [
            { id: "2", title: "Forms of animal farming prohibited", text: "Certain farming practices are banned", connectionIds: ["12"] },
            { id: "3", title: "Industry growth hampered", text: "Animal farming industry growth slows", connectionIds: ["13"] }
          ]
        },
        {
          nodes: [
            { id: "5", title: "Meat reduction policies", text: "Policies to reduce meat consumption", connectionIds: ["13"] },
            { id: "7", title: "Increased cost of animal products", text: "Animal products become more expensive", connectionIds: ["13", "14"] },
            { id: "8", title: "Companies pledge to remove low welfare", text: "Corporate commitments to higher welfare", connectionIds: ["15"] }
          ]
        },
        {
          nodes: [
            { id: "10", title: "Reduced supply of talent", text: "Fewer people work in animal farming", connectionIds: ["12"] },
            { id: "11", title: "Plant-based eating adopted as social norm", text: "Plant-based diets become mainstream", connectionIds: ["14"] }
          ]
        }
      ]
    },
    {
      title: "Late changes",
      columns: [
        {
          nodes: [
            { id: "12", title: "Decreased availability of animal products", text: "Less animal products in the market", connectionIds: ["16"] },
            { id: "13", title: "Decreased consumption of animal products", text: "People consume fewer animal products", connectionIds: ["16"] }
          ]
        },
        {
          nodes: [
            { id: "14", title: "Low welfare practices stop", text: "End of low-welfare farming practices", connectionIds: ["17"] },
            { id: "15", title: "Higher welfare practices implemented", text: "Better treatment of farm animals", connectionIds: ["17"] }
          ]
        }
      ]
    },
    {
      title: "End goal",
      columns: [
        {
          nodes: [
            { id: "16", title: "Reduced N of animals", text: "Fewer animals in farming systems", connectionIds: ["18"] },
            { id: "17", title: "Improved welfare of animals", text: "Better conditions for farm animals", connectionIds: ["18"] }
          ]
        },
        {
          nodes: [
            { id: "18", title: "Reduced farmed animal suffering", text: "Less suffering among farm animals", connectionIds: [] }
          ]
        }
      ]
    }
  ]
}

function App() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8 text-center">Theory of Change: Farmed Animal Welfare</h1>
      <ToC data={sampleData} />
    </div>
  )
}

export default App
