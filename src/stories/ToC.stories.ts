import type { Meta, StoryObj } from "@storybook/react"
import { ToC } from "../components/TheoryOfChangeGraph"

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
                  "yPosition": 105.55625915527344,
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
                  "yPosition": 349.375,
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
                  "yPosition": 153.75,
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
                  "yPosition": 349.375,
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
                  "yPosition": 139.125,
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
                  "yPosition": 139.125,
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
                  "yPosition": 374.75,
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
                  "yPosition": 360.125,
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
                  "yPosition": 182.125,
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
                  "yPosition": 196.75,
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
                  "yPosition": 10.25,
                  "width": 224,
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
                  "width": 224,
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
                  "yPosition": 278.12091064453125,
                  "width": 224,
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
                  "yPosition": 410,
                  "width": 224,
                  "color": "#a63247"
                },
                {
                  "id": "funder-outreach",
                  "title": "Outreach to intelligent, value-aligned funders to join seed network",
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
                  "yPosition": 566.25,
                  "width": 224,
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
                  "yPosition": 10.25,
                  "width": 224,
                  "color": "#ffb8ca"
                },
                {
                  "id": "cohorts",
                  "title": "Cohorts of talented participants who are a good fit for entrepreneurship",
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
                  "yPosition": 198,
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
                  "yPosition": 432.5,
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
                      "confidence": 94,
                      "evidence": "83% of applications funded in last 3 programs (94% for CE recommended charity ideas). Average funding of $120k demonstrates robust funding capacity.",
                      "assumptions": "Seed network has sufficient resources and maintains good judgment in funding decisions. Funded proposals translate to operational charities."
                    }
                  ],
                  "yPosition": 555,
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
                  "title": "Incubatees form strong co-founder teams & submit high quality launch plans to the seed network for funding",
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
                  "yPosition": 153,
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
                  "yPosition": 320.75,
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
                  "yPosition": 320.75,
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
                  "title": "Improved wellbeing for humans and animals",
                  "text": "Find out more about improving wellbeing for humans and animals at https://www.charityentrepreneurship.com/",
                  "connectionIds": [],
                  "connections": [],
                  "yPosition": 332,
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

export const OpenPhilEffectiveGiving: Story = {
  args: {
    data: {
      "sections": [
        {
          "title": "Inputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "program-funding",
                  "title": "Program Funding",
                  "text": "$15-20 million annually for effective giving and careers initiatives",
                  "connectionIds": [
                    "funded-orgs"
                  ],
                  "connections": [
                    {
                      "targetId": "funded-orgs",
                      "confidence": 70,
                      "evidence": "Clear budget allocation and existing grantee relationships. OpenPhil has sustained funding track record.",
                      "assumptions": "Funding will be sustained long-term through economic cycles. Effective grantee selection continues. Grantees use funds effectively for intended purposes."
                    }
                  ],
                  "yPosition": 20.265625,
                  "color": "#e6f3ff",
                  "width": 160
                },
                {
                  "id": "program-staff",
                  "title": "Program Staff",
                  "text": "Dedicated program officers specializing in meta-interventions",
                  "connectionIds": [
                    "individual-outreach",
                    "research-pubs",
                    "educational-content"
                  ],
                  "connections": [
                    {
                      "targetId": "individual-outreach",
                      "confidence": 80,
                      "evidence": "Direct operational control with dedicated specialized staff.",
                      "assumptions": "Staff expertise sufficient for effective outreach. Target audiences reachable and responsive. Outreach methods remain effective over time."
                    },
                    {
                      "targetId": "research-pubs",
                      "confidence": 75,
                      "evidence": "Program officers have research background and institutional support.",
                      "assumptions": "Staff capacity adequate for research alongside operational duties. Research findings will be actionable and influential."
                    },
                    {
                      "targetId": "educational-content",
                      "confidence": 72,
                      "evidence": "Program staff have expertise to create educational materials and direct operational control over content development.",
                      "assumptions": "Staff have time and skills for content creation alongside other duties. Educational content remains current and high-quality over time."
                    }
                  ],
                  "yPosition": 383.6328125,
                  "color": "#e6f3ff",
                  "width": 160
                },
                {
                  "id": "grantee-orgs",
                  "title": "Grantee Organizations",
                  "text": "Partnerships with effective giving organizations like GiveWell, Giving What We Can",
                  "connectionIds": [
                    "community-building",
                    "educational-content"
                  ],
                  "connections": [
                    {
                      "targetId": "community-building",
                      "confidence": 85,
                      "evidence": "Established partnerships with proven effective giving organizations. Track record of successful collaboration.",
                      "assumptions": "Grantee organizations maintain effectiveness and alignment. Community-building activities translate to sustained engagement."
                    },
                    {
                      "targetId": "educational-content",
                      "confidence": 75,
                      "evidence": "Grantee organizations like GiveWell and GWWC already produce substantial educational content as core activities.",
                      "assumptions": "Grantee organizations will create content aligned with OpenPhil's goals. Content quality and messaging remain consistent across organizations."
                    }
                  ],
                  "yPosition": 605.265625,
                  "color": "#e6f3ff",
                  "width": 160
                },
                {
                  "id": "network-access",
                  "title": "Network Access",
                  "text": "Connections to high-net-worth individuals, professionals, and career changers",
                  "connectionIds": [
                    "individual-outreach",
                    "donor-cultivation"
                  ],
                  "connections": [
                    {
                      "targetId": "individual-outreach",
                      "confidence": 65,
                      "evidence": "OpenPhil's reputation and existing networks provide access to target demographics.",
                      "assumptions": "Network access translates to engagement. High-net-worth individuals open to evidence-based giving approaches."
                    },
                    {
                      "targetId": "donor-cultivation",
                      "confidence": 60,
                      "evidence": "Network connections provide potential donor pipeline.",
                      "assumptions": "Personal networks can be systematically cultivated for effective giving. Wealthy individuals responsive to peer influence."
                    }
                  ],
                  "yPosition": 192.265625,
                  "color": "#e6f3ff",
                  "width": 160
                },
                {
                  "id": "research-infrastructure",
                  "title": "Research Infrastructure",
                  "text": "Analysis systems for giving patterns, career impact, and movement research",
                  "connectionIds": [
                    "research-pubs"
                  ],
                  "connections": [
                    {
                      "targetId": "research-pubs",
                      "confidence": 78,
                      "evidence": "Existing infrastructure and methodological expertise for impact assessment.",
                      "assumptions": "Research infrastructure can scale with program growth. Analysis methods accurately capture real-world impact patterns."
                    }
                  ],
                  "yPosition": 490.265625,
                  "color": "#e6f3ff",
                  "width": 160
                }
              ]
            },
            {
              "nodes": []
            },
            {
              "nodes": []
            }
          ]
        },
        {
          "title": "Outputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "funded-orgs",
                  "title": "Funded Organizations",
                  "text": "Sustained support for effective giving organizations and career guidance platforms",
                  "connectionIds": [
                    "increased-donations"
                  ],
                  "connections": [
                    {
                      "targetId": "increased-donations",
                      "confidence": 65,
                      "evidence": "Grantee organizations like GiveWell have demonstrated track record of influencing donations.",
                      "assumptions": "Funded organizations can effectively convert their resources into additional donations. Marginal funding increases organizational impact rather than displacing existing funding."
                    }
                  ],
                  "yPosition": 20.265625,
                  "color": "#ccf2ff"
                },
                {
                  "id": "individual-outreach",
                  "title": "Individual Outreach",
                  "text": "Programs reaching potential effective givers and career changers",
                  "connectionIds": [
                    "career-multiplication",
                    "increased-donations"
                  ],
                  "connections": [
                    {
                      "targetId": "career-multiplication",
                      "confidence": 40,
                      "evidence": "80,000 Hours data shows career guidance can influence career choices, though impact varies widely.",
                      "assumptions": "Individual outreach translates to actual career changes. Career advice recipients make optimal use of guidance. High-impact careers remain available for career changers."
                    },
                    {
                      "targetId": "increased-donations",
                      "confidence": 50,
                      "evidence": "Some evidence from giving pledges and GiveWell donors, but attribution challenging.",
                      "assumptions": "Outreach reaches people who wouldn't otherwise donate effectively. Giving behavior changes persist over time."
                    }
                  ],
                  "yPosition": 254.265625,
                  "color": "#ccf2ff"
                },
                {
                  "id": "educational-content",
                  "title": "Educational Content",
                  "text": "Resources on effective giving principles and high-impact career paths",
                  "connectionIds": [
                    "movement-growth"
                  ],
                  "connections": [
                    {
                      "targetId": "movement-growth",
                      "confidence": 45,
                      "evidence": "Educational content has reach metrics but behavior change attribution is limited.",
                      "assumptions": "Content reaches target audiences effectively. Educational material translates to belief and behavior changes. Content quality maintains over scaled production."
                    }
                  ],
                  "yPosition": 490.265625,
                  "color": "#ccf2ff"
                },
                {
                  "id": "research-pubs",
                  "title": "Research Publications",
                  "text": "Analysis of giving patterns, career impact, and movement growth",
                  "connectionIds": [
                    "institutional-adoption"
                  ],
                  "connections": [
                    {
                      "targetId": "institutional-adoption",
                      "confidence": 35,
                      "evidence": "Academic and policy research has mixed track record of institutional influence. EA research has limited mainstream penetration.",
                      "assumptions": "Institutional decision-makers read and are influenced by research. Research findings support effectiveness-focused approaches. Academic credibility translates to policy influence."
                    }
                  ],
                  "yPosition": 371.265625,
                  "color": "#ccf2ff"
                },
                {
                  "id": "community-building",
                  "title": "Community Building",
                  "text": "Networks and platforms connecting effective altruists and career changers",
                  "connectionIds": [
                    "movement-growth"
                  ],
                  "connections": [
                    {
                      "targetId": "movement-growth",
                      "confidence": 70,
                      "evidence": "EA community has grown substantially with clear community-building activities driving engagement.",
                      "assumptions": "Community growth translates to increased impact rather than just social activity. Community maintains quality and effectiveness focus while scaling."
                    }
                  ],
                  "yPosition": 715.04541015625,
                  "color": "#ccf2ff"
                },
                {
                  "id": "donor-cultivation",
                  "title": "Donor Cultivation",
                  "text": "Targeted outreach to high-capacity potential effective givers",
                  "connectionIds": [
                    "increased-donations"
                  ],
                  "connections": [
                    {
                      "targetId": "increased-donations",
                      "confidence": 55,
                      "evidence": "Some success stories in major donor cultivation, though systematic evidence limited.",
                      "assumptions": "High-net-worth individuals responsive to cultivation efforts. Personal relationships translate to sustained giving commitments. Cultivation scales without diminishing returns."
                    }
                  ],
                  "yPosition": 142.6328125,
                  "color": "#ccf2ff"
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
                  "id": "increased-donations",
                  "title": "Increased Effective Donations",
                  "text": "Significant growth in donations to highly effective charities",
                  "connectionIds": [
                    "leverage-effects"
                  ],
                  "connections": [
                    {
                      "targetId": "leverage-effects",
                      "confidence": 65,
                      "evidence": "GiveWell and other EA organizations have tracked substantial money moved. Some documented cases of high leverage ratios.",
                      "assumptions": "Additional donations represent truly marginal impact rather than displacing other giving. Donated money is used effectively by recipient organizations."
                    }
                  ],
                  "yPosition": 130.265625,
                  "color": "#b3e0ff",
                  "width": 192
                },
                {
                  "id": "career-multiplication",
                  "title": "Career Impact Multiplication",
                  "text": "More professionals working in or supporting high-impact sectors",
                  "connectionIds": [
                    "leverage-effects"
                  ],
                  "connections": [
                    {
                      "targetId": "leverage-effects",
                      "confidence": 45,
                      "evidence": "Some career transitions documented but systematic impact measurement challenging. Long-term outcomes uncertain.",
                      "assumptions": "Career changes generate higher impact than previous career paths. High-impact sectors can absorb additional talent effectively. Career advice recipients optimize their impact within chosen paths."
                    }
                  ],
                  "yPosition": 254.265625,
                  "color": "#b3e0ff",
                  "width": 176
                },
                {
                  "id": "movement-growth",
                  "title": "Movement Growth",
                  "text": "Expansion of the effective altruism and effective giving movements",
                  "connectionIds": [
                    "cultural-shift"
                  ],
                  "connections": [
                    {
                      "targetId": "cultural-shift",
                      "confidence": 55,
                      "evidence": "EA movement has grown but mainstream cultural influence remains limited. Some indication of broader awareness.",
                      "assumptions": "Movement growth translates to broader cultural influence. Growing movement maintains effectiveness focus rather than diluting principles."
                    }
                  ],
                  "yPosition": 605.265625,
                  "color": "#b3e0ff",
                  "width": 176
                },
                {
                  "id": "institutional-adoption",
                  "title": "Institutional Adoption",
                  "text": "Organizations and foundations adopting effectiveness-focused giving approaches",
                  "connectionIds": [
                    "cultural-shift"
                  ],
                  "connections": [
                    {
                      "targetId": "cultural-shift",
                      "confidence": 30,
                      "evidence": "Limited examples of major institutional adoption. Most philanthropic institutions remain traditional in approach.",
                      "assumptions": "Institutional changes spread through sector influence. Organizations implement effectiveness approaches authentically rather than superficially. Institutional adoption survives leadership changes."
                    }
                  ],
                  "yPosition": 371.265625,
                  "color": "#b3e0ff",
                  "width": 176
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "cultural-shift",
                  "title": "Cultural Shift",
                  "text": "Broader acceptance of impact-focused giving and career choices",
                  "connectionIds": [
                    "leverage-effects"
                  ],
                  "connections": [
                    {
                      "targetId": "leverage-effects",
                      "confidence": 25,
                      "evidence": "Cultural change in philanthropy historically slow. Limited mainstream adoption of EA principles to date.",
                      "assumptions": "Cultural shifts can be accelerated through targeted interventions. Broader culture will adopt effectiveness focus without losing other important values. Cultural change translates to resource allocation changes."
                    }
                  ],
                  "yPosition": 502.6328125,
                  "color": "#99d6ff"
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
                  "id": "leverage-effects",
                  "title": "Leverage Effects",
                  "text": "Each dollar spent generating 5-50x in additional effective giving and career impact",
                  "connectionIds": [
                    "self-sustaining-ecosystem"
                  ],
                  "connections": [
                    {
                      "targetId": "self-sustaining-ecosystem",
                      "confidence": 40,
                      "evidence": "Some documented cases of high leverage ratios, though systematic measurement challenging. Historical precedent for meta-interventions scaling.",
                      "assumptions": "Leverage effects compound rather than diminish over time. High leverage ratios can be maintained at scale. Meta-interventions don't hit saturation points."
                    }
                  ],
                  "yPosition": 266.6328125,
                  "color": "#80ccff"
                }
              ]
            }
          ]
        },
        {
          "title": "Mission",
          "columns": [
            {
              "nodes": [
                {
                  "id": "self-sustaining-ecosystem",
                  "title": "Self-sustaining Ecosystem",
                  "text": "Effective giving and high-impact careers become mainstream, directing billions toward pressing problems",
                  "connectionIds": [],
                  "connections": [],
                  "yPosition": 254.265625,
                  "color": "#66c2ff"
                }
              ]
            }
          ]
        }
      ],
      "textSize": 1.1,
      "curvature": 0.5,
    }
  },
}

export const AdversarialOpenPhilEffectiveGiving: Story = {
  args: {
    data: {
      "sections": [
        {
          "title": "Inputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "systematic-research",
                  "title": "Rigorous comparative research on intervention effectiveness",
                  "text": "Systematic evaluation of charitable interventions using RCTs, quasi-experimental methods, and meta-analysis where available",
                  "connectionIds": [
                    "evidence-base"
                  ],
                  "connections": [
                    {
                      "targetId": "evidence-base",
                      "confidence": 75,
                      "evidence": "GiveWell's methodology has been validated by external evaluators and correlates with independent effectiveness assessments. Research quality has improved over 10+ years of iteration.",
                      "assumptions": "Comparative research can identify effectiveness differences between interventions. External validation provides meaningful quality control. Past performance predicts future research quality."
                    }
                  ],
                  "yPosition": 28.25,
                  "width": 224,
                  "color": "#f1f2f6"
                },
                {
                  "id": "targeted-outreach",
                  "title": "Evidence-based outreach to high-capacity donors",
                  "text": "Focused engagement with individuals who have both capacity and stated interest in maximizing their social impact",
                  "connectionIds": [
                    "influenced-donors"
                  ],
                  "connections": [
                    {
                      "targetId": "influenced-donors",
                      "confidence": 60,
                      "evidence": "RCT showing 15% increase in effective giving rates sustained at 12 months. Natural experiments show 2-3x higher effective giving rates in areas with EA presence.",
                      "assumptions": "Randomized trial results generalize to broader population. Effects persist beyond measured timeframes. Natural experiment controls for confounding factors."
                    }
                  ],
                  "yPosition": 194.25,
                  "width": 224,
                  "color": "#263046"
                },
                {
                  "id": "measurement-systems",
                  "title": "Robust monitoring and evaluation infrastructure",
                  "text": "Systems for tracking donation flows, career transitions, and intermediate impact indicators with external validation where possible",
                  "connectionIds": [
                    "accountability"
                  ],
                  "connections": [
                    {
                      "targetId": "accountability",
                      "confidence": 70,
                      "evidence": "Independent evaluation by third parties confirms methodology validity. Public reporting of success rates including failures provides transparency.",
                      "assumptions": "External evaluators remain independent despite ecosystem connections. Measurement systems capture meaningful indicators of progress. Transparency enables course correction."
                    }
                  ],
                  "yPosition": 382.25,
                  "width": 224,
                  "color": "#445277"
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
                  "id": "evidence-base",
                  "title": "Publicly available comparative effectiveness research",
                  "text": "Research publications comparing intervention cost-effectiveness with explicit methodology and uncertainty quantification",
                  "connectionIds": [
                    "informed-decisions"
                  ],
                  "connections": [
                    {
                      "targetId": "informed-decisions",
                      "confidence": 50,
                      "evidence": "Donor surveys indicate 73% credit GiveWell research with donation decisions. However, attribution is self-reported and may reflect post-hoc rationalization.",
                      "assumptions": "Research quality translates to decision quality. Self-reported attribution reflects genuine causal influence. Information availability improves resource allocation."
                    }
                  ],
                  "yPosition": 28.25,
                  "width": 224,
                  "color": "#f1f2f6"
                },
                {
                  "id": "influenced-donors",
                  "title": "Donors with increased effective giving behavior",
                  "text": "Individuals who have demonstrably increased their donations to cost-effective interventions following exposure to effectiveness information",
                  "connectionIds": [
                    "redirected-resources"
                  ],
                  "connections": [
                    {
                      "targetId": "redirected-resources",
                      "confidence": 65,
                      "evidence": "Tracked donation flows show $600M+ directed to GiveWell-recommended organizations. Verification through public records where available.",
                      "assumptions": "Donation tracking accurately captures influenced giving. Recommended organizations maintain effectiveness at scale. Resources are genuinely additional rather than substituted."
                    }
                  ],
                  "yPosition": 194.25,
                  "width": 224,
                  "color": "#263046"
                },
                {
                  "id": "accountability",
                  "title": "Transparent reporting of outcomes including failures",
                  "text": "Public documentation of intervention success rates, cost-effectiveness changes over time, and discontinued programs",
                  "connectionIds": [
                    "course-correction"
                  ],
                  "connections": [
                    {
                      "targetId": "course-correction",
                      "confidence": 80,
                      "evidence": "Observable strategy changes in response to evidence: reduced deworming support, increased AI safety investment, added criminal justice reform.",
                      "assumptions": "Transparency enables effective learning and adaptation. Public reporting creates accountability pressure for improvement. Course corrections improve future performance."
                    }
                  ],
                  "yPosition": 382.25,
                  "width": 224,
                  "color": "#445277"
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
                  "id": "informed-decisions",
                  "title": "Charitable resource allocation based on comparative effectiveness",
                  "text": "Donors making giving decisions with access to rigorous comparative information about intervention effectiveness",
                  "connectionIds": [
                    "improved-interventions"
                  ],
                  "connections": [
                    {
                      "targetId": "improved-interventions",
                      "confidence": 40,
                      "evidence": "Limited and contested. Some evidence that GiveWell-recommended organizations outperform alternatives, but comparative studies are few and subject to selection bias.",
                      "assumptions": "Comparative effectiveness information improves allocation decisions. Donors act on available information. Better information leads to better outcomes."
                    }
                  ],
                  "yPosition": 17,
                  "color": "#6e7ca0",
                  "width": 224
                },
                {
                  "id": "redirected-resources",
                  "title": "Philanthropic resources flowing to higher-impact interventions",
                  "text": "Measurable increase in funding for interventions with stronger evidence bases and cost-effectiveness ratios",
                  "connectionIds": [
                    "scaled-solutions"
                  ],
                  "connections": [
                    {
                      "targetId": "scaled-solutions",
                      "confidence": 55,
                      "evidence": "AMF malaria net distribution scaled 500% following GiveWell recommendation. Consistent health outcome improvements in areas with high coverage.",
                      "assumptions": "Resource redirection is genuinely additional. Scaled interventions maintain effectiveness. Health improvements persist over time."
                    }
                  ],
                  "yPosition": 194.25,
                  "color": "#6e7ca0",
                  "width": 224
                },
                {
                  "id": "course-correction",
                  "title": "Adaptive strategy based on performance measurement",
                  "text": "Systematic adjustment of approaches based on evidence of success and failure rates",
                  "connectionIds": [
                    "improved-methodology"
                  ],
                  "connections": [
                    {
                      "targetId": "improved-methodology",
                      "confidence": 70,
                      "evidence": "Observable methodology improvements over time. External validation of evaluation approaches. Documented strategy changes in response to evidence.",
                      "assumptions": "Learning from failures improves future performance. Measurement systems capture meaningful performance indicators. Adaptation occurs faster than environmental change."
                    }
                  ],
                  "yPosition": 382.25,
                  "color": "#6e7ca0",
                  "width": 224
                }
              ]
            },
            {
              "nodes": []
            },
            {
              "nodes": []
            }
          ]
        },
        {
          "title": "Goals",
          "columns": [
            {
              "nodes": [
                {
                  "id": "improved-interventions",
                  "title": "Demonstrably more effective charitable interventions at scale",
                  "text": "Interventions that deliver measurably better outcomes per dollar invested, verified through independent evaluation",
                  "connectionIds": [
                    "welfare-improvements"
                  ],
                  "connections": [
                    {
                      "targetId": "welfare-improvements",
                      "confidence": 60,
                      "evidence": "Global health interventions show measurable impact: malaria mortality reduction, increased immunization coverage, improved nutritional outcomes in target populations.",
                      "assumptions": "Measured health improvements translate to broader welfare gains. Intervention effects persist without continued support. Benefits outweigh any negative unintended consequences."
                    }
                  ],
                  "yPosition": 28.25,
                  "color": "#6e7ca0",
                  "width": 224
                },
                {
                  "id": "scaled-solutions",
                  "title": "Cost-effective interventions implemented at sufficient scale to address problems",
                  "text": "Proven interventions reaching the population scale necessary to make meaningful progress on targeted problems",
                  "connectionIds": [
                    "welfare-improvements"
                  ],
                  "connections": [
                    {
                      "targetId": "welfare-improvements",
                      "confidence": 65,
                      "evidence": "200+ million malaria nets distributed through AMF and similar organizations. Estimated 120,000+ lives saved based on conservative modeling.",
                      "assumptions": "Scale estimates are accurate. Life-saving estimates account for displacement effects and diminishing returns. Scale achieved is sufficient for meaningful problem reduction."
                    }
                  ],
                  "yPosition": 171.75,
                  "color": "#6e7ca0",
                  "width": 224
                },
                {
                  "id": "improved-methodology",
                  "title": "More rigorous approaches to charitable evaluation and allocation",
                  "text": "Systematic methods for comparing interventions that improve over time through learning and external critique",
                  "connectionIds": [
                    "welfare-improvements"
                  ],
                  "connections": [
                    {
                      "targetId": "welfare-improvements",
                      "confidence": 45,
                      "evidence": "Mixed and limited evidence. Some improvements in evaluation rigor, but fundamental methodological challenges remain. Unclear whether methodological improvements translate to better outcomes.",
                      "assumptions": "Better evaluation methods lead to better intervention selection. Methodological improvements compound over time. Evaluation advances transfer to other domains."
                    }
                  ],
                  "yPosition": 371,
                  "color": "#6e7ca0",
                  "width": 224
                }
              ]
            },
            {
              "nodes": []
            },
            {
              "nodes": []
            }
          ]
        },
        {
          "title": "Ultimate Impact",
          "columns": [
            {
              "nodes": [
                {
                  "id": "welfare-improvements",
                  "title": "Measurable improvements in human welfare and reduced suffering",
                  "text": "Demonstrable reductions in preventable deaths, disease burden, and other forms of measurable suffering",
                  "connectionIds": [],
                  "connections": [],
                  "yPosition": 194.25,
                  "color": "#6e7ca0",
                  "width": 288
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

export const AnimalCharityEvaluators: Story = {
  args: {
    data: {
      "sections": [
        {
          "title": "Inputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "research-capacity",
                  "title": "Limited research capacity with systematic methodology development",
                  "text": "Imperfect but structured research capabilities focused on continuous methodological improvement",
                  "connectionIds": [
                    "evaluation-frameworks"
                  ],
                  "connections": [
                    {
                      "targetId": "evaluation-frameworks",
                      "confidence": 65,
                      "evidence": "Historical development of evaluation methodologies in other fields shows iterative improvement possible, though animal welfare evaluation faces unique challenges",
                      "assumptions": "Research staff can develop domain expertise faster than biases accumulate. Systematic approaches provide value over intuition despite limitations."
                    }
                  ],
                  "yPosition": 8.205703735351562,
                  "width": 224,
                  "color": "#00a6a1"
                },
                {
                  "id": "expert-networks",
                  "title": "Access to animal welfare researchers and practitioners",
                  "text": "Relationships with field experts for validation and feedback, with awareness of potential bias",
                  "connectionIds": [
                    "evaluation-frameworks"
                  ],
                  "connections": [
                    {
                      "targetId": "evaluation-frameworks",
                      "confidence": 50,
                      "evidence": "Expert networks in other evaluation fields provide value through diverse perspectives, though animal welfare field is small and potentially insular",
                      "assumptions": "Experts provide honest feedback rather than confirmation of existing views. Network diversity sufficient to challenge assumptions."
                    }
                  ],
                  "yPosition": 206.29544830322266,
                  "width": 224,
                  "color": "#00a6a1"
                },
                {
                  "id": "uncertainty-tracking",
                  "title": "Systems for tracking prediction accuracy and updating methodology",
                  "text": "Mechanisms to measure recommendation performance and improve evaluation methods",
                  "connectionIds": [
                    "performance-data"
                  ],
                  "connections": [
                    {
                      "targetId": "performance-data",
                      "confidence": 40,
                      "evidence": "Limited precedent for systematic prediction tracking in nonprofit evaluation, but essential for credibility",
                      "assumptions": "Organization willing to expose and learn from failures. Sufficient resources available for performance tracking infrastructure."
                    }
                  ],
                  "yPosition": 345.2840919494629,
                  "width": 224,
                  "color": "#eef2ef"
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
                  "id": "evaluation-frameworks",
                  "title": "Explicitly uncertain evaluation frameworks with clear limitations",
                  "text": "Structured but imperfect methodologies for organizational assessment, with honest uncertainty communication",
                  "connectionIds": [
                    "conditional-recommendations"
                  ],
                  "connections": [
                    {
                      "targetId": "conditional-recommendations",
                      "confidence": 55,
                      "evidence": "Structured evaluation better than no evaluation in limited studies from other fields, though animal welfare evaluation faces unique measurement challenges",
                      "assumptions": "Frameworks capture relevant organizational characteristics. Structure improves decision-making despite imperfection."
                    }
                  ],
                  "yPosition": 99.04119873046875,
                  "width": 208,
                  "color": "#00a6a1"
                },
                {
                  "id": "performance-data",
                  "title": "Systematic tracking of recommendation accuracy and outcomes",
                  "text": "Data on how well ACE recommendations predict organizational performance over time",
                  "connectionIds": [
                    "methodology-improvement"
                  ],
                  "connections": [
                    {
                      "targetId": "methodology-improvement",
                      "confidence": 70,
                      "evidence": "Feedback loops essential for learning in complex systems, though implementation challenging",
                      "assumptions": "Organization commits to transparency about failures. Sufficient data available for meaningful pattern detection."
                    }
                  ],
                  "yPosition": 334.04119873046875,
                  "width": 208,
                  "color": "#eef2ef"
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "conditional-recommendations",
                  "title": "Conditional charity recommendations with explicit uncertainty bounds",
                  "text": "Organization assessments presented as uncertain bets rather than confident predictions",
                  "connectionIds": [
                    "informed-donor-decisions"
                  ],
                  "connections": [
                    {
                      "targetId": "informed-donor-decisions",
                      "confidence": 35,
                      "evidence": "Mixed evidence on whether more information improves donor decisions vs. causing analysis paralysis",
                      "assumptions": "Donors can process uncertainty information effectively. Explicit limitations increase rather than decrease trust."
                    }
                  ],
                  "yPosition": 99.04119873046875,
                  "width": 208,
                  "color": "#00a6a1"
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
                  "id": "informed-donor-decisions",
                  "title": "Donors make slightly better funding decisions than alternatives",
                  "text": "Marginal improvement in resource allocation compared to intuition-based or random giving",
                  "connectionIds": [
                    "marginally-better-allocation"
                  ],
                  "connections": [
                    {
                      "targetId": "marginally-better-allocation",
                      "confidence": 30,
                      "evidence": "No evidence that systematic nonprofit evaluation improves outcomes compared to alternatives in animal welfare context",
                      "assumptions": "Better-evaluated organizations actually perform better. Donor behavior changes persist over time. No negative effects from evaluation burden on organizations."
                    }
                  ],
                  "yPosition": 99.04119873046875,
                  "color": "#00a6a1",
                  "width": 192
                },
                {
                  "id": "methodology-improvement",
                  "title": "Evaluation methods improve through systematic learning",
                  "text": "ACE evaluation accuracy increases over time through performance tracking and methodology updates",
                  "connectionIds": [
                    "marginally-better-allocation"
                  ],
                  "connections": [
                    {
                      "targetId": "marginally-better-allocation",
                      "confidence": 45,
                      "evidence": "Other evaluation fields show methodological progress possible, though animal welfare presents unique challenges",
                      "assumptions": "Sufficient feedback available for learning. Organization culture supports updating beliefs based on evidence."
                    }
                  ],
                  "yPosition": 345.2840919494629,
                  "color": "#eef2ef",
                  "width": 192
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "marginally-better-allocation",
                  "title": "Marginally improved resource allocation within animal advocacy",
                  "text": "Slightly more effective distribution of limited resources, with large uncertainty about impact",
                  "connectionIds": [
                    "uncertain-welfare-impact"
                  ],
                  "connections": [
                    {
                      "targetId": "uncertain-welfare-impact",
                      "confidence": 25,
                      "evidence": "No validated connection between improved resource allocation and animal welfare outcomes in current literature",
                      "assumptions": "Current animal advocacy approaches capable of meaningful impact with better allocation. Scale of movement sufficient to affect animal welfare outcomes."
                    }
                  ],
                  "yPosition": 212.04119873046875,
                  "color": "#041c30",
                  "width": 192
                }
              ]
            },
            {
              "nodes": []
            }
          ]
        },
        {
          "title": "Goal",
          "columns": [
            {
              "nodes": [
                {
                  "id": "uncertain-welfare-impact",
                  "title": "Possible marginal reduction in animal suffering with high uncertainty",
                  "text": "Uncertain and potentially small impact on animal welfare through improved movement effectiveness",
                  "connectionIds": [],
                  "connections": [],
                  "yPosition": 212.04119873046875,
                  "color": "#041c30",
                  "width": 192
                }
              ]
            }
          ]
        }
      ],
      "textSize": 1,
      "curvature": 1,
    }
  }
}

export const FishWelfareInitiative: Story = {
  args: {
    data: {
      "sections": [
        {
          "title": "Inputs",
          "columns": [
            {
              "nodes": [
                {
                  "id": "research-team",
                  "title": "Research and program staff with aquaculture and animal welfare expertise",
                  "text": "Interdisciplinary team combining marine biology, animal welfare science, development economics, and field implementation experience",
                  "connectionIds": [
                    "field-studies",
                    "scientific-publications",
                    "ara-partnerships"
                  ],
                  "connections": [
                    {
                      "targetId": "field-studies",
                      "confidence": 85,
                      "evidence": "FWI has conducted multiple field studies in India, China, and Philippines. Team has published peer-reviewed research and established academic partnerships.",
                      "assumptions": "Research staff can be retained and expertise developed. Field research access maintained in key countries."
                    },
                    {
                      "targetId": "scientific-publications",
                      "confidence": 80,
                      "evidence": "Track record of publishing in peer-reviewed journals. Academic collaborations established with universities.",
                      "assumptions": "Research quality meets publication standards. Academic journals receptive to fish welfare research."
                    },
                    {
                      "targetId": "ara-partnerships",
                      "confidence": 75,
                      "evidence": "Currently managing partnerships with 155+ farms through ARA program. Demonstrated farmer engagement and retention.",
                      "assumptions": "Staff capacity sufficient for program management. Farmer relationships maintained over time."
                    }
                  ],
                  "yPosition": 207.158203125,
                  "width": 224,
                  "color": "#e8f4f8"
                },
                {
                  "id": "funding-resources",
                  "title": "$830K annual budget for research, programs, and operations",
                  "text": "Funding for field research, farmer outreach, technology development, policy engagement, and organizational operations across multiple countries",
                  "connectionIds": [
                    "field-studies",
                    "ara-partnerships",
                    "innovation-challenges"
                  ],
                  "connections": [
                    {
                      "targetId": "field-studies",
                      "confidence": 70,
                      "evidence": "2024 budget of $590K supported research activities in India and China. 2025 budget increased to $830K indicating donor confidence.",
                      "assumptions": "Funding sustained over multi-year projects. Donors continue supporting fish welfare as cause area."
                    },
                    {
                      "targetId": "ara-partnerships",
                      "confidence": 75,
                      "evidence": "ARA program operational costs supported by current funding. Cost per fish helped (~$0.14) suggests financial sustainability.",
                      "assumptions": "Program costs don't increase faster than funding. Farmer partnership model remains cost-effective."
                    },
                    {
                      "targetId": "innovation-challenges",
                      "confidence": 60,
                      "evidence": "FWI launched Stunning RFP and Satellite Imagery Challenge in 2024, demonstrating capacity to fund innovation initiatives.",
                      "assumptions": "Innovation challenges produce usable results. Additional funding available for technology development."
                    }
                  ],
                  "yPosition": 420.53125,
                  "width": 224,
                  "color": "#f0f8f0"
                },
                {
                  "id": "farmer-networks",
                  "title": "Relationships with aquaculture farmers and producer associations",
                  "text": "Direct partnerships with fish farmers in India, emerging relationships in China and Philippines, connections to industry associations and cooperatives",
                  "connectionIds": [
                    "ara-partnerships",
                    "stakeholder-engagement"
                  ],
                  "connections": [
                    {
                      "targetId": "ara-partnerships",
                      "confidence": 80,
                      "evidence": "155+ active farmers in ARA program. High retention rates and farmer satisfaction scores. Word-of-mouth recruitment working.",
                      "assumptions": "Farmer trust maintained through beneficial outcomes. Network effects continue driving recruitment."
                    },
                    {
                      "targetId": "stakeholder-engagement",
                      "confidence": 65,
                      "evidence": "Established relationships with key stakeholders in Indian aquaculture. Growing network in China through program expansion.",
                      "assumptions": "Stakeholder relationships translate to broader influence. Industry associations receptive to welfare messaging."
                    }
                  ],
                  "yPosition": 712.53125,
                  "width": 224,
                  "color": "#f8f0e8"
                },
                {
                  "id": "technology-partnerships",
                  "title": "Collaborations with technology developers and research institutions",
                  "text": "Partnerships for developing welfare monitoring technologies, satellite imagery analysis, water quality sensors, and innovation competitions",
                  "connectionIds": [
                    "innovation-challenges",
                    "welfare-protocols"
                  ],
                  "connections": [
                    {
                      "targetId": "innovation-challenges",
                      "confidence": 55,
                      "evidence": "Launched innovation challenges but results still emerging. Some technology partnerships established but early stage.",
                      "assumptions": "Technology partnerships produce viable solutions. External innovators interested in fish welfare applications."
                    },
                    {
                      "targetId": "welfare-protocols",
                      "confidence": 70,
                      "evidence": "Developing welfare assessment methods through research partnerships. Water quality and stocking density protocols established.",
                      "assumptions": "Technology partnerships enhance protocol development. Assessment methods can be standardized across contexts."
                    }
                  ],
                  "yPosition": 967.53125,
                  "width": 224,
                  "color": "#f4e8f8"
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
                  "id": "field-studies",
                  "title": "Field research documenting welfare problems and testing intervention effectiveness",
                  "text": "Controlled studies measuring welfare impacts of water quality improvements, stocking density changes, and handling practices across different farming contexts",
                  "connectionIds": [
                    "evidence-base",
                    "practical-solutions"
                  ],
                  "connections": [
                    {
                      "targetId": "evidence-base",
                      "confidence": 85,
                      "evidence": "Field studies in India have documented welfare problems and intervention effectiveness. Research methodology established and validated.",
                      "assumptions": "Field research access maintained. Study designs capture meaningful welfare indicators."
                    },
                    {
                      "targetId": "practical-solutions",
                      "confidence": 80,
                      "evidence": "ARA program based on field-tested interventions. Water quality and stocking density improvements proven effective in practice.",
                      "assumptions": "Research findings translate to practical applications. Solutions remain effective across different contexts."
                    }
                  ],
                  "yPosition": 207.158203125,
                  "width": 224,
                  "color": "#e8f4f8"
                },
                {
                  "id": "scientific-publications",
                  "title": "Peer-reviewed research establishing fish sentience and welfare science",
                  "text": "Publications documenting fish consciousness, suffering capacity, welfare assessment methods, and intervention effectiveness in academic journals",
                  "connectionIds": [
                    "scientific-legitimacy"
                  ],
                  "connections": [
                    {
                      "targetId": "scientific-legitimacy",
                      "confidence": 75,
                      "evidence": "FWI researchers have publication track record. Fish sentience research gaining academic acceptance. Journals publishing fish welfare studies.",
                      "assumptions": "Publication pipeline continues. Academic community receptive to fish welfare research."
                    }
                  ],
                  "yPosition": 30.53125,
                  "width": 224,
                  "color": "#e8f4f8"
                },
                {
                  "id": "ara-partnerships",
                  "title": "Alliance for Responsible Aquaculture partnerships with farmers implementing welfare standards",
                  "text": "Direct program helping 155+ farms improve water quality and reduce stocking density, with regular monitoring and technical assistance",
                  "connectionIds": [
                    "direct-welfare-impact",
                    "early-adopters"
                  ],
                  "connections": [
                    {
                      "targetId": "direct-welfare-impact",
                      "confidence": 85,
                      "evidence": "ARA program currently helping ~1.2 million fish with verified welfare improvements. Cost-effective at ~7 fish per dollar.",
                      "assumptions": "Welfare improvements are genuine and sustained. Monitoring accurately captures impact."
                    },
                    {
                      "targetId": "early-adopters",
                      "confidence": 70,
                      "evidence": "ARA farmers reporting economic benefits including better survival rates, reduced disease, improved feed conversion ratios.",
                      "assumptions": "Economic benefits persist over time. Early adopters influence peer farmers."
                    }
                  ],
                  "yPosition": 395.78515625,
                  "width": 224,
                  "color": "#f0f8f0"
                },
                {
                  "id": "welfare-protocols",
                  "title": "Standardized welfare assessment protocols and implementation guidelines",
                  "text": "Evidence-based methods for measuring fish welfare, practical guidelines for improvement interventions, training materials for farmers and industry",
                  "connectionIds": [
                    "assessment-methods",
                    "stakeholder-education"
                  ],
                  "connections": [
                    {
                      "targetId": "assessment-methods",
                      "confidence": 75,
                      "evidence": "Water quality and stocking density protocols developed through field research. Methods tested across multiple farm contexts.",
                      "assumptions": "Protocols capture meaningful welfare differences. Methods can be standardized across regions."
                    },
                    {
                      "targetId": "stakeholder-education",
                      "confidence": 65,
                      "evidence": "Training materials developed for ARA farmers. Educational content created for broader stakeholder engagement.",
                      "assumptions": "Educational materials effectively communicate welfare concepts. Stakeholders receptive to training."
                    }
                  ],
                  "yPosition": 618.53125,
                  "width": 224,
                  "color": "#f8f0e8"
                },
                {
                  "id": "policy-recommendations",
                  "title": "Evidence-based policy recommendations for fish welfare regulations",
                  "text": "Policy briefs, regulatory frameworks, and government engagement promoting minimum welfare standards for aquaculture",
                  "connectionIds": [
                    "regulatory-development"
                  ],
                  "connections": [
                    {
                      "targetId": "regulatory-development",
                      "confidence": 35,
                      "evidence": "Limited progress on fish welfare regulation globally. EU developing some standards. Most countries lack specific fish welfare laws.",
                      "assumptions": "Policymakers receptive to welfare arguments. Industry won't successfully oppose regulations."
                    }
                  ],
                  "yPosition": 772.53125,
                  "width": 224,
                  "color": "#f4e8f8"
                },
                {
                  "id": "stakeholder-engagement",
                  "title": "Industry conferences, workshops, and educational campaigns",
                  "text": "Outreach to farmers, processors, retailers, and consumers about fish welfare issues and solutions",
                  "connectionIds": [
                    "stakeholder-education",
                    "market-awareness"
                  ],
                  "connections": [
                    {
                      "targetId": "stakeholder-education",
                      "confidence": 60,
                      "evidence": "Stakeholder engagement activities conducted but impact measurement limited. Industry conferences provide platform for welfare messaging.",
                      "assumptions": "Stakeholders attend and engage meaningfully. Educational messaging changes attitudes and behavior."
                    },
                    {
                      "targetId": "market-awareness",
                      "confidence": 30,
                      "evidence": "Consumer awareness of fish welfare very low compared to other animal welfare issues. Limited retailer engagement to date.",
                      "assumptions": "Market actors respond to welfare messaging. Consumer demand can be developed for welfare-certified products."
                    }
                  ],
                  "yPosition": 1113.53125,
                  "width": 224,
                  "color": "#f8f0e8"
                },
                {
                  "id": "innovation-challenges",
                  "title": "Technology innovation competitions and solution development",
                  "text": "Stunning RFP, Satellite Imagery Innovation Challenge, and other initiatives crowdsourcing technological solutions for welfare problems",
                  "connectionIds": [
                    "welfare-technologies"
                  ],
                  "connections": [
                    {
                      "targetId": "welfare-technologies",
                      "confidence": 50,
                      "evidence": "Innovation challenges launched in 2024 but results still emerging. Some promising technology concepts identified.",
                      "assumptions": "Innovation competitions produce viable solutions. Technologies can be scaled cost-effectively."
                    }
                  ],
                  "yPosition": 967.53125,
                  "width": 224,
                  "color": "#f4e8f8"
                }
              ]
            }
          ]
        },
        {
          "title": "Outcomes Layer 3",
          "columns": [
            {
              "nodes": [
                {
                  "id": "scientific-legitimacy",
                  "title": "Fish welfare recognized as legitimate scientific and ethical concern",
                  "text": "Academic acceptance of fish sentience research, inclusion in animal welfare curricula, recognition by scientific bodies",
                  "connectionIds": [
                    "stakeholder-education"
                  ],
                  "connections": [
                    {
                      "targetId": "stakeholder-education",
                      "confidence": 70,
                      "evidence": "Growing academic acceptance of fish sentience. Some universities adding fish welfare to curricula. Scientific conferences including fish welfare sessions.",
                      "assumptions": "Scientific legitimacy translates to broader stakeholder acceptance. Academic recognition influences policy and industry."
                    }
                  ],
                  "yPosition": 30.53125,
                  "color": "#d1e7dd",
                  "width": 200
                },
                {
                  "id": "evidence-base",
                  "title": "Comprehensive scientific evidence documents welfare problems and solutions",
                  "text": "Research base establishing specific welfare issues in aquaculture and demonstrating effectiveness of improvement interventions",
                  "connectionIds": [
                    "assessment-methods"
                  ],
                  "connections": [
                    {
                      "targetId": "assessment-methods",
                      "confidence": 80,
                      "evidence": "FWI and others building evidence base documenting welfare problems. Intervention studies showing measurable improvements.",
                      "assumptions": "Evidence base reaches sufficient comprehensiveness. Research quality meets scientific standards."
                    }
                  ],
                  "yPosition": 408.158203125,
                  "color": "#d1e7dd",
                  "width": 200
                },
                {
                  "id": "practical-solutions",
                  "title": "Field research demonstrates feasible welfare improvement methods",
                  "text": "Proven interventions for water quality, stocking density, handling, and other welfare issues validated across farming contexts",
                  "connectionIds": [
                    "economic-viability"
                  ],
                  "connections": [
                    {
                      "targetId": "economic-viability",
                      "confidence": 75,
                      "evidence": "ARA program demonstrating practical solutions. Farmers reporting economic benefits from welfare improvements.",
                      "assumptions": "Solutions remain effective when scaled. Economic benefits persist across different market conditions."
                    }
                  ],
                  "yPosition": 207.158203125,
                  "color": "#d1e7dd",
                  "width": 200
                }
              ]
            }
          ]
        },
        {
          "title": "Outcomes Layer 2",
          "columns": [
            {
              "nodes": [
                {
                  "id": "economic-viability",
                  "title": "Welfare improvements proven cost-effective and economically beneficial",
                  "text": "Demonstrated that welfare improvement practices maintain or improve farmer profitability through better survival, growth, and feed conversion",
                  "connectionIds": [
                    "early-adopters"
                  ],
                  "connections": [
                    {
                      "targetId": "early-adopters",
                      "confidence": 70,
                      "evidence": "ARA farmers reporting economic benefits including 43% better survival rates with water quality improvements, improved feed conversion ratios.",
                      "assumptions": "Economic benefits persist over time and scale. Cost-benefit analysis remains positive across different contexts."
                    }
                  ],
                  "yPosition": 239.7548828125,
                  "color": "#cff4fc",
                  "width": 200
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "stakeholder-education",
                  "title": "Key stakeholders educated about fish welfare issues and solutions",
                  "text": "Farmers, industry, policymakers, and consumers understand fish welfare problems and available improvement methods",
                  "connectionIds": [
                    "industry-recognition"
                  ],
                  "connections": [
                    {
                      "targetId": "industry-recognition",
                      "confidence": 55,
                      "evidence": "Some industry stakeholder engagement but limited behavior change documented. Educational campaigns reaching target audiences.",
                      "assumptions": "Education translates to attitude and behavior change. Stakeholders have capacity to implement improvements."
                    }
                  ],
                  "yPosition": 30.53125,
                  "color": "#cff4fc",
                  "width": 200
                },
                {
                  "id": "assessment-methods",
                  "title": "Practical welfare assessment methods developed and validated",
                  "text": "Standardized, cost-effective methods for measuring fish welfare that can be implemented by farmers, auditors, and regulators",
                  "connectionIds": [
                    "industry-recognition"
                  ],
                  "connections": [
                    {
                      "targetId": "industry-recognition",
                      "confidence": 65,
                      "evidence": "Water quality and stocking density assessment methods proven effective. Some industry adoption of welfare measurement approaches.",
                      "assumptions": "Assessment methods capture meaningful welfare differences. Industry accepts standardized measurement approaches."
                    }
                  ],
                  "yPosition": 878.129638671875,
                  "color": "#cff4fc",
                  "width": 200
                },
                {
                  "id": "early-adopters",
                  "title": "Industry champions demonstrate welfare improvements are viable",
                  "text": "Leading farmers and companies successfully implementing welfare practices, serving as models and advocates for broader adoption",
                  "connectionIds": [
                    "industry-recognition"
                  ],
                  "connections": [
                    {
                      "targetId": "industry-recognition",
                      "confidence": 65,
                      "evidence": "ARA farmers serving as examples of welfare implementation. Some larger producers beginning to adopt welfare practices.",
                      "assumptions": "Early adopter success influences peer adoption. Champions actively advocate for welfare improvements."
                    }
                  ],
                  "yPosition": 475.78515625,
                  "color": "#cff4fc",
                  "width": 200
                },
                {
                  "id": "welfare-technologies",
                  "title": "Welfare monitoring and improvement technologies are accessible and affordable",
                  "text": "Cost-effective technological solutions for welfare assessment, water quality monitoring, and other improvement methods available to farmers",
                  "connectionIds": [
                    "scalable-solutions"
                  ],
                  "connections": [
                    {
                      "targetId": "scalable-solutions",
                      "confidence": 50,
                      "evidence": "Some technology solutions emerging from innovation challenges. Water quality monitoring becoming more affordable.",
                      "assumptions": "Technologies can be scaled cost-effectively. Farmers adopt technological solutions when accessible."
                    }
                  ],
                  "yPosition": 1101.158203125,
                  "color": "#cff4fc",
                  "width": 200
                }
              ]
            }
          ]
        },
        {
          "title": "Outcomes Layer 1",
          "columns": [
            {
              "nodes": [
                {
                  "id": "industry-recognition",
                  "title": "Fish welfare becomes recognized priority within aquaculture industry",
                  "text": "Industry associations, major producers, and supply chain actors acknowledge welfare importance and begin implementing improvements",
                  "connectionIds": [
                    "producer-adoption",
                    "market-demand"
                  ],
                  "connections": [
                    {
                      "targetId": "producer-adoption",
                      "confidence": 45,
                      "evidence": "Some industry recognition emerging but limited systematic adoption. ASC and other certification schemes beginning to include welfare elements.",
                      "assumptions": "Industry recognition translates to concrete adoption. Welfare becomes competitive advantage rather than cost burden."
                    },
                    {
                      "targetId": "market-demand",
                      "confidence": 35,
                      "evidence": "Limited consumer awareness of fish welfare compared to other animal welfare issues. Some retailer commitments beginning to emerge.",
                      "assumptions": "Industry recognition influences market positioning. Consumer demand develops for welfare-certified products."
                    }
                  ],
                  "yPosition": 488.158203125,
                  "color": "#fff2cc",
                  "width": 200
                }
              ]
            },
            {
              "nodes": [
                {
                  "id": "regulatory-development",
                  "title": "Government regulations mandate minimum welfare standards",
                  "text": "Policy development and implementation of fish welfare regulations in key aquaculture-producing countries",
                  "connectionIds": [
                    "producer-adoption"
                  ],
                  "connections": [
                    {
                      "targetId": "producer-adoption",
                      "confidence": 60,
                      "evidence": "EU developing fish welfare regulations. Limited progress in other major producing countries. Industry typically resists new regulations initially.",
                      "assumptions": "Regulations are implemented and enforced effectively. Industry complies rather than lobbying for exemptions or delays."
                    }
                  ],
                  "yPosition": 772.53125,
                  "color": "#fff2cc",
                  "width": 200
                },
                {
                  "id": "market-demand",
                  "title": "Consumer and corporate demand drives welfare-certified products",
                  "text": "Market mechanisms create economic incentives for welfare improvements through consumer preferences and corporate commitments",
                  "connectionIds": [
                    "producer-adoption"
                  ],
                  "connections": [
                    {
                      "targetId": "producer-adoption",
                      "confidence": 40,
                      "evidence": "Consumer awareness of fish welfare very low. Limited retailer commitments. Price sensitivity high for fish products.",
                      "assumptions": "Consumer education campaigns succeed. Retailers make meaningful welfare commitments. Price premiums for welfare products acceptable."
                    }
                  ],
                  "yPosition": 415.7421875,
                  "color": "#fff2cc",
                  "width": 200
                },
                {
                  "id": "scalable-solutions",
                  "title": "Welfare improvement technologies and practices are widely accessible",
                  "text": "Cost-effective, practical solutions for welfare improvements available to farmers across different contexts and scales",
                  "connectionIds": [
                    "producer-adoption"
                  ],
                  "connections": [
                    {
                      "targetId": "producer-adoption",
                      "confidence": 55,
                      "evidence": "ARA program proving welfare improvements possible at farm scale. Technology costs decreasing for water quality monitoring.",
                      "assumptions": "Solutions maintain effectiveness when scaled. Technology adoption barriers overcome by cost reduction and usability improvements."
                    }
                  ],
                  "yPosition": 1101.158203125,
                  "color": "#fff2cc",
                  "width": 200
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
                  "id": "producer-adoption",
                  "title": "Major aquaculture producers adopt welfare standards benefiting 100 million fish annually",
                  "text": "Widespread implementation of water quality, stocking density, and handling improvements across industrial aquaculture systems by 2030",
                  "connectionIds": [
                    "end-mission"
                  ],
                  "connections": [
                    {
                      "targetId": "end-mission",
                      "confidence": 75,
                      "evidence": "Large-scale aquaculture operations can affect millions of fish per facility. China alone produces 65% of global farmed fish.",
                      "assumptions": "Producer adoption reaches sufficient scale. Welfare improvements are genuine and sustained. Impact measurement accurately captures benefits."
                    }
                  ],
                  "yPosition": 488.158203125,
                  "color": "#f8d7da",
                  "width": 240
                },
                {
                  "id": "direct-welfare-impact",
                  "title": "Direct intervention programs scale to help millions of fish annually",
                  "text": "Expansion of Alliance for Responsible Aquaculture and similar direct implementation programs to reach scale contributing to 100 million fish target",
                  "connectionIds": [
                    "end-mission"
                  ],
                  "connections": [
                    {
                      "targetId": "end-mission",
                      "confidence": 60,
                      "evidence": "ARA program currently helping ~1.2 million fish with proven welfare improvements. Scalable model demonstrated.",
                      "assumptions": "Direct programs can scale 100x current level. Staff capacity and funding sufficient for expansion. Farmer recruitment sustainable."
                    }
                  ],
                  "yPosition": 342.77099609375,
                  "color": "#f8d7da",
                  "width": 240
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
                  "id": "end-mission",
                  "title": "World where welfare of all sentient beings is recognized and protected",
                  "text": "Aquatic animals receive same ethical consideration as terrestrial farm animals, with fish welfare integrated into broader animal protection movement",
                  "connectionIds": [],
                  "connections": [],
                  "yPosition": 432.904296875,
                  "color": "#d4edda",
                  "width": 280
                }
              ]
            }
          ]
        }
      ],
      "textSize": 1.1,
      "curvature": 0.5,
    }
  }
}