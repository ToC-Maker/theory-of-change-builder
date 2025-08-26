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

export const ClimateResearchExample: Story = {
  args: {
    data: {
      "sections": [
        {
          "title": "Inputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "funding",
                  "title": "Funding",
                  "text": "Financial resources for research and development",
                  "connectionIds": [
                    "whitepaper",
                    "workshop"
                  ],
                  "connections": [
                    {
                      "targetId": "whitepaper",
                      "confidence": 15,
                      "evidence": "Academic publications often ignored by policymakers. Climate reports regularly published but rarely drive immediate policy change.",
                      "assumptions": "Funding will be sustained long enough to complete publication. Research findings will be communicated effectively to target audiences. Academic credibility translates to policy influence."
                    },
                    {
                      "targetId": "workshop",
                      "confidence": 25,
                      "evidence": "Stakeholder workshops frequently cancelled or poorly attended. Competing interests often prevent meaningful dialogue.",
                      "assumptions": "Key stakeholders will attend and engage constructively. Workshop format can overcome existing adversarial relationships. Participants have authority to commit to outcomes."
                    }
                  ],
                  "yPosition": 92.7437515258789,
                  "width": 192,
                  "color": "#fce5cd"
                },
                {
                  "id": "research-staff",
                  "title": "Research Staff",
                  "text": "Qualified researchers and technical experts",
                  "connectionIds": [
                    "prototype"
                  ],
                  "connections": [
                    {
                      "targetId": "prototype",
                      "confidence": 18,
                      "evidence": "Technical talent shortage in climate tech. High researcher turnover due to better industry opportunities. Many climate prototypes fail to reach commercial viability.",
                      "assumptions": "Qualified staff can be hired and retained. Technical challenges are solvable within timeline. Team maintains focus despite industry pressures and competing opportunities."
                    }
                  ],
                  "yPosition": 309.375,
                  "color": "#cfe2f3"
                }
              ]
            }
          ]
        },
        {
          "title": "Outputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "whitepaper",
                  "title": "Whitepaper Published",
                  "text": "Research findings and recommendations published",
                  "connectionIds": [
                    "gov-policy"
                  ],
                  "connections": [
                    {
                      "targetId": "gov-policy",
                      "confidence": 8,
                      "evidence": "Thousands of climate reports published annually with minimal policy uptake. Policy cycles don't align with research timelines. Lobbying by vested interests regularly blocks evidence-based policies.",
                      "assumptions": "Policymakers will read and understand technical research. Political will exists to act on recommendations. Industry opposition can be overcome through evidence alone."
                    }
                  ],
                  "yPosition": 25.75,
                  "color": "#fce5cd"
                },
                {
                  "id": "workshop",
                  "title": "Stakeholder Workshop",
                  "text": "Multi-stakeholder workshop to build understanding",
                  "connectionIds": [
                    "shared-understanding"
                  ],
                  "connections": [
                    {
                      "targetId": "shared-understanding",
                      "confidence": 12,
                      "evidence": "Climate workshops often devolve into position-taking rather than genuine dialogue. Fundamental value differences between stakeholders rarely resolved through single events.",
                      "assumptions": "All key stakeholder groups will participate meaningfully. Workshop facilitators can navigate complex political dynamics. Single events can shift deeply held positions."
                    }
                  ],
                  "yPosition": 133.75,
                  "color": "#fce5cd"
                },
                {
                  "id": "prototype",
                  "title": "Prototype Built",
                  "text": "Working prototype demonstrating technical feasibility",
                  "connectionIds": [
                    "tech-viability",
                    "carbon-targets"
                  ],
                  "connections": [
                    {
                      "targetId": "tech-viability",
                      "confidence": 22,
                      "evidence": "Lab conditions rarely translate to real-world performance. Scaling challenges consistently underestimated in climate tech. Cost projections frequently overly optimistic.",
                      "assumptions": "Prototype performance accurately predicts scaled deployment. Manufacturing and deployment costs can be reduced to competitive levels. No unforeseen technical barriers emerge."
                    },
                    {
                      "targetId": "carbon-targets",
                      "confidence": 5,
                      "evidence": "Massive gap between prototype demonstration and national-scale deployment. Infrastructure, regulatory, and market barriers routinely delay climate tech adoption by decades.",
                      "assumptions": "Single technology demonstration can drive national policy targets. Technology can scale from prototype to national deployment without major technical or economic obstacles."
                    }
                  ],
                  "yPosition": 309.375,
                  "color": "#cfe2f3"
                }
              ]
            }
          ]
        },
        {
          "title": "Outcomes",
          "columns": [
            {
              "nodes": [
                {
                  "id": "shared-understanding",
                  "title": "Shared understanding of issue",
                  "text": "Stakeholders have common understanding of the problem",
                  "connectionIds": [
                    "stakeholder-alignment"
                  ],
                  "connections": [
                    {
                      "targetId": "stakeholder-alignment",
                      "confidence": 10,
                      "evidence": "Understanding problems doesn't translate to agreeing on solutions. Economic interests often override shared understanding. Climate action requires sacrificing short-term gains.",
                      "assumptions": "Understanding leads to consensus on solutions. Economic incentives can be aligned with climate action. Stakeholders will act against immediate self-interest for long-term benefit."
                    }
                  ],
                  "yPosition": 119.125,
                  "color": "#fdf2cc"
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "stakeholder-alignment",
                  "title": "Widespread stakeholder alignment",
                  "text": "Key stakeholders aligned on approach and solutions",
                  "connectionIds": [
                    "gov-policy"
                  ],
                  "connections": [
                    {
                      "targetId": "gov-policy",
                      "confidence": 6,
                      "evidence": "Climate stakeholder coalitions frequently fragment when specific policies are proposed. Industry groups often capture or co-opt stakeholder processes.",
                      "assumptions": "Stakeholder alignment translates to political pressure. Aligned stakeholders have sufficient political influence. Government responds to stakeholder pressure over industry lobbying."
                    }
                  ],
                  "yPosition": 119.125,
                  "color": "#fdf2cc"
                },
                {
                  "id": "tech-viability",
                  "title": "Proven tech viability",
                  "text": "Technology proven to be viable and scalable",
                  "connectionIds": [
                    "firm-standards"
                  ],
                  "connections": [
                    {
                      "targetId": "firm-standards",
                      "confidence": 14,
                      "evidence": "Corporate adoption of unproven climate tech extremely conservative. Regulatory uncertainty deters private investment. First-mover disadvantage strong in climate tech.",
                      "assumptions": "Firms will adopt new technology without regulatory mandates. Early adopters won't be disadvantaged competitively. Market signals sufficient to drive widespread adoption."
                    }
                  ],
                  "yPosition": 334.75,
                  "color": "#fdf2cc"
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "gov-policy",
                  "title": "Gov't adopts new policy",
                  "text": "Government implements supportive policy framework",
                  "connectionIds": [
                    "carbon-targets"
                  ],
                  "connections": [
                    {
                      "targetId": "carbon-targets",
                      "confidence": 11,
                      "evidence": "Climate policies routinely weakened during implementation. International coordination on climate targets consistently fails. Political cycles interrupt long-term climate commitments.",
                      "assumptions": "Policy frameworks will be implemented as designed. International coordination achievable despite conflicting national interests. Political commitment survives electoral cycles."
                    }
                  ],
                  "yPosition": 25.75,
                  "color": "#d9d2e9"
                },
                {
                  "id": "firm-standards",
                  "title": "Large firms change standards",
                  "text": "Major corporations adopt new standards and practices",
                  "connectionIds": [
                    "carbon-targets"
                  ],
                  "connections": [
                    {
                      "targetId": "carbon-targets",
                      "confidence": 9,
                      "evidence": "Corporate climate commitments often lack binding enforcement. Greenwashing widespread with minimal actual emission reductions. Market pressures consistently override environmental commitments.",
                      "assumptions": "Corporate commitments translate to actual emissions reductions. Market incentives align with climate targets. Firms will accept reduced profitability for climate goals."
                    }
                  ],
                  "yPosition": 320.125,
                  "color": "#d9d2e9"
                }
              ]
            }
          ]
        },
        {
          "title": "End Goal",
          "columns": [
            {
              "nodes": [
                {
                  "id": "carbon-targets",
                  "title": "National carbon targets achieved",
                  "text": "Country achieves its carbon reduction targets",
                  "connectionIds": [
                    "climate-future"
                  ],
                  "connections": [
                    {
                      "targetId": "climate-future",
                      "confidence": 7,
                      "evidence": "No major economy currently on track to meet climate commitments. Carbon accounting often manipulated through offsets and creative accounting. Rebound effects regularly negate efficiency gains.",
                      "assumptions": "Measured emission reductions represent real atmospheric impact. Global coordination prevents carbon leakage. Climate targets reflect actual atmospheric requirements rather than political feasibility."
                    }
                  ],
                  "yPosition": 162.125,
                  "color": "#e3e3e3"
                }
              ]
            }
          ]
        },
        {
          "title": "End Mission",
          "columns": [
            {
              "nodes": [
                {
                  "id": "climate-future",
                  "title": "Climate-resilient future",
                  "text": "A sustainable, climate-resilient future is achieved",
                  "connectionIds": [],
                  "connections": [],
                  "yPosition": 176.75,
                  "color": "#e3e3e3"
                }
              ]
            }
          ]
        }
      ],
      "textSize": 1.3,
      "curvature": 0.5,
    }
  },
}

export const CharityEntrepreneurship: Story = {
  args: {
    data: {
      "sections": [
        {
          "title": "Inputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "research",
                  "title": "Extensive research into promising ideas for new charities",
                  "text": "Find out more about our extensive research into promising charity ideas at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "reports"
                  ],
                  "connections": [
                    {
                      "targetId": "reports",
                      "confidence": 85,
                      "evidence": "Corroboration of several recommendations by GiveWell and OpenPhilanthropy. Strong track record of CE's incubated charities with no diminishing performance over time.",
                      "assumptions": "Researcher skills, time and available information are sufficient to make recommendations worth following. The pool of shovel-ready ideas is not exhausted."
                    }
                  ],
                  "yPosition": 30.25,
                  "width": 240,
                  "color": "#ffb8ca"
                },
                {
                  "id": "outreach",
                  "title": "Outreach to encourage talented individuals to apply to the program",
                  "text": "Find out more about our outreach and application process at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "cohorts"
                  ],
                  "connections": [
                    {
                      "targetId": "cohorts",
                      "confidence": 75,
                      "evidence": "Historical data showing consistent ~20 suitable candidates from ~3000 applications annually.",
                      "assumptions": "Talent pool is not exhausted and outreach continues to attract quality applicants. Selection criteria accurately identify entrepreneurship potential."
                    }
                  ],
                  "yPosition": 146.64999389648438,
                  "width": 240,
                  "color": "#b96374"
                },
                {
                  "id": "vetting",
                  "title": "Rigorous vetting to identify the most promising applicants",
                  "text": "Find out more about our rigorous vetting process at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "cohorts"
                  ],
                  "connections": [
                    {
                      "targetId": "cohorts",
                      "confidence": 88,
                      "evidence": "Vetting scores show 0.7 correlation with internal estimates of charity impact, demonstrating predictive validity of the selection process.",
                      "assumptions": "Vetting process accurately identifies suitable applicants. Selected co-founders wouldn't have had greater impact elsewhere."
                    }
                  ],
                  "yPosition": 258.12091064453125,
                  "width": 240,
                  "color": "#b96374"
                },
                {
                  "id": "training",
                  "title": "Improve and facilitate training program to launch an effective charity",
                  "text": "Find out more about our training programs for charity founders at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "programs"
                  ],
                  "connections": [
                    {
                      "targetId": "programs",
                      "confidence": 82,
                      "evidence": "Successful scaling to two programs per year while maintaining quality standards. Consistent program delivery track record.",
                      "assumptions": "Running two Incubation Programs per year is sustainable at equal or higher quality. New program types can be integrated without compromising existing quality."
                    }
                  ],
                  "yPosition": 375.25,
                  "width": 240,
                  "color": "#a63247"
                },
                {
                  "id": "funder-outreach",
                  "title": "Outreach to intelligent, value aligned funders to join seed network",
                  "text": "Find out more about our funder outreach and seed network at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "seed-network"
                  ],
                  "connections": [
                    {
                      "targetId": "seed-network",
                      "confidence": 50,
                      "evidence": "83% of applications funded in last 3 programs (94% for CE recommended charity ideas). Average funding of $120k demonstrates strong funder commitment.",
                      "assumptions": "Funding landscape can support ~10 new charities per year across cause areas, even in economic downturns. CE's reputation attracts sufficient high-quality funders."
                    }
                  ],
                  "yPosition": 496.25,
                  "width": 240,
                  "color": "#944050"
                }
              ]
            }
          ]
        },
        {
          "title": "Outputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "reports",
                  "title": "Reports recommending excellent ideas for new charities to launch",
                  "text": "Find out more about our charity recommendation reports at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "plans"
                  ],
                  "connections": [
                    {
                      "targetId": "plans",
                      "confidence": 20,
                      "evidence": "Historical correlation between quality research reports and successful business plan submissions. Report recommendations have been validated by external organizations.",
                      "assumptions": "Recommended ideas are diverse enough for founders with different preferences. Quality research translates to actionable charity ideas."
                    }
                  ],
                  "yPosition": 30.25,
                  "width": 224,
                  "color": "#ffb8ca"
                },
                {
                  "id": "cohorts",
                  "title": "Cohorts of talented participants are a good fit for entrepreneurship",
                  "text": "Find out more about our entrepreneurship cohorts at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "plans"
                  ],
                  "connections": [
                    {
                      "targetId": "plans",
                      "confidence": 70,
                      "evidence": "62% of participants founded after the last 3 programs, indicating strong conversion from cohort participation to plan development.",
                      "assumptions": "Facilitation leads to strong co-founder & idea combinations. Teaching equips participants with necessary knowledge and support for success."
                    }
                  ],
                  "yPosition": 199.25,
                  "width": 224,
                  "color": "#b96374"
                },
                {
                  "id": "programs",
                  "title": "Programs occur multiple times a year",
                  "text": "Find out more about our year-round programs at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "plans"
                  ],
                  "connections": [
                    {
                      "targetId": "plans",
                      "confidence": 65,
                      "evidence": "62% of participants founded after the last 3 programs. Consistent program delivery demonstrates scalability.",
                      "assumptions": "Teaching effectively equips participants with knowledge and support needed for smart launch plans and field success."
                    }
                  ],
                  "yPosition": 386.5,
                  "width": 224,
                  "color": "#a63247"
                },
                {
                  "id": "seed-network",
                  "title": "Seed network with the resources and good judgement to fund deserving proposals",
                  "text": "Find out more about our seed funding network at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "new-charities"
                  ],
                  "connections": [
                    {
                      "targetId": "new-charities",
                      "confidence": 92,
                      "evidence": "83% of applications funded in last 3 programs (94% for CE recommended charity ideas). Average funding of $120k demonstrates robust funding capacity.",
                      "assumptions": "Seed network has sufficient resources and maintains good judgment in funding decisions. Funded proposals translate to operational charities."
                    }
                  ],
                  "yPosition": 485,
                  "width": 224,
                  "color": "#944050"
                }
              ]
            }
          ]
        },
        {
          "title": "Outcomes",
          "columns": [
            {
              "nodes": [
                {
                  "id": "plans",
                  "title": "Incubatees form co-founder teams & submit high quality plans to the seed network for funding",
                  "text": "Find out more about our co-founder matching and funding process at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "new-charities"
                  ],
                  "connections": [
                    {
                      "targetId": "new-charities",
                      "confidence": 85,
                      "evidence": "High follow-through rate from plan submission to charity launch. Seed network's selective funding approach ensures quality.",
                      "assumptions": "Seed network only funds teams with high expected counterfactual impact. Funded co-founder teams follow through on launching charities."
                    }
                  ],
                  "yPosition": 154.25,
                  "color": "#7f1c31",
                  "width": 160
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "new-charities",
                  "title": "New effective charities exist, some of which wouldn't have otherwise",
                  "text": "Find out more about the new effective charities we've launched at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "impactful-programs"
                  ],
                  "connections": [
                    {
                      "targetId": "impactful-programs",
                      "confidence": 60,
                      "evidence": "Track record of launched charities demonstrates successful transition from funding to operational programs. Portfolio performance shows sustainability.",
                      "assumptions": "Charities can secure funding through the 'valley of death' phase. Organizations and co-founders maintain their values and don't succumb to mission drift."
                    }
                  ],
                  "yPosition": 300.75,
                  "color": "#7f1c31",
                  "width": 160
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "impactful-programs",
                  "title": "Charities execute counterfactually impactful programs",
                  "text": "Find out more about our charities' impactful programs at https://www.charityentrepreneurship.com/",
                  "connectionIds": [
                    "wellbeing"
                  ],
                  "connections": [
                    {
                      "targetId": "wellbeing",
                      "confidence": 88,
                      "evidence": "~40% of charities are field leading based on internal assessments, public M&E results, endorsements from GiveWell and OpenPhilanthropy, and 11 positive external evaluations (11/11 positive rate).",
                      "assumptions": "Impactful programs translate directly to improved wellbeing outcomes. Cost-effectiveness assessments accurately predict real-world impact."
                    }
                  ],
                  "yPosition": 300.75,
                  "color": "#7f1c31",
                  "width": 160
                }
              ]
            }
          ]
        },
        {
          "title": "Goal",
          "columns": [
            {
              "nodes": [
                {
                  "id": "wellbeing",
                  "title": "Improved well being for humans and animals",
                  "text": "Find out more about improving wellbeing for humans and animals at https://www.charityentrepreneurship.com/",
                  "connectionIds": [],
                  "connections": [],
                  "yPosition": 312,
                  "color": "#7f1c31",
                  "width": 160
                }
              ]
            }
          ]
        }
      ],
      "textSize": 1,
      "curvature": 1,
    }
  },
}