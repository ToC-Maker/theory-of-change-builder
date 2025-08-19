# Theory of Change Builder - Product Requirements Document

## 1. Project Overview

### Current State
- **Existing Asset**: Strategy Co-Pilot Prompt v005 - A conversational AI tool providing Theory of Change guidance through rigorous backwards-chaining methodology
- **Enhancement Goal**: Transform prompt-based MVP into interactive web application with visual flowchart builder

### Vision
An interactive web application that maintains the rigorous backwards-chaining methodology while adding visual, drag-and-drop Theory of Change building capabilities for EA individuals and organizations.

### Core Value Proposition
- Preserves step-by-step strategic thinking framework from existing prompt
- Adds visual flowchart building with drag-and-drop interface
- Maintains focus on evidence-based theory construction and assumption testing
- Provides clickable, interactive elements for deeper exploration

## 2. Requirements

### 2.1 Functional Requirements

#### Core Workflow (MVP)
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

#### Interactive Features (MVP)
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

### 2.2 Non-Functional Requirements

#### Technical Constraints
1. **Design Philosophy**: Minimal, clean interface similar to causalmap.shinyapps.io
2. **Technology Stack**: Open-source components only
3. **Deployment**: Website-ready embedding capability
4. **Performance**: Responsive interface for flowcharts up to 50 nodes
5. **Compatibility**: Modern web browsers, mobile-responsive design

#### User Experience
1. **Learning Curve**: Intuitive for users familiar with strategic planning
2. **Workflow Continuity**: Clear progress through 13-stage process
3. **Data Persistence**: Save/load capability for work sessions
4. **Export Options**: PNG/PDF flowchart export, structured data export

#### Integration Requirements
1. **Embedding**: Standard iframe/widget format for EA organization websites
2. **Data Standards**: JSON export for theory of change data
3. **API Readiness**: RESTful endpoints for future integrations

### 2.3 Success Metrics

#### Primary KPIs
- 70% of users report +1 improvement in strategic clarity (1-5 scale)
- 70% of critical assumptions have defined test plans
- 60% of users launch at least one assumption test within 30 days

#### Secondary Metrics
- Average session completion rate >80% (through all 13 stages)
- User retention: 40% return within 2 weeks
- Export/embedding usage: 30% of completed theories are exported/embedded

## 3. MVP Feature Specification

### 3.0 Phase 0: AI-Assisted Visualization Proof of Concept (Simpler MVP)

**Goal**: Validate that an AI-assisted chatbot can successfully transform text-based Theory of Change descriptions into the interactive flowchart format, providing a foundation for the full backwards-chaining methodology.

**Layout**: 
- 2/3 of screen: Interactive ToC visualization (using existing React component)
- 1/3 of screen: AI chatbot interface (left panel)

#### Core Features (Phase 0)
1. **Existing ToC Display Integration**
   - Utilize current React ToC visualization component
   - Display interactive flowchart with confidence bars, hover details, and connection popups
   - Maintain existing drag-and-drop and highlighting functionality

2. **AI Chatbot Interface**
   - Clean, minimal chat interface in left panel (1/3 screen width)
   - Two primary conversation paths:
     - **Path A**: "Build ToC from scratch" - Guided structured process
     - **Path B**: "Input existing ToC context" - Text-to-visualization conversion

3. **Text-to-ToC Conversion Engine**
   - Accept unstructured Theory of Change text input
   - AI parsing to identify:
     - Goal/outcome statements
     - Causal relationships and assumptions
     - Evidence statements
     - Confidence levels (inferred or explicitly stated)
   - Transform parsed content into JSON format compatible with existing React component

4. **Initial Conversation Flow**
   ```
   Chatbot: "I can help you create or visualize your Theory of Change. Would you like to:
   1. 🏗️ Build a new ToC from scratch with guided questions
   2. 📋 Transform existing ToC text into an interactive visualization"
   ```

5. **Real-time Visualization Updates**
   - Live update of flowchart as AI processes user input
   - Progressive building of nodes, connections, and confidence levels
   - Visual feedback showing AI's interpretation accuracy

6. **Basic Validation Features**
   - AI asks clarifying questions about ambiguous relationships
   - User can confirm/modify AI interpretations before finalizing
   - Simple feedback mechanism: "Does this look right?"

#### Technical Implementation (Phase 0)
- **Frontend**: Extend existing React setup with chat component
- **AI Integration**: OpenAI API or similar for text processing and conversation management
- **Data Flow**: Text input → AI parsing → JSON generation → React component update
- **Layout**: CSS Grid/Flexbox for 1/3 chat, 2/3 visualization split

#### Success Criteria (Phase 0)
- 80% of users can successfully input text ToC and see reasonable visualization
- AI correctly identifies basic causal chains in 70% of test cases
- Users report the visualization matches their intended meaning in 60% of cases
- Proof that AI-assisted approach is viable before investing in full backwards-chaining methodology

#### Key Learning Objectives
1. **Technical Feasibility**: Can AI reliably parse Theory of Change text into structured format?
2. **User Experience**: Do users find the AI-assisted approach intuitive and helpful?
3. **Visualization Value**: Does seeing their ToC as an interactive flowchart provide immediate value?
4. **Conversation Design**: What conversation patterns work best for ToC elicitation?

This Phase 0 serves as a critical validation step before proceeding to the full backwards-chaining methodology in Release 1, ensuring the core AI-visualization pipeline works effectively.

---

### 3.1 Essential Features (Release 1)

1. **End Goal Definition Interface**
   - Simple text input with validation prompts
   - Goal specificity checker
   - Mission context connector

2. **Layered Outcome Builder**
   - Layer 1 outcomes (directly causing goal)
   - Dynamic layer addition with user confirmation
   - Visual layer representation in flowchart

3. **Basic Flowchart Generator**
   - Mermaid.js-based rendering
   - Left-to-right flow layout
   - Automatic node positioning

4. **Simple Drag-and-Drop**
   - Connect nodes with arrows
   - Basic arrow labeling (probability %)
   - Visual feedback during connection creation

5. **Assumption Entry System**
   - Pop-up forms for arrow assumptions
   - Basic evidence entry (text fields)
   - Link strength slider (0-100%)

6. **Critical Assumption Identification**
   - Automatic flagging based on impact/confidence matrix
   - User override capability
   - Visual highlighting in flowchart

7. **Basic Test Suggestions**
   - Template-based test recommendations
   - Simple test design prompts
   - Success criteria definition

8. **Chain Health Checker**
   - End-to-end probability calculation
   - Visual risk indicators
   - Strengthening recommendations

### 3.2 Enhanced Features (Release 2)

1. **Advanced Flowchart Interactions**
   - Expandable node details
   - Rich hover information
   - Zoom and pan capabilities

2. **Evidence Management System**
   - Structured evidence entry
   - Source credibility weighting
   - Evidence strength impact on link probabilities

3. **Collaborative Features**
   - Share/comment on theories
   - Version history
   - Multi-user editing

4. **Template Library**
   - Pre-built theory templates by domain
   - Best practice examples
   - Quick-start options

### 3.3 Advanced Features (Future Releases)

1. **AI Integration**
   - Real-world research suggestions
   - Automatic assumption identification
   - Evidence gap analysis

2. **Advanced Analytics**
   - Comparative theory analysis
   - Sensitivity analysis for probability changes
   - Portfolio-level theory management

3. **Integration Ecosystem**
   - Calendar integration for test scheduling
   - Survey tool connections
   - Research database links

## 4. User Journey & Workflow

### 4.0 Phase 0 User Flow (Simpler MVP)

**Path A: Build from Scratch**
1. **Welcome** - Choose "Build new ToC from scratch"
2. **Goal Elicitation** - AI asks: "What specific change do you want to see in the world?"
3. **Context Gathering** - AI gathers background, stakeholders, timeframe
4. **Iterative Building** - AI suggests potential causal chains, user confirms/modifies
5. **Visualization Refinement** - User adjusts connections, confidence levels via chat
6. **Validation** - "Does this visualization capture your theory accurately?"

**Path B: Text-to-Visualization**
1. **Welcome** - Choose "Transform existing ToC text"  
2. **Text Input** - User pastes or types their existing Theory of Change
3. **AI Processing** - "I'm analyzing your text and identifying key relationships..."
4. **Initial Visualization** - First-pass flowchart appears, AI explains interpretation
5. **Clarification Round** - AI asks about ambiguous connections: "Did you mean X leads to Y?"
6. **Refinement** - User provides feedback, AI updates visualization
7. **Finalization** - User confirms final version matches their intent

**Common Elements:**
- Real-time visualization updates in 2/3 of screen
- Conversational AI guidance in 1/3 left panel
- Click-to-modify elements: "Change this connection" → AI helps refine
- Export options: "Save as JSON", "Generate summary"

### 4.1 Primary User Flow (Release 1 - Full MVP)
1. **Orientation** - Brief process explanation
2. **Goal Definition** - Single, specific end goal entry
3. **Mission Context** - Broader mission connection
4. **Outcome Layering** - Layer-by-layer backwards chaining
5. **Output Generation** - Activity/output identification
6. **Priority Scoring** - Impact/ease scoring for focus
7. **Flowchart Building** - Visual theory construction
8. **Evidence Entry** - Assumption and evidence documentation
9. **Health Check** - Probability analysis and risk assessment
10. **Assumption Testing** - Critical assumption identification
11. **Test Planning** - Test design and MEL framework
12. **Review Scheduling** - Iteration timeline setting
13. **Finalization** - Export/embedding preparation

### 4.2 Technical User Journey
1. **Entry Point**: Direct web access or embedded widget
2. **Session Management**: Auto-save progress, resumable sessions
3. **Interactive Building**: Drag-drop flowchart construction
4. **Data Validation**: Real-time input validation and guidance
5. **Export Options**: Multiple format outputs (PNG, PDF, JSON)
6. **Embedding**: Copy-paste widget code for organization websites

## 5. Technical Architecture Overview

### 5.1 Frontend Requirements
- **Framework**: React or Vue.js for component management
- **Flowchart Library**: Mermaid.js or D3.js for visualization
- **Drag-Drop**: React DnD or native HTML5 drag-drop
- **UI Components**: Minimal design system (similar to shadcn/ui)

### 5.2 Backend Requirements
- **API**: Node.js/Express or Python/FastAPI
- **Database**: PostgreSQL for relational data, Redis for sessions
- **File Storage**: Cloud storage for exported files
- **Authentication**: Optional user accounts for session persistence

### 5.3 Deployment
- **Static Hosting**: Vercel, Netlify, or similar for frontend
- **API Hosting**: Railway, Render, or similar for backend
- **CDN**: CloudFlare for global performance
- **Embedding**: iframe-based widget with configurable styling

This PRD maintains the rigorous methodology from Strategy Co-Pilot Prompt v005 while providing the interactive, visual capabilities needed for broader adoption by EA organizations. The MVP focuses on core value delivery while establishing the foundation for advanced features in future releases.