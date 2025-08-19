# Epic 001: Core Theory of Change Builder - Detailed User Stories

## Epic Summary

Transform the existing Strategy Co-Pilot Prompt v005 conversational tool into an interactive web application that maintains the rigorous backwards-chaining methodology while adding visual flowchart building capabilities for EA organizations.

**Success Criteria:**
- 70% of users report +1 improvement in Theory of Change clarity
- 70% of users develop comprehensive test plans for their assumptions
- 60% of users launch actual tests based on their Theory of Change

---

## Story 001.1: End Goal Definition and Mission Context Interface

### User Story

**As an** EA practitioner building a Theory of Change,
**I want** to define my specific end goal and connect it to a larger mission through guided prompts with validation,
**so that** I can establish a clear, measurable foundation that anchors my entire Theory of Change to intrinsic value and broader impact.

### Story Context

**Existing System Integration:**
- Integrates with: Strategy Co-Pilot Prompt v005 Steps 1-2 methodology
- Technology: React forms with TypeScript validation, integration with existing tocStore
- Follows pattern: Step-by-step progression with locking mechanism from original prompt
- Touch points: Form validation logic, step progression state management, goal specificity checker

### Acceptance Criteria

**Functional Requirements:**

1. **End Goal Input Interface** - User can enter their end goal in a text input field with real-time validation prompts
2. **Goal Specificity Checker** - System validates that the goal is specific, measurable, and intrinsically valued (not a strategy or milestone)
3. **Mission Context Connector** - After goal confirmation, user is prompted to define the larger mission served by achieving the end goal
4. **Step Locking Mechanism** - User cannot proceed to outcome definition until both goal and mission are explicitly confirmed
5. **Validation Feedback** - System provides clear feedback when goals are too vague, strategic rather than intrinsic, or lack specificity

**Integration Requirements:**

6. Existing step-by-step progression logic continues to work unchanged
7. New interface follows existing prompt validation patterns from Strategy Co-Pilot v005
8. Integration with tocStore maintains current state management behavior

**Quality Requirements:**

9. Goal and mission definitions are stored in consistent format matching original prompt output
10. Form validation provides helpful guidance without being overly restrictive
11. No regression in step progression logic verified through testing

### Technical Notes

- **Integration Approach:** Replace conversational Steps 1-2 with React form components that enforce the same validation rules
- **Existing Pattern Reference:** Strategy Co-Pilot Prompt v005 orientation and goal definition logic
- **Key Constraints:** Must maintain the "intrinsically valued, specific End Goal" requirement; cannot allow progression without explicit user confirmation

### Definition of Done

- [ ] End goal input form with real-time validation implemented
- [ ] Goal specificity checker validates against strategy/milestone patterns
- [ ] Mission context form captures larger purpose connection
- [ ] Step locking prevents progression without confirmation
- [ ] Validation messages guide users toward specific, intrinsic goals
- [ ] Integration with tocStore preserves existing state patterns
- [ ] Tests verify equivalent validation rigor to original prompt

---

## Story 001.2: Layered Outcome Builder with Visual Feedback

### User Story

**As an** EA practitioner building a Theory of Change,
**I want** to develop outcomes in layers starting with those directly causing my end goal, with the ability to add deeper layers as needed,
**so that** I can build a complete causal chain that follows rigorous backwards-chaining methodology while maintaining visual clarity of outcome relationships.

### Story Context

**Existing System Integration:**
- Integrates with: Strategy Co-Pilot Prompt v005 Steps 3-4 layered outcome methodology
- Technology: Dynamic React components with drag-and-drop interface, visual layer representation
- Follows pattern: "One layer at a time" development with user confirmation flows
- Touch points: Outcome management system, visual flowchart updates, layer progression logic

### Acceptance Criteria

**Functional Requirements:**

1. **Layer 1 Outcomes Interface** - User can add outcomes that most directly cause the end goal, with validation for behavior/system-level shifts
2. **Dynamic Layer Addition** - After confirming each layer, system asks "Do any other outcomes need to happen for these to emerge?" with clear yes/no options
3. **Visual Layer Representation** - Flowchart displays outcomes in clearly distinguished layers showing hierarchy and relationships
4. **Non-linear Influence Support** - Outcomes can influence multiple layers or skip layers entirely (following original prompt flexibility)
5. **Outcome Validation** - System validates that outcomes are behavior or system-level shifts, not outputs or activities

**Integration Requirements:**

6. Existing "one layer at a time" methodology from original prompt is preserved
7. New layer addition follows existing confirmation patterns
8. Integration with flowchart generator maintains current visual representation standards

**Quality Requirements:**

9. Layer progression maintains methodological rigor of original prompt
10. Visual representation clearly distinguishes between outcome layers
11. No regression in outcome validation logic verified through testing

### Technical Notes

- **Integration Approach:** Convert Steps 3-4 conversational flow into interactive forms with dynamic layer management
- **Existing Pattern Reference:** Strategy Co-Pilot Prompt v005 layered outcome development and confirmation logic
- **Key Constraints:** Must preserve backwards-chaining logic; cannot auto-generate layers without user confirmation

### Definition of Done

- [ ] Layer 1 outcomes form with behavior/system validation implemented
- [ ] Dynamic layer addition system with user confirmation flows
- [ ] Visual layer representation in flowchart showing clear hierarchy
- [ ] Non-linear influence patterns supported (outcomes can skip layers)
- [ ] Outcome validation enforces behavior/system-level shift criteria
- [ ] Integration with flowchart generator updates visual representation
- [ ] Tests verify equivalent layer development logic to original prompt

---

## Story 001.3: Basic Flowchart Generator with Mermaid.js Integration

### User Story

**As an** EA practitioner building a Theory of Change,
**I want** to see my inputs, outputs, layered outcomes, end goal, and mission displayed as an interactive flowchart with automatic positioning and probability-weighted connections,
**so that** I can visualize the complete theory structure and understand the strength of causal relationships at a glance.

### Story Context

**Existing System Integration:**
- Integrates with: Strategy Co-Pilot Prompt v005 Mermaid flowchart example and probability visualization
- Technology: Mermaid.js rendering engine with React wrapper, automatic node positioning algorithms
- Follows pattern: Left-to-right flow layout with grouped node types from original example
- Touch points: Chart generation service, probability calculation engine, visual feedback system

### Acceptance Criteria

**Functional Requirements:**

1. **Mermaid.js Flowchart Rendering** - Generate left-to-right flowcharts matching the original prompt's Mermaid example structure
2. **Automatic Node Positioning** - System automatically positions inputs, outputs, outcomes (multiple layers), end goal, and mission in logical groupings
3. **Probability-Weighted Arrows** - Connections display probability percentages with color coding (Green ≥70%, Orange 40-69%, Red <40%)
4. **Non-linear Influence Visualization** - Support outputs or outcomes that skip layers or directly influence end goal
5. **Interactive Node Management** - Users can click nodes to edit content and connection probabilities

**Integration Requirements:**

6. Existing Mermaid formatting from original prompt example is preserved
7. New flowchart follows existing probability color coding standards
8. Integration with outcome/output data maintains current data structure patterns

**Quality Requirements:**

9. Generated flowcharts are compatible with mermaid.live for external editing
10. Visual representation accurately reflects theory structure and relationships
11. No regression in data visualization accuracy verified through testing

### Technical Notes

- **Integration Approach:** Implement Mermaid.js chart generator that converts theory data into flowchart syntax matching original example
- **Existing Pattern Reference:** Strategy Co-Pilot Prompt v005 flowchart example with probability color coding
- **Key Constraints:** Must support non-linear influence patterns; automatic positioning cannot override logical flow structure

### Definition of Done

- [ ] Mermaid.js integration generates left-to-right flowcharts
- [ ] Automatic node positioning creates logical groupings (inputs, outputs, outcomes, goal, mission)
- [ ] Probability-weighted arrows with color coding implemented
- [ ] Non-linear influence patterns visualized correctly
- [ ] Interactive node editing capabilities functional
- [ ] Generated flowcharts compatible with mermaid.live
- [ ] Tests verify flowchart accuracy matches theory structure

---

## Story 001.4: Evidence and Probability Assignment System

### User Story

**As an** EA practitioner building a Theory of Change,
**I want** to assign evidence-based probabilities to each causal connection with supporting rationale,
**so that** I can quantify the strength of my assumptions and identify the weakest links that need testing or strengthening.

### Story Context

**Existing System Integration:**
- Integrates with: Strategy Co-Pilot Prompt v005 Step 8 evidence and probability methodology
- Technology: Modal forms for evidence entry, probability sliders, rationale text fields
- Follows pattern: Evidence-based probability assignment with one-sentence rationale requirement
- Touch points: Assumption management system, probability calculation engine, chain health checker

### Acceptance Criteria

**Functional Requirements:**

1. **Evidence Entry Interface** - Users can add supporting and contrary evidence for each causal connection
2. **Probability Assignment** - Users assign probability percentages (0-100%) to each arrow with evidence backing
3. **Rationale Requirement** - System requires one-sentence rationale for each probability assignment
4. **Chain Health Calculation** - System multiplies probabilities from inputs to end goal and flags weak chains
5. **Critical Assumption Identification** - System identifies high-impact, low-confidence connections for testing

**Integration Requirements:**

6. Existing evidence and probability validation logic from original prompt is preserved
7. New probability assignment follows existing rationale requirement patterns
8. Integration with chain health checker maintains current risk assessment standards

**Quality Requirements:**

9. Probability assignments are evidence-based rather than intuitive
10. Chain health calculation accurately reflects cumulative probability risk
11. No regression in assumption identification logic verified through testing

### Technical Notes

- **Integration Approach:** Convert Step 8 conversational evidence gathering into structured forms with validation
- **Existing Pattern Reference:** Strategy Co-Pilot Prompt v005 evidence gathering and probability assignment methodology
- **Key Constraints:** Must require evidence backing for all probabilities; cannot allow unsupported assumptions

### Definition of Done

- [ ] Evidence entry forms for supporting and contrary evidence implemented
- [ ] Probability assignment interface with 0-100% range
- [ ] One-sentence rationale requirement enforced
- [ ] Chain health calculation with risk flagging (Red <25%, Orange 25-50%)
- [ ] Critical assumption identification based on impact/confidence matrix
- [ ] Integration with visual probability color coding in flowchart
- [ ] Tests verify evidence-based probability assignment logic

---

## Story 001.5: Test Planning and Critical Assumption Validation

### User Story

**As an** EA practitioner building a Theory of Change,
**I want** to design specific tests for my critical assumptions with clear indicators and failure scenarios,
**so that** I can validate my theory with real-world evidence before committing significant resources to implementation.

### Story Context

**Existing System Integration:**
- Integrates with: Strategy Co-Pilot Prompt v005 Steps 10-11 assumption testing methodology
- Technology: Test design templates, indicator definition forms, failure scenario planning
- Follows pattern: Critical assumption identification followed by test design with MEL planning
- Touch points: Assumption management system, test template library, review scheduling system

### Acceptance Criteria

**Functional Requirements:**

1. **Test Design Interface** - Users can design tests for critical assumptions using template options (survey, research, interview, A/B test)
2. **Indicator Definition** - Users define specific indicators, data sources, and success thresholds for each test
3. **Failure Scenario Planning** - Users specify what actions to take if assumptions fail testing
4. **Review Schedule Management** - Users can set realistic review dates based on indicator availability
5. **Test Progress Tracking** - Users can track test completion and update assumption confidence based on results

**Integration Requirements:**

6. Existing critical assumption identification logic from original prompt is preserved
7. New test design follows existing template patterns for assumption validation
8. Integration with review scheduling maintains current timeline management standards

**Quality Requirements:**

9. Test designs are specific and actionable rather than vague research plans
10. Indicator definitions enable clear pass/fail determination
11. No regression in assumption testing methodology verified through testing

### Technical Notes

- **Integration Approach:** Convert Steps 10-11 conversational test planning into structured forms with templates
- **Existing Pattern Reference:** Strategy Co-Pilot Prompt v005 assumption testing and MEL planning methodology
- **Key Constraints:** Must focus on critical assumptions only; cannot create generic research plans

### Definition of Done

- [ ] Test design interface with template options implemented
- [ ] Indicator definition forms with sources and thresholds
- [ ] Failure scenario planning functionality
- [ ] Review schedule management with calendar integration options
- [ ] Test progress tracking and assumption confidence updating
- [ ] Integration with critical assumption identification system
- [ ] Tests verify assumption testing methodology preservation

---

## Epic Validation Checklist

### Methodology Preservation
- [ ] All 13 steps from Strategy Co-Pilot Prompt v005 represented in digital format
- [ ] Step-by-step progression with locking mechanism maintains original behavior
- [ ] Layered outcome development follows "one layer at a time" approach
- [ ] Evidence and probability validation matches original standards
- [ ] Backwards-chaining logic preserved throughout workflow

### Success Criteria Alignment
- [ ] Interface design supports 70% user clarity improvement goal
- [ ] Test planning features enable 70% of users to develop comprehensive test plans
- [ ] Assumption validation system facilitates 60% user test launch rate
- [ ] Visual representation enhances understanding of Theory of Change structure
- [ ] EA organization workflow requirements met

### Technical Integration
- [ ] Web application integrates with existing tocStore patterns
- [ ] Mermaid.js flowcharts match original prompt example format
- [ ] Step progression maintains original prompt locking behavior
- [ ] Evidence-based validation preserves methodological rigor
- [ ] Non-linear influence patterns supported in visual representation

### Quality Assurance
- [ ] No regression in methodological rigor or output quality
- [ ] Side-by-side testing with original prompt confirms equivalent outcomes
- [ ] User testing validates equivalent quality Theory of Change outputs
- [ ] Rollback plan maintains original prompt as authoritative reference
- [ ] Documentation reflects preservation of 13-step methodology