import type { Meta, StoryObj } from "@storybook/react"
import { ToC } from "./ToC"

const meta = {
  title: "ToC",
  component: ToC,
  parameters: {},
  tags: ["autodocs"],
} satisfies Meta<typeof ToC>

export default meta
type Story = StoryObj<typeof meta>

// More on writing stories with args: https://storybook.js.org/docs/writing-stories/args
export const Default: Story = {
  args: {
    data: {
      sections: [
        {
          title: "Approaches needed for change",
          columns: [
            {
              nodes: [
                {
                  id: "1",
                  title: "Accelerating advocacy",
                  text: "Description of accelerating advocacy approach",
                  connectionIds: ["2", "3"],
                },
                {
                  id: "2",
                  title: "Strengthening accountability",
                  text: "Details about strengthening accountability",
                  connectionIds: ["4", "5"],
                },
                {
                  id: "3",
                  title: "Scaling research & innovation",
                  text: "Information on scaling research and innovation",
                  connectionIds: ["6"],
                },
                {
                  id: "4",
                  title: "Cultivating alliances",
                  text: "Explanation of cultivating alliances approach",
                  connectionIds: ["7", "8"],
                },
                {
                  id: "5",
                  title: "Amplifying narratives",
                  text: "Description of amplifying narratives strategy",
                  connectionIds: ["9"],
                },
                {
                  id: "6",
                  title: "Redefining value",
                  text: "Details about redefining value approach",
                  connectionIds: ["10"],
                },
              ],
            },
          ],
        },
        {
          title: "How the change is expected to unfold",
          columns: [
            {
              nodes: [
                {
                  id: "7",
                  title: "Influence policymakers",
                  text: "Steps to influence policymakers",
                  connectionIds: ["11", "12"],
                },
                {
                  id: "8",
                  title: "Mechanisms for participation",
                  text: "Description of participation mechanisms",
                  connectionIds: ["13"],
                },
                {
                  id: "9",
                  title: "Cross-sectoral movements",
                  text: "Information on cross-sectoral movements",
                  connectionIds: ["14", "15"],
                },
                {
                  id: "10",
                  title: "New models lead the change",
                  text: "Details about new leading models",
                  connectionIds: ["16"],
                },
                {
                  id: "11",
                  title: "Early majority joins in",
                  text: "Description of early majority participation",
                  connectionIds: ["17"],
                },
                {
                  id: "12",
                  title: "Prototypers step up",
                  text: "Information about prototypers stepping up",
                  connectionIds: ["18"],
                },
                {
                  id: "13",
                  title: "Measuring what matters",
                  text: "Explanation of measuring important factors",
                  connectionIds: ["19"],
                },
              ],
            },
          ],
        },
        {
          title: "2025 outcomes",
          columns: [
            {
              nodes: [
                {
                  id: "14",
                  title: "Business and industry",
                  text: "Outcomes related to business and industry",
                  connectionIds: [],
                },
                {
                  id: "15",
                  title: "Programmes",
                  text: "Expected programme outcomes",
                  connectionIds: [],
                },
                {
                  id: "16",
                  title: "Finance sector",
                  text: "Outcomes in the finance sector",
                  connectionIds: [],
                },
              ],
            },
          ],
        },
      ],
    },
  },
}

export const FourColumnExample = {
  args: {
    data: {
      sections: [
        {
          title: "Section 1",
          columns: [
            {
              nodes: [
                {
                  id: "🍎",
                  title: "🍎 → 🍋🍇",
                  text: "Apple connecting to Lemon and Grape",
                  connectionIds: ["🍋", "🍇"],
                },
                {
                  id: "🍊",
                  title: "🍊 → 🍇",
                  text: "Orange connecting to Grape",
                  connectionIds: ["🍇"],
                },
              ],
            },
          ],
        },
        {
          title: "Section 2 - Multiple Columns",
          columns: [
            {
              nodes: [
                {
                  id: "🍋",
                  title: "🍋 → 🍉🍓",
                  text: "Lemon connecting to Watermelon and Strawberry",
                  connectionIds: ["🍉", "🍓"],
                },
                {
                  id: "🍇",
                  title: "🍇 → 🍓",
                  text: "Grape connecting to Strawberry",
                  connectionIds: ["🍓"],
                },
              ],
            },
            {
              nodes: [
                {
                  id: "🍐",
                  title: "🍐 → 🍉",
                  text: "Pear connecting to Watermelon",
                  connectionIds: ["🍉"],
                },
              ],
            },
          ],
        },
        {
          title: "Section 3",
          columns: [
            {
              nodes: [
                {
                  id: "🍉",
                  title: "🍉 → 🍍",
                  text: "Watermelon connecting to Pineapple",
                  connectionIds: ["🍍"],
                },
                {
                  id: "🍓",
                  title: "🍓 → 🍍🥝",
                  text: "Strawberry connecting to Pineapple and Kiwi",
                  connectionIds: ["🍍", "🥝"],
                },
              ],
            },
          ],
        },
        {
          title: "Section 4",
          columns: [
            {
              nodes: [
                {
                  id: "🍍",
                  title: "🍍",
                  text: "Pineapple",
                  connectionIds: [],
                },
                {
                  id: "🥝",
                  title: "🥝",
                  text: "Kiwi",
                  connectionIds: [],
                },
                {
                  id: "🍑",
                  title: "🍑",
                  text: "Peach",
                  connectionIds: [],
                },
              ],
            },
          ],
        },
      ],
    },
  },
}

export const ClimateResearchExample: Story = {
  args: {
    data: {
      sections: [
        {
          title: "Inputs",
          columns: [
            {
              nodes: [
                {
                  id: "funding",
                  title: "Funding",
                  text: "Financial resources for research and development",
                  connectionIds: ["whitepaper", "workshop"],
                },
                {
                  id: "research-staff",
                  title: "Research Staff",
                  text: "Qualified researchers and technical experts",
                  connectionIds: ["prototype"],
                },
              ],
            },
          ],
        },
        {
          title: "Outputs",
          columns: [
            {
              nodes: [
                {
                  id: "whitepaper",
                  title: "Whitepaper Published",
                  text: "Research findings and recommendations published",
                  connectionIds: ["gov-policy"],
                },
                {
                  id: "prototype",
                  title: "Prototype Built",
                  text: "Working prototype demonstrating technical feasibility",
                  connectionIds: ["tech-viability", "carbon-targets"],
                },
                {
                  id: "workshop",
                  title: "Stakeholder Workshop",
                  text: "Multi-stakeholder workshop to build understanding",
                  connectionIds: ["shared-understanding"],
                },
              ],
            },
          ],
        },
        {
          title: "Outcomes",
          columns: [
            {
              nodes: [
                {
                  id: "shared-understanding",
                  title: "Shared understanding of issue",
                  text: "Stakeholders have common understanding of the problem",
                  connectionIds: ["stakeholder-alignment"],
                },
              ],
            },
            {
              nodes: [
                {
                  id: "stakeholder-alignment",
                  title: "Widespread stakeholder alignment",
                  text: "Key stakeholders aligned on approach and solutions",
                  connectionIds: ["gov-policy"],
                },
                {
                  id: "tech-viability",
                  title: "Proven tech viability",
                  text: "Technology proven to be viable and scalable",
                  connectionIds: ["firm-standards"],
                },
              ],
            },
            {
              nodes: [
                {
                  id: "gov-policy",
                  title: "Gov't adopts new policy",
                  text: "Government implements supportive policy framework",
                  connectionIds: ["carbon-targets"],
                },
                {
                  id: "firm-standards",
                  title: "Large firms change standards",
                  text: "Major corporations adopt new standards and practices",
                  connectionIds: ["carbon-targets"],
                },
              ],
            },
          ],
        },
        {
          title: "End Goal",
          columns: [
            {
              nodes: [
                {
                  id: "carbon-targets",
                  title: "National carbon targets achieved",
                  text: "Country achieves its carbon reduction targets",
                  connectionIds: ["climate-future"],
                },
              ],
            },
          ],
        },
        {
          title: "End Mission",
          columns: [
            {
              nodes: [
                {
                  id: "climate-future",
                  title: "Climate-resilient future",
                  text: "A sustainable, climate-resilient future is achieved",
                  connectionIds: [],
                },
              ],
            },
          ],
        },
      ],
    },
  },
}