# 2. Requirements

## 2.1 Functional Requirements

### Core Workflow (MVP)
1. **End Goal Identification**
   - Single, specific goal definition interface
   - Goal validation against "intrinsically valued" criteria
   - Connection to broader mission context

2. **Backwards Chaining Process**
   - Layer-by-layer outcome development starting from goal
   - Dynamic layer addition ("Do other outcomes need to occur first?")
   - Non-linear influence mapping (outcomes can skip layers)

3. **Visual Flowchart Builder**
   - Drag-and-drop interface for creating causal chains
   - Left-to-right flow visualization (inputs → outputs → outcomes → goal)
   - Real-time flowchart generation as user builds logic

4. **Causal Link Mapping**
   - Click and drag between steps to create connections
   - Arrow-based visual representation of causal relationships
   - Multiple connection types (direct, indirect, conditional)

5. **Assumption Management**
   - Identification of critical assumptions for each causal link
   - Evidence collection interface (supporting/contrary evidence)
   - Link strength estimation (probability percentages)

6. **Evidence Collection System**
   - Structured evidence entry for each assumption
   - Supporting vs. contrary evidence categorization
   - Source tracking and credibility assessment

7. **Assumption Testing Framework**
   - Test idea generation for critical assumptions
   - Test design templates (survey, research, interview, A/B test)
   - Success criteria definition

8. **Chain Analysis Tools**
   - Probability chain calculations (end-to-end likelihood)
   - Weak link identification (visual flagging: red <25%, orange 25-50%)
   - Chain strengthening recommendations

### Interactive Features (MVP)
1. **Clickable Elements**
   - Click on flowchart steps for detailed descriptions
   - Click on arrows to view assumptions, evidence, tests
   - Expandable detail panels

2. **Hover Information**
   - Mouse-over tooltips for quick information
   - Link strength indicators
   - Summary statistics

3. **Visual Feedback**
   - Color-coded link strength (green ≥70%, orange 40-69%, red <40%)
   - Progress indicators through workflow stages
   - Visual highlighting of critical assumptions

## 2.2 Non-Functional Requirements

### Technical Constraints
1. **Design Philosophy**: Minimal, clean interface similar to causalmap.shinyapps.io
2. **Technology Stack**: Open-source components only
3. **Deployment**: Website-ready embedding capability
4. **Performance**: Responsive interface for flowcharts up to 50 nodes
5. **Compatibility**: Modern web browsers, mobile-responsive design

### User Experience
1. **Learning Curve**: Intuitive for users familiar with strategic planning
2. **Workflow Continuity**: Clear progress through 13-stage process
3. **Data Persistence**: Save/load capability for work sessions
4. **Export Options**: PNG/PDF flowchart export, structured data export

### Integration Requirements
1. **Embedding**: Standard iframe/widget format for EA organization websites
2. **Data Standards**: JSON export for theory of change data
3. **API Readiness**: RESTful endpoints for future integrations

## 2.3 Success Metrics

### Primary KPIs
- 70% of users report +1 improvement in strategic clarity (1-5 scale)
- 70% of critical assumptions have defined test plans
- 60% of users launch at least one assumption test within 30 days

### Secondary Metrics
- Average session completion rate >80% (through all 13 stages)
- User retention: 40% return within 2 weeks
- Export/embedding usage: 30% of completed theories are exported/embedded
