# Analyze Organizational Input Document Task

## Overview
Analyze the provided organizational document to extract key information needed for generating a comprehensive Theory of Change through adversarial analysis.

## Input Requirements
- Path to organizational document (markdown format preferred)
- Document should contain information about the organization's mission, activities, and claimed impacts

## Analysis Framework

### 1. Basic Organization Profile
Extract and document:
- **Organization name and type** (NGO, foundation, research institute, etc.)
- **Stated mission and vision**
- **Primary focus areas/cause areas**
- **Geographic scope** (local, national, global)
- **Organization size** (staff, budget, reach)
- **Founding date and history**

### 2. Current Activities and Strategies
Identify and catalog:
- **Core programs and interventions**
- **Target populations and beneficiaries**  
- **Geographic regions of operation**
- **Implementation methods and approaches**
- **Partnership strategies**
- **Funding sources and resource allocation**

### 3. Claimed Outcomes and Impacts
Document all claims about:
- **Short-term outputs** (direct deliverables)
- **Medium-term outcomes** (behavioral/system changes)
- **Long-term impacts** (ultimate goals achieved)
- **Success metrics and KPIs used**
- **Evaluation methods and evidence presented**
- **Scale of claimed impact** (numbers affected, problems solved)

### 4. Theory of Change Elements (If Present)
If the document contains an existing theory of change, extract:
- **Stated end goal(s)**
- **Outcome chains** (how outcomes lead to goals)
- **Activity-to-outcome logic**
- **Key assumptions made**
- **Risk factors identified**
- **Success indicators used**

### 5. Red Flags for Skeptical Analysis
Identify potential areas for aggressive challenge:
- **Unsupported claims** (no evidence provided)
- **Correlation vs. causation confusion**
- **Selection bias in success stories**
- **Missing counterfactuals** (what would happen without intervention)
- **Vague or unmeasurable outcomes**
- **Logical gaps in causal chains**
- **Overconfident probability assessments**
- **Ignored negative externalities**
- **Unrealistic resource requirements**
- **Unaddressed implementation challenges**

### 6. Evidence Quality Assessment
Evaluate the strength of evidence presented:
- **Peer-reviewed studies cited**
- **Independent evaluations conducted**
- **Sample sizes and methodologies**
- **Replication across different contexts**
- **Contradictory evidence acknowledged**
- **Conflicts of interest disclosed**
- **Data collection methods described**

### 7. Stakeholder and Context Analysis
Identify key contextual factors:
- **Primary stakeholders and their interests**
- **Potential opposition or resistance**
- **Regulatory and political environment**
- **Competitive landscape**
- **Historical precedents** (successes and failures)
- **Cultural and social context**

### 8. Resource and Capacity Analysis
Assess organizational capabilities:
- **Financial resources available**
- **Staff expertise and experience**
- **Infrastructure and systems**
- **Track record of execution**
- **Scalability constraints**
- **Sustainability concerns**

## Output Format

**CRITICAL: ALWAYS SAVE TO FILE** - This analysis must be automatically saved to a timestamped file in the current directory.

**File Naming Convention**: `Org_Analysis_YYYY-MM-DD_HHMM.md`

**MANDATORY FILE SAVE**: After generating the complete analysis, automatically save it to a file using the Write tool with the naming convention above. Do not ask the user - this is required for all organizational analyses.

Generate a structured analysis document with:

```markdown
# Organizational Analysis: [Organization Name]

## Executive Summary
[2-3 paragraph overview of the organization and key findings]

## Organization Profile
[Basic details about the organization]

## Current Strategy and Activities
[Detailed breakdown of what they do]

## Claims Analysis
[All outcome and impact claims with evidence assessment]

## Red Flags for Adversarial Analysis
[Key areas to challenge aggressively]

## Evidence Quality Assessment
[Strength of supporting evidence]

## Contextual Factors
[Environmental factors affecting success]

## Preparation for Adversarial Session
[Specific areas to focus challenges on]
```

## Quality Checks
- Have all major claims been identified?
- Are evidence gaps clearly highlighted?
- Have logical weaknesses been spotted?
- Are assumptions clearly extracted?
- Is there sufficient material for 15,000+ word adversarial conversation?
- Are the most challengeable elements clearly flagged?

## Use in Adversarial Process
This analysis will inform:
- Which claims to challenge most aggressively
- What evidence to demand for specific assertions
- Which logical connections to question
- What alternatives to propose
- Where to probe for hidden assumptions
- How to structure the adversarial conversation for maximum impact