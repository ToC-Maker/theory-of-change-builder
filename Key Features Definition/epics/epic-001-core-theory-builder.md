# Core Theory of Change Builder - Brownfield Enhancement

## Epic Goal

Transform the existing Strategy Co-Pilot Prompt v005 conversational tool into an interactive web application that maintains the rigorous backwards-chaining methodology while adding visual flowchart building capabilities for EA organizations.

## Epic Description

**Existing System Context:**

- Current relevant functionality: Strategy Co-Pilot Prompt v005 - A conversational AI tool providing Theory of Change guidance through rigorous backwards-chaining methodology with 13 structured steps
- Technology stack: Text-based prompt interface requiring manual implementation and visualization
- Integration points: The new web app will preserve the complete 13-step process flow, maintaining the same logical progression and validation checks

**Enhancement Details:**

- What's being added/changed: Converting the prompt-based workflow into an interactive web application with visual flowchart generation, form-based inputs, and drag-and-drop interface while preserving all original methodology
- How it integrates: The web app will implement each step of the existing prompt as interactive components, maintaining the step-by-step progression and validation logic
- Success criteria: Users can complete the full Theory of Change building process through a web interface that produces the same quality outcomes as the original prompt, with added visual representation

## Stories

1. **Story 1:** End Goal Definition and Mission Context Interface
   - Implement Steps 1-2 from the original prompt as web forms with validation
   - Create goal specificity checker and mission context connector
   - Ensure step-locking mechanism matches original prompt behavior

2. **Story 2:** Layered Outcome Builder with Visual Feedback
   - Build dynamic layer addition system (Steps 3-4) with user confirmation flows
   - Implement the "one layer at a time" methodology with clear progression
   - Create visual layer representation showing outcome hierarchy

3. **Story 3:** Basic Flowchart Generator with Mermaid.js Integration
   - Generate left-to-right flow layout matching the original prompt's Mermaid example
   - Implement automatic node positioning for inputs, outputs, outcomes (multiple layers), end goal, and end mission
   - Ensure flowchart reflects the non-linear influence patterns from the original methodology

## Compatibility Requirements

- [x] Existing prompt methodology remains unchanged in logic and flow
- [x] All 13 steps from the original prompt are preserved in digital format
- [x] Step-by-step progression with locking mechanism maintains original behavior
- [x] Layered outcome development follows the "one layer at a time" approach
- [x] Evidence and probability validation matches original standards

## Risk Mitigation

- **Primary Risk:** Loss of methodological rigor when transitioning from conversational prompt to web interface
- **Mitigation:** Implement each prompt step as a discrete web component with the same validation rules and progression logic; conduct side-by-side testing with original prompt outcomes
- **Rollback Plan:** Maintain the original prompt as the authoritative reference; if web app produces inconsistent results, users can revert to prompt-based workflow while issues are resolved

## Definition of Done

- [x] All three stories completed with acceptance criteria met
- [x] Web application implements Steps 1-4 of the original prompt methodology
- [x] Visual flowchart generation produces Mermaid-compatible output matching original examples
- [x] Step progression and validation logic maintains original prompt behavior
- [x] User testing confirms equivalent quality outcomes between web app and original prompt
- [x] Basic drag-and-drop functionality for connecting nodes implemented
- [x] No regression in methodological rigor or output quality

## Story Manager Handoff

**Story Manager Handoff:**

"Please develop detailed user stories for this brownfield epic. Key considerations:

- This is an enhancement to an existing conversational AI prompt system with a proven 13-step methodology
- Integration points: Web forms must capture the same validation logic as the original prompt steps; flowchart generation must produce Mermaid.js compatible output; step progression must maintain the locking mechanism
- Existing patterns to follow: Step-by-step progression with approval gates; layered outcome development; backwards-chaining logic; evidence-based probability assignment
- Critical compatibility requirements: Preserve all validation logic from the original prompt; maintain the "one layer at a time" outcome development; ensure step-locking behavior prevents premature progression; support non-linear influence patterns in flowcharts
- Each story must include verification that the web interface produces equivalent quality Theory of Change outputs as the original prompt

The epic should maintain methodological integrity while delivering an interactive web-based Theory of Change builder that enhances accessibility and visual representation for EA organizations."