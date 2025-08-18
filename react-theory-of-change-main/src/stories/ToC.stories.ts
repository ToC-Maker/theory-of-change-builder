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
                  connections: [
                    { 
                      targetId: "2", 
                      confidence: 85,
                      evidence: "Studies show that advocacy campaigns increase policy attention by 65% within 6 months. Historical data from similar initiatives demonstrates strong causal links.",
                      assumptions: "Policymakers are responsive to well-coordinated advocacy efforts. Media coverage amplifies advocacy messages effectively."
                    },
                    { 
                      targetId: "3", 
                      confidence: 60,
                      evidence: "Research indicates advocacy can drive innovation funding, though the relationship varies by policy context.",
                      assumptions: "Innovation funding is influenced by public advocacy. Research institutions respond to advocacy pressure."
                    },
                  ],
                },
                {
                  id: "2",
                  title: "Strengthening accountability",
                  text: "Details about strengthening accountability",
                  connectionIds: ["4", "5"],
                  connections: [
                    { 
                      targetId: "4", 
                      confidence: 55,
                      evidence: "Some evidence exists that accountability measures can foster alliances, but the mechanism is not fully understood.",
                      assumptions: "Transparency creates trust among potential allies. Accountability systems attract like-minded organizations."
                    },
                    { 
                      targetId: "5", 
                      confidence: 90,
                      evidence: "Strong empirical evidence shows accountability frameworks directly enhance narrative credibility. Multiple case studies confirm this relationship.",
                      assumptions: "Credible narratives require verifiable accountability measures. Audiences trust messages from accountable sources."
                    },
                  ],
                },
                {
                  id: "3",
                  title: "Scaling research & innovation",
                  text: "Information on scaling research and innovation",
                  connectionIds: ["6"],
                  connections: [
                    { 
                      targetId: "6", 
                      confidence: 25,
                      evidence: "Limited evidence suggests research can influence value systems, but causation is unclear and highly dependent on context.",
                      assumptions: "Value systems can be shifted through research findings. Academic research reaches decision-makers effectively."
                    },
                  ],
                },
                {
                  id: "4",
                  title: "Cultivating alliances",
                  text: "Explanation of cultivating alliances approach",
                  connectionIds: ["7", "8"],
                  connections: [
                    { 
                      targetId: "7", 
                      confidence: 80,
                      evidence: "Historical analysis shows strong alliances consistently influence policymakers. Documented cases from the past decade support this connection.",
                      assumptions: "Allied organizations have collective political influence. Policymakers respond to coordinated pressure from multiple stakeholders."
                    },
                    { 
                      targetId: "8", 
                      confidence: 45,
                      evidence: "Mixed evidence on whether alliances create participation mechanisms. Some successful cases exist but many counter-examples as well."
                    },
                  ],
                },
                {
                  id: "5",
                  title: "Amplifying narratives",
                  text: "Description of amplifying narratives strategy",
                  connectionIds: ["9"],
                  connections: [
                    { targetId: "9", confidence: 70 },
                  ],
                },
                {
                  id: "6",
                  title: "Redefining value",
                  text: "Details about redefining value approach",
                  connectionIds: ["10"],
                  connections: [
                    { targetId: "10", confidence: 15 },
                  ],
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
                  connections: [
                    { targetId: "11", confidence: 82 },
                    { targetId: "12", confidence: 40 },
                  ],
                },
                {
                  id: "8",
                  title: "Mechanisms for participation",
                  text: "Description of participation mechanisms",
                  connectionIds: ["13"],
                  connections: [
                    { targetId: "13", confidence: 30 },
                  ],
                },
                {
                  id: "9",
                  title: "Cross-sectoral movements",
                  text: "Information on cross-sectoral movements",
                  connectionIds: ["14", "15"],
                  connections: [
                    { targetId: "14", confidence: 65 },
                    { targetId: "15", confidence: 88 },
                  ],
                },
                {
                  id: "10",
                  title: "New models lead the change",
                  text: "Details about new leading models",
                  connectionIds: ["16"],
                  connections: [
                    { targetId: "16", confidence: 75 },
                  ],
                },
                {
                  id: "11",
                  title: "Early majority joins in",
                  text: "Description of early majority participation",
                  connectionIds: [],
                  connections: [],
                },
                {
                  id: "12",
                  title: "Prototypers step up",
                  text: "Information about prototypers stepping up",
                  connectionIds: [],
                  connections: [],
                },
                {
                  id: "13",
                  title: "Measuring what matters",
                  text: "Explanation of measuring important factors",
                  connectionIds: [],
                  connections: [],
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
                  id: "workshop",
                  title: "Stakeholder Workshop",
                  text: "Multi-stakeholder workshop to build understanding",
                  connectionIds: ["shared-understanding"],
                },
                {
                  id: "prototype",
                  title: "Prototype Built",
                  text: "Working prototype demonstrating technical feasibility",
                  connectionIds: ["tech-viability", "carbon-targets"],
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

export const CharityEntrepreneurship: Story = {
  args: {
    data: {
      sections: [
        {
          title: "Inputs",
          columns: [
            {
              nodes: [
                {
                  id: "research",
                  title: "Extensive research into promising ideas for new charities",
                  text: "Assumptions:\n• Researcher skills, time and available information are sufficient to make recommendations worth following (Mid confidence)\n• We can continue to find promising new ideas over time i.e. the pool of shovel-ready ideas is not exhausted (High confidence)\n\nEvidence:\n• Corroboration of several of our recommendations by GiveWell and OpenPhilanthropy\n• Strong track record of CE's incubated charities (which isn't diminishing over time)",
                  connectionIds: ["reports"],
                  connections: [
                    {
                      targetId: "reports",
                      confidence: 85,
                      evidence: "Corroboration of several recommendations by GiveWell and OpenPhilanthropy. Strong track record of CE's incubated charities with no diminishing performance over time.",
                      assumptions: "Researcher skills, time and available information are sufficient to make recommendations worth following. The pool of shovel-ready ideas is not exhausted."
                    }
                  ],
                },
                {
                  id: "outreach",
                  title: "Outreach to encourage talented individuals to apply to the program",
                  text: "Assumptions:\n• At least ~20 of the ~3000 applicants we receive per year are a good fit for charity entrepreneurship (High confidence)\n• We can continue to find promising new applicants over time, i.e. the talent pool is not exhausted (Mid confidence)",
                  connectionIds: ["cohorts"],
                  connections: [
                    {
                      targetId: "cohorts",
                      confidence: 75,
                      evidence: "Historical data showing consistent ~20 suitable candidates from ~3000 applications annually.",
                      assumptions: "Talent pool is not exhausted and outreach continues to attract quality applicants. Selection criteria accurately identify entrepreneurship potential."
                    }
                  ],
                },
                {
                  id: "vetting",
                  title: "Rigorous vetting to identify the most promising applicants",
                  text: "Assumptions:\n• Our vetting process accurately identifies the most suitable applicants for charity entrepreneurship (High confidence)\n• Selected co-founders wouldn't have had a greater impact otherwise (High confidence)\n\nEvidence:\n• Our scores of applicants during the vetting process are 0.7 correlated with internal estimates of charity impact",
                  connectionIds: ["cohorts"],
                  connections: [
                    {
                      targetId: "cohorts",
                      confidence: 88,
                      evidence: "Vetting scores show 0.7 correlation with internal estimates of charity impact, demonstrating predictive validity of the selection process.",
                      assumptions: "Vetting process accurately identifies suitable applicants. Selected co-founders wouldn't have had greater impact elsewhere."
                    }
                  ],
                },
                {
                  id: "training",
                  title: "Improve and facilitate training program to launch an effective charity",
                  text: "Assumptions:\n• Our new pace of running two Incubation Programs per year, of equal or higher quality, is sustainable, even as we run new types of programs (e.g. The Foundation Program) (High confidence)",
                  connectionIds: ["programs"],
                  connections: [
                    {
                      targetId: "programs",
                      confidence: 82,
                      evidence: "Successful scaling to two programs per year while maintaining quality standards. Consistent program delivery track record.",
                      assumptions: "Running two Incubation Programs per year is sustainable at equal or higher quality. New program types can be integrated without compromising existing quality."
                    }
                  ],
                },
                {
                  id: "funder-outreach",
                  title: "Outreach to intelligent, value aligned funders to join seed network",
                  text: "Assumptions:\n• The funding landscape can support ~10 new charities per year across a range of cause areas, even in economic downturns (Mid confidence)\n• CE's reputation is strong enough that sufficient funders with good judgement want to join the network (High confidence)\n\nEvidence:\n• 83% of applications funded in last 3 programs (94% of applications to found CE recommended charity ideas)\n• Average funding: $120k",
                  connectionIds: ["seed-network"],
                  connections: [
                    {
                      targetId: "seed-network",
                      confidence: 90,
                      evidence: "83% of applications funded in last 3 programs (94% for CE recommended charity ideas). Average funding of $120k demonstrates strong funder commitment.",
                      assumptions: "Funding landscape can support ~10 new charities per year across cause areas, even in economic downturns. CE's reputation attracts sufficient high-quality funders."
                    }
                  ],
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
                  id: "reports",
                  title: "Reports recommending excellent ideas for new charities to launch",
                  text: "Assumptions:\n• Recommended ideas are diverse enough for founders with different preferences to find one they're excited to launch (Mid confidence)",
                  connectionIds: ["plans"],
                  connections: [
                    {
                      targetId: "plans",
                      confidence: 72,
                      evidence: "Historical correlation between quality research reports and successful business plan submissions. Report recommendations have been validated by external organizations.",
                      assumptions: "Recommended ideas are diverse enough for founders with different preferences. Quality research translates to actionable charity ideas."
                    }
                  ],
                },
                {
                  id: "cohorts",
                  title: "Cohorts of talented participants are a good fit for entrepreneurship",
                  text: "Assumptions:\n• Facilitation leads to strong combinations of co-founders & ideas (Low confidence)\n• Teaching equips participants with the knowledge & support they need to make smart launch plans and succeed in the field (Mid confidence)\n\nEvidence:\n• 62% of participants founded after the last 3 programs",
                  connectionIds: ["plans"],
                  connections: [
                    {
                      targetId: "plans",
                      confidence: 68,
                      evidence: "62% of participants founded after the last 3 programs, indicating strong conversion from cohort participation to plan development.",
                      assumptions: "Facilitation leads to strong co-founder & idea combinations. Teaching equips participants with necessary knowledge and support for success."
                    }
                  ],
                },
                {
                  id: "programs",
                  title: "Programs occur multiple times a year",
                  text: "Assumptions:\n• Teaching equips participants with the knowledge & support they need to make smart launch plans and succeed in the field (Mid confidence)\n\nEvidence:\n• 62% of participants founded after the last 3 programs",
                  connectionIds: ["plans"],
                  connections: [
                    {
                      targetId: "plans",
                      confidence: 65,
                      evidence: "62% of participants founded after the last 3 programs. Consistent program delivery demonstrates scalability.",
                      assumptions: "Teaching effectively equips participants with knowledge and support needed for smart launch plans and field success."
                    }
                  ],
                },
                {
                  id: "seed-network",
                  title: "Seed network with the resources and good judgement to fund deserving proposals",
                  text: "Evidence:\n• 83% of applications funded in last 3 programs (94% of applications to found CE recommended charity ideas)\n• Average funding: $120k",
                  connectionIds: ["new-charities"],
                  connections: [
                    {
                      targetId: "new-charities",
                      confidence: 92,
                      evidence: "83% of applications funded in last 3 programs (94% for CE recommended charity ideas). Average funding of $120k demonstrates robust funding capacity.",
                      assumptions: "Seed network has sufficient resources and maintains good judgment in funding decisions. Funded proposals translate to operational charities."
                    }
                  ],
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
                  id: "plans",
                  title: "Incubatees form co-founder teams & submit high quality plans to the seed network for funding",
                  text: "Assumptions:\n• The seed network only funds co-founder teams with high expected counterfactual impact (High confidence)\n• Funded co-founder teams follow through on launching a charity (High confidence)",
                  connectionIds: ["new-charities"],
                  connections: [
                    {
                      targetId: "new-charities",
                      confidence: 85,
                      evidence: "High follow-through rate from plan submission to charity launch. Seed network's selective funding approach ensures quality.",
                      assumptions: "Seed network only funds teams with high expected counterfactual impact. Funded co-founder teams follow through on launching charities."
                    }
                  ],
                },
              ],
            },
            {
              nodes: [
                {
                  id: "new-charities",
                  title: "New effective charities exist, some of which wouldn't have otherwise",
                  text: "Assumptions:\n• Charities can get funded through the 'valley of death' (Mid confidence)\n• Organizations and co-founders don't succumb to value drift (Mid confidence)",
                  connectionIds: ["impactful-programs"],
                  connections: [
                    {
                      targetId: "impactful-programs",
                      confidence: 78,
                      evidence: "Track record of launched charities demonstrates successful transition from funding to operational programs. Portfolio performance shows sustainability.",
                      assumptions: "Charities can secure funding through the 'valley of death' phase. Organizations and co-founders maintain their values and don't succumb to mission drift."
                    }
                  ],
                },
              ],
            },
            {
              nodes: [
                {
                  id: "impactful-programs",
                  title: "Charities execute counterfactually impactful programs",
                  text: "Evidence:\n• We believe ~40% of our charities are field leading, based on:\n  (a) Our internal assessments of their cost-effectiveness\n  (b) Their own public M&E results\n  (c) The endorsement of savvy funders, e.g. GiveWell → Fortify Health; OpenPhilanthropy → 8 CE charities; Founder's Pledge → FEM, LEEP & Suvita; Mulago → Suvita\n  (d) 11 external evaluations of LEEP, FEM, FWI & Suvita, by orgs like Rethink Priorities and Animal Charity Evaluators (11/11 are positive, but only a few have been made public)\n\n• External evaluations are planned for 2024.",
                  connectionIds: ["wellbeing"],
                  connections: [
                    {
                      targetId: "wellbeing",
                      confidence: 88,
                      evidence: "~40% of charities are field leading based on internal assessments, public M&E results, endorsements from GiveWell and OpenPhilanthropy, and 11 positive external evaluations (11/11 positive rate).",
                      assumptions: "Impactful programs translate directly to improved wellbeing outcomes. Cost-effectiveness assessments accurately predict real-world impact."
                    }
                  ],
                },
              ],
            },
          ],
        },
        {
          title: "Goal",
          columns: [
            {
              nodes: [
                {
                  id: "wellbeing",
                  title: "Improved well being for humans and animals",
                  text: "",
                  connectionIds: [],
                  connections: [],
                },
              ],
            },
          ],
        },
      ],
    },
  },
}