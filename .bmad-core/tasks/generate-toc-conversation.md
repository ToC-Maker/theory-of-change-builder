# Generate Theory of Change Conversation Task

## Task Overview
Generate an extremely thorough back-and-forth conversation using a modified, highly skeptical version of the Strategy Co-Pilot prompt to create a comprehensive Theory of Change. The conversation should be adversarial, with the analyst challenging every assumption and demanding rigorous evidence.

## Prerequisites
- Organizational input document has been provided
- Strategy Co-Pilot prompt (modified for extreme skepticism) is available
- Agent is in highly critical/skeptical mode

## Process Steps

### Step 1: Initial Setup
1. Analyze the provided organizational document thoroughly
2. Extract key information about:
   - Organization's stated mission and goals
   - Current activities and strategies  
   - Claimed outcomes and impacts
   - Resource allocation and funding
   - Target populations and beneficiaries
   - Metrics and evaluation approaches

### Step 2: Begin Adversarial Strategy Session
Use the modified Strategy Co-Pilot prompt (steps 1-10 only, excluding 11-13) with these critical modifications:

**EXTREME SKEPTICISM MODE ACTIVATED:**
- Challenge every single claim made in the organizational document
- Demand concrete, verifiable evidence for all assertions
- Question logical connections between activities and outcomes
- Probe for hidden assumptions and unstated dependencies  
- Push back aggressively on weak reasoning or hand-waving
- Insist on real-world evidence over theoretical models
- Challenge measurement approaches and success metrics
- Question resource allocation efficiency and opportunity costs
- Examine potential negative externalities and unintended consequences
- Demand justification for why this approach vs. alternatives

### Step 3: Execute Modified 10-Step Process
Follow the Strategy Co-Pilot process with maximum skepticism:

**0. Orientation**: Explain the adversarial approach - every claim will be challenged
**1. End Goal**: Ruthlessly examine the stated end goal - is it specific? Measurable? Actually valuable?
**2. End Mission**: Challenge the connection between end goal and broader mission
**3. Outcomes (Layer 1)**: Demand evidence that these outcomes actually lead to the end goal
**4. Additional Outcome Layers**: Keep probing for missing causal layers with extreme skepticism
**5. Outputs Brainstorm**: Challenge each output's necessity and effectiveness
**6. Narrow & Prioritise**: Force harsh prioritization with evidence-based scoring
**7. Draft Chain & Flowchart**: Build chain while constantly questioning connections
**8. Evidence & Probabilities**: Demand rigorous evidence for every arrow and probability
**9. Chain Health Check**: Identify and challenge weak links aggressively
**10. Critical Assumptions**: Extract and examine all critical assumptions with hostility

### Step 4: Conversation Generation Rules
The conversation must include:

1. **Hostile Questioning**: Every response from the analyst should include 2-3 challenging follow-up questions
2. **Evidence Demands**: Constantly ask "What evidence supports this claim?"
3. **Alternative Challenges**: "Why not do X instead?" - always propose alternatives
4. **Assumption Attacks**: "This assumes Y, but what if Y is false?"
5. **Logic Probing**: "How exactly does A lead to B?" - demand step-by-step logic
6. **Reality Checks**: "Has this worked anywhere else?" - demand real-world precedents
7. **Measurement Skepticism**: "How would you actually measure this?" - challenge metrics
8. **Resource Challenges**: "Is this the best use of resources?" - question efficiency
9. **Failure Modes**: "What could go wrong?" - explore negative scenarios
10. **Stakeholder Pushback**: "What about the people who disagree?" - consider opposition

### Step 5: Conversation Format
Structure as authentic dialogue:
```
**Dr. Sarah Chen (ToC Analyst):** [Aggressive challenge with 2-3 follow-up questions]

**Organization Representative:** [Response attempting to address challenges]

**Dr. Sarah Chen:** [Even more pointed follow-up, demanding specific evidence, questioning assumptions]

**Organization Representative:** [More detailed response with attempts at evidence]

[Continue this pattern for 15-25 exchanges per step]
```

### Step 6: Final JSON Output
After completing the full 10-step adversarial process, generate the final Theory of Change in the exact JSON format specified in the original Strategy Co-Pilot prompt. This should be the culmination of all the challenging and refinement that occurred during the conversation.

## Success Criteria
- Conversation is authentic and adversarial (not softball questions)
- Every major claim is challenged multiple times
- Evidence is demanded and scrutinized  
- Logical connections are rigorously examined
- Alternative approaches are considered
- Final theory is more robust due to the adversarial process
- JSON output matches the required format exactly
- Document length: 15,000+ words minimum

## Output Format
**CRITICAL: ALWAYS SAVE TO FILE** - This analysis must be automatically saved to a single comprehensive document containing:
1. Executive summary of the adversarial process
2. Complete conversation transcript (15,000+ words)
3. Final refined Theory of Change in JSON format
4. Summary of key assumptions that survived the adversarial process

**MANDATORY FILE SAVE**: After generating the complete analysis, automatically save it to a file using the Write tool. Do not ask the user - this is required for all ToC analyses.

## Quality Checks
- Are challenges genuinely difficult and pointed?
- Does the organization actually have to work to respond?
- Are assumptions truly examined, not just acknowledged?
- Is the final theory significantly improved from the adversarial process?
- Does the JSON format match the specification exactly?