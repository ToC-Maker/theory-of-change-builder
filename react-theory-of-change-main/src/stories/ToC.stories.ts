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