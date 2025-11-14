# Usage Logging System - Architecture & Implementation Plan

**Purpose**: Collect comprehensive user interaction data (chat conversations, graph edits, sessions) for future AI evaluation and prompt engineering improvements.

**Last Updated**: 2025-11-14

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Database Schema](#database-schema)
3. [Data Flow Architecture](#data-flow-architecture)
4. [Implementation Steps](#implementation-steps)
5. [API Endpoints](#api-endpoints)
6. [Frontend Integration](#frontend-integration)
7. [Backend Implementation](#backend-implementation)
8. [Privacy & Opt-Out](#privacy--opt-out)
9. [Query Examples for Analysis](#query-examples-for-analysis)
10. [Testing Strategy](#testing-strategy)
11. [Deployment Checklist](#deployment-checklist)
12. [Future Enhancements](#future-enhancements)

---

## System Overview

### Goals

- **Track chat conversations** between users and AI assistant
- **Snapshot graph state** after every edit (AI or manual)
- **Link AI messages to resulting edits** for future prompt engineering analysis
- **Measure AI quality** through success rates, undo patterns, and user corrections
- **Enable session replay** for debugging and evaluation dataset creation
- **Respect user privacy** with opt-out mechanism

### Key Design Decisions

1. **Full snapshots vs diffs**: Store complete graph state after each edit (simpler queries, guaranteed reconstruction)
2. **Opt-out by default**: All users tracked unless they explicitly opt-out
3. **Track everything equally**: No distinction between AI and manual edit granularity
4. **Message-to-edit linking**: Direct foreign key relationship via `message_id`
5. **Sequence numbers**: Guarantee correct ordering even with concurrent edits or clock skew
6. **Server-side storage**: Move chat history from localStorage to database for persistence

### What This Is

This is a **logging system** that collects data for **future evaluation**. We're not running evals yet - just capturing the data needed to build evaluation datasets later.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (React)                       │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ ChatInterface│  │ App.tsx      │  │ TheoryOfChange   │  │
│  │             │  │              │  │ Graph            │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                │                   │             │
│    User message     AI edit             Manual edit        │
│         │                │                   │             │
└─────────┼────────────────┼───────────────────┼─────────────┘
          │                │                   │
          ▼                ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│              Netlify Functions (Node.js)                    │
│  ┌─────────────────┐  ┌────────────────┐  ┌─────────────┐ │
│  │ saveMessage     │  │ saveSnapshot   │  │ getSession  │ │
│  └────────┬────────┘  └────────┬───────┘  └──────┬──────┘ │
│           │                    │                  │         │
└───────────┼────────────────────┼──────────────────┼─────────┘
            │                    │                  │
            ▼                    ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                 Neon PostgreSQL Database                    │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────┐ │
│  │logging_      │  │ logging_       │  │logging_        │ │
│  │sessions      │◄─┤ messages       │  │snapshots       │ │
│  │              │  │                │  │                │ │
│  │ session_id   │  │ session_id     │  │ session_id     │ │
│  │ chart_id     │  │ message_id ────┼──┼──► triggered_  │ │
│  │ user_id      │  │ content        │  │    by_message  │ │
│  │ started_at   │  │ role           │  │ graph_data     │ │
│  └──────────────┘  └────────────────┘  │ edit_type      │ │
│                                         │ sequence_number│ │
│                                         └────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### Core Tables

#### 1. `logging_sessions`

**Purpose**: Track user editing sessions and group related activity.

```sql
CREATE TABLE logging_sessions (
  session_id UUID PRIMARY KEY,
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE CASCADE,
  user_id TEXT,  -- NULL for anonymous users
  user_email TEXT,  -- For debugging/analysis
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,  -- Updated when session expires or user closes tab
  opted_out BOOLEAN DEFAULT FALSE,

  -- Metadata
  user_agent TEXT,  -- Browser/device info
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_logging_sessions_chart ON logging_sessions(chart_id);
CREATE INDEX idx_logging_sessions_user ON logging_sessions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_logging_sessions_started ON logging_sessions(started_at);

-- Comment
COMMENT ON TABLE logging_sessions IS 'User session tracking for usage logging and future evaluation';
```

**Session Lifecycle**:
- **Created**: When user opens chart or after 30 min inactivity
- **UUID generated**: On frontend via `crypto.randomUUID()`
- **Stored**: In localStorage and database
- **Expired**: After 30 minutes of inactivity
- **Ended**: Timestamp updated when session closes

#### 2. `logging_messages`

**Purpose**: Store complete conversation history between user and AI.

```sql
CREATE TABLE logging_messages (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES logging_sessions(session_id) ON DELETE CASCADE,
  message_id UUID NOT NULL UNIQUE,  -- Client-generated stable ID
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE CASCADE,

  -- Message content
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),

  -- Token usage (for assistant messages only)
  usage_input_tokens INTEGER,   -- Context sent to API
  usage_output_tokens INTEGER,  -- AI response generated
  usage_total_tokens INTEGER,   -- Sum of both

  -- User context
  user_id TEXT,  -- NULL for anonymous
  user_email TEXT,  -- For debugging
  opted_out BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_logging_messages_session ON logging_messages(session_id, timestamp);
CREATE INDEX idx_logging_messages_chart ON logging_messages(chart_id);
CREATE INDEX idx_logging_messages_message_id ON logging_messages(message_id);
CREATE INDEX idx_logging_messages_timestamp ON logging_messages(timestamp);

-- Comment
COMMENT ON TABLE logging_messages IS 'Chat message logs for AI evaluation and prompt engineering';
```

**Key Fields**:
- `message_id`: Generated on frontend BEFORE sending message. Used to link to `logging_snapshots.triggered_by_message_id`.
- `usage_*`: Only populated for assistant messages (user messages don't have output tokens).
- `content`: Full message text including embedded `[EDIT_INSTRUCTIONS]` for assistant messages.

#### 3. `logging_snapshots`

**Purpose**: Store complete graph state after every edit with metadata about what caused the change.

```sql
CREATE TABLE logging_snapshots (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES logging_sessions(session_id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,  -- Order within session (1, 2, 3...)
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE CASCADE,

  -- Graph state
  graph_data JSONB NOT NULL,  -- Complete ToCData structure
  timestamp TIMESTAMP DEFAULT NOW(),

  -- Edit metadata
  edit_type VARCHAR(20) NOT NULL CHECK (edit_type IN ('ai_edit', 'manual_edit', 'undo', 'redo', 'initial')),
  triggered_by_message_id UUID REFERENCES logging_messages(message_id),  -- Links to AI message
  edit_instructions JSONB,  -- Raw JSON for AI edits: [{"type": "update", "path": "...", "value": ...}]

  -- Success tracking
  edit_success BOOLEAN DEFAULT TRUE,
  error_message TEXT,  -- Detailed error if edit_success = false

  -- User context
  user_id TEXT,
  user_email TEXT,  -- For debugging
  is_authenticated BOOLEAN DEFAULT FALSE,
  opted_out BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT NOW(),

  -- Ensure correct ordering within session
  UNIQUE(session_id, sequence_number)
);

-- Indexes
CREATE INDEX idx_logging_snapshots_session_seq ON logging_snapshots(session_id, sequence_number);
CREATE INDEX idx_logging_snapshots_chart ON logging_snapshots(chart_id);
CREATE INDEX idx_logging_snapshots_message ON logging_snapshots(triggered_by_message_id) WHERE triggered_by_message_id IS NOT NULL;
CREATE INDEX idx_logging_snapshots_timestamp ON logging_snapshots(timestamp);
CREATE INDEX idx_logging_snapshots_edit_type ON logging_snapshots(edit_type);
CREATE INDEX idx_logging_snapshots_opted_out ON logging_snapshots(opted_out, timestamp) WHERE opted_out = false;

-- Comment
COMMENT ON TABLE logging_snapshots IS 'Graph state snapshots after each edit for replay and evaluation';
```

**Key Fields**:
- `sequence_number`: Guarantees correct order even with concurrent edits or clock skew
- `edit_type`:
  - `'initial'`: First snapshot when session starts
  - `'ai_edit'`: AI generated edit instructions
  - `'manual_edit'`: User dragged/edited nodes directly
  - `'undo'`: User pressed Ctrl+Z
  - `'redo'`: User pressed Ctrl+Shift+Z
- `triggered_by_message_id`: Links AI edits back to the assistant message that generated them
- `edit_instructions`: Raw JSON from `[EDIT_INSTRUCTIONS]` block for debugging
- `edit_success`: Whether edit instructions applied cleanly

---

## Data Flow Architecture

### Flow 1: User Sends Message → AI Edit

```
1. User types: "Add 3 climate impact nodes"
   │
   ├─► Frontend: Generate message_id = UUID
   │
   ├─► Save to logging_messages:
   │   - role: 'user'
   │   - message_id: 'user-msg-001'
   │   - content: "Add 3 climate impact nodes"
   │
   ├─► Send to AI API (Anthropic)
   │
   ├─► AI responds with edit instructions embedded
   │
   ├─► Frontend: Generate assistant message_id = UUID
   │
   ├─► Save AI response to logging_messages:
   │   - role: 'assistant'
   │   - message_id: 'ai-msg-001'
   │   - content: "I'll add them...[EDIT_INSTRUCTIONS]..."
   │   - usage_output_tokens: 450
   │
   ├─► Extract edit instructions from response
   │
   ├─► Apply edits to current graph
   │   - Success: updated graph
   │   - Failure: errors logged
   │
   ├─► Get next sequence number (atomic)
   │
   └─► Save snapshot to logging_snapshots:
       - sequence_number: 5
       - graph_data: {full updated graph}
       - edit_type: 'ai_edit'
       - triggered_by_message_id: 'ai-msg-001'  ← THE LINK
       - edit_instructions: [{...}]
       - edit_success: true/false
```

### Flow 2: User Makes Manual Edit

```
1. User drags node from column 1 → column 2
   │
   ├─► Frontend: onDataChange() triggered
   │
   ├─► Get next sequence number (atomic)
   │
   └─► Save snapshot to logging_snapshots:
       - sequence_number: 6
       - graph_data: {full updated graph}
       - edit_type: 'manual_edit'
       - triggered_by_message_id: NULL  ← No AI message
       - edit_instructions: NULL
       - edit_success: true
```

### Flow 3: Session Initialization

```
1. User opens chart at /edit/{editToken}
   │
   ├─► Frontend: Check localStorage for session
   │   ├─ Existing session found AND not expired?
   │   │  └─► Reuse session_id
   │   │
   │   └─ No session or expired?
   │      ├─► Generate new session_id = UUID
   │      ├─► Store in localStorage
   │      └─► Call API: createSession()
   │
   ├─► Backend: Insert into logging_sessions
   │   - session_id: UUID
   │   - chart_id: from route
   │   - user_id: from auth token (or NULL)
   │   - started_at: NOW()
   │
   ├─► Frontend: Save initial graph snapshot
   │
   └─► Save to logging_snapshots:
       - sequence_number: 1
       - edit_type: 'initial'
       - graph_data: {current graph state}
```

---

## Implementation Steps

### Phase 1: Database Setup

**Duration**: 1 day

1. **Create migration file**: `database/migrations/add-usage-logging.sql`

2. **Run migration** on development database:
   ```bash
   psql $DATABASE_URL < database/migrations/add-usage-logging.sql
   ```

3. **Verify tables created**:
   ```sql
   \dt logging_*
   \d logging_sessions
   \d logging_messages
   \d logging_snapshots
   ```

4. **Test with sample data**:
   ```sql
   -- Insert test session
   INSERT INTO logging_sessions (session_id, chart_id, user_id)
   VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'test123', 'user1');

   -- Insert test message
   INSERT INTO logging_messages (session_id, message_id, chart_id, role, content)
   VALUES (
     'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
     'msg-001',
     'test123',
     'user',
     'Test message'
   );

   -- Insert test snapshot
   INSERT INTO logging_snapshots (
     session_id, sequence_number, chart_id, graph_data, edit_type
   )
   VALUES (
     'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
     1,
     'test123',
     '{"sections": []}',
     'initial'
   );

   -- Verify relationships
   SELECT * FROM logging_sessions;
   SELECT * FROM logging_messages;
   SELECT * FROM logging_snapshots;
   ```

### Phase 2: Backend API Endpoints

**Duration**: 2-3 days

Create new Netlify functions in `netlify/functions/logging/`:

#### 2.1 Session Management

**File**: `netlify/functions/logging/createSession.ts`

```typescript
import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from '../utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

interface CreateSessionRequest {
  session_id: string;
  chart_id: string;
  user_agent?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { session_id, chart_id, user_agent } = JSON.parse(event.body || '{}') as CreateSessionRequest;

    if (!session_id || !chart_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'session_id and chart_id required' })
      };
    }

    // Extract user_id and email from auth token (if present)
    const token = extractToken(event.headers.authorization);
    let user_id = null;
    let user_email = null;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
        user_email = decoded.email || decoded.name;
      } catch (err) {
        console.error('[createSession] Token verification failed:', err);
        // Continue as anonymous
      }
    }

    // Database connection
    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    // Insert session using tagged template
    const result = await sql`
      INSERT INTO logging_sessions (session_id, chart_id, user_id, user_email, user_agent)
      VALUES (${session_id}, ${chart_id}, ${user_id || null}, ${user_email || null}, ${user_agent || null})
      ON CONFLICT (session_id) DO UPDATE
      SET started_at = NOW()
      RETURNING *
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0])
    };
  } catch (error) {
    console.error('Error creating session:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to create session' })
    };
  }
};
```

**File**: `netlify/functions/logging/endSession.ts`

```typescript
import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { session_id } = JSON.parse(event.body || '{}');

    if (!session_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'session_id required' })
      };
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    await sql`
      UPDATE logging_sessions
      SET ended_at = NOW()
      WHERE session_id = ${session_id} AND ended_at IS NULL
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };
  } catch (error) {
    console.error('Error ending session:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to end session' })
    };
  }
};
```

#### 2.2 Message Logging

**File**: `netlify/functions/logging/saveMessage.ts`

```typescript
import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from '../utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Logging-Opt-Out',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

interface SaveMessageRequest {
  session_id: string;
  message_id: string;
  chart_id: string;
  role: 'user' | 'assistant';
  content: string;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
  usage_total_tokens?: number;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const data = JSON.parse(event.body || '{}') as SaveMessageRequest;

    // Validate required fields
    if (!data.session_id || !data.message_id || !data.chart_id || !data.role || !data.content) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    // Check opt-out status from header
    const optedOut = event.headers['x-logging-opt-out'] === 'true';

    // Extract user info from auth token
    const token = extractToken(event.headers.authorization);
    let user_id = null;
    let user_email = null;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
        user_email = decoded.email || decoded.name;
      } catch (err) {
        console.error('[saveMessage] Token verification failed:', err);
        // Continue as anonymous
      }
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    const result = await sql`
      INSERT INTO logging_messages (
        session_id, message_id, chart_id, role, content,
        usage_input_tokens, usage_output_tokens, usage_total_tokens,
        user_id, user_email, opted_out
      )
      VALUES (
        ${data.session_id}, ${data.message_id}, ${data.chart_id},
        ${data.role}, ${data.content},
        ${data.usage_input_tokens || null}, ${data.usage_output_tokens || null},
        ${data.usage_total_tokens || null},
        ${user_id || null}, ${user_email || null}, ${optedOut}
      )
      ON CONFLICT (message_id) DO NOTHING
      RETURNING *
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0] || { message: 'Message already exists' })
    };
  } catch (error) {
    console.error('Error saving message:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to save message' })
    };
  }
};
```

#### 2.3 Graph Snapshot Logging

**File**: `netlify/functions/logging/saveSnapshot.ts`

```typescript
import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from '../utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Logging-Opt-Out',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

interface SaveSnapshotRequest {
  session_id: string;
  chart_id: string;
  graph_data: any;  // ToCData structure
  edit_type: 'ai_edit' | 'manual_edit' | 'undo' | 'redo' | 'initial';
  triggered_by_message_id?: string | null;
  edit_instructions?: any[] | null;
  edit_success?: boolean;
  error_message?: string | null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const data = JSON.parse(event.body || '{}') as SaveSnapshotRequest;

    // Validate required fields
    if (!data.session_id || !data.chart_id || !data.graph_data || !data.edit_type) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    const optedOut = event.headers['x-logging-opt-out'] === 'true';

    // Extract user info and auth status
    const token = extractToken(event.headers.authorization);
    let user_id = null;
    let user_email = null;
    let is_authenticated = false;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
        user_email = decoded.email || decoded.name;
        is_authenticated = true;
      } catch (err) {
        console.error('[saveSnapshot] Token verification failed:', err);
        // Continue as anonymous
      }
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    // Atomically get next sequence number and insert snapshot
    const result = await sql`
      WITH next_seq AS (
        SELECT COALESCE(MAX(sequence_number), 0) + 1 as seq
        FROM logging_snapshots
        WHERE session_id = ${data.session_id}
        FOR UPDATE  -- Lock to prevent race condition
      )
      INSERT INTO logging_snapshots (
        session_id, sequence_number, chart_id, graph_data,
        edit_type, triggered_by_message_id, edit_instructions,
        edit_success, error_message, user_id, user_email,
        is_authenticated, opted_out
      )
      SELECT
        ${data.session_id}, seq, ${data.chart_id}, ${JSON.stringify(data.graph_data)},
        ${data.edit_type}, ${data.triggered_by_message_id || null},
        ${data.edit_instructions ? JSON.stringify(data.edit_instructions) : null},
        ${data.edit_success !== false}, ${data.error_message || null},
        ${user_id || null}, ${user_email || null}, ${is_authenticated}, ${optedOut}
      FROM next_seq
      RETURNING *
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0])
    };
  } catch (error) {
    console.error('Error saving snapshot:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to save snapshot' })
    };
  }
};
```

### Phase 3: Frontend Integration

**Duration**: 3-4 days

#### 3.1 Session Management Service

**File**: `src/services/loggingService.ts`

```typescript
import { ChartService } from './chartService';

const API_BASE = '/.netlify/functions/logging';

export interface LoggingSession {
  session_id: string;
  chart_id: string;
  user_id?: string;
  started_at: string;
  ended_at?: string;
}

class LoggingService {
  private static authToken: string | null = null;
  private currentSessionId: string | null = null;
  private sessionTimeout: NodeJS.Timeout | null = null;
  private readonly SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Set auth token (called from App.tsx)
   */
  static setAuthToken(token: string | null) {
    this.authToken = token;
  }

  /**
   * Get current auth token
   */
  private getAuthToken(): string | null {
    return LoggingService.authToken;
  }

  /**
   * Initialize or resume a session
   */
  async initializeSession(chartId: string): Promise<string> {
    // Check if we have an existing valid session
    const existingSessionId = localStorage.getItem('loggingSessionId');
    const sessionExpiry = localStorage.getItem('loggingSessionExpiry');

    if (existingSessionId && sessionExpiry) {
      const expiryTime = parseInt(sessionExpiry, 10);
      if (Date.now() < expiryTime) {
        // Session still valid
        this.currentSessionId = existingSessionId;
        this.resetSessionTimeout();
        return existingSessionId;
      }
    }

    // Create new session
    const sessionId = crypto.randomUUID();

    try {
      await this.createSession(sessionId, chartId);

      this.currentSessionId = sessionId;
      localStorage.setItem('loggingSessionId', sessionId);
      this.resetSessionTimeout();

      return sessionId;
    } catch (error) {
      console.error('Failed to create session:', error);
      // Continue with client-side session ID even if backend fails
      this.currentSessionId = sessionId;
      localStorage.setItem('loggingSessionId', sessionId);
      this.resetSessionTimeout();
      return sessionId;
    }
  }

  /**
   * Create session on backend
   */
  private async createSession(sessionId: string, chartId: string): Promise<void> {
    const token = this.getAuthToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (this.isOptedOut()) {
      headers['X-Logging-Opt-Out'] = 'true';
    }

    await fetch(`${API_BASE}/createSession`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: sessionId,
        chart_id: chartId,
        user_agent: navigator.userAgent,
      }),
    });
  }

  /**
   * End current session
   */
  async endSession(): Promise<void> {
    if (!this.currentSessionId) return;

    try {
      await fetch(`${API_BASE}/endSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.currentSessionId }),
      });
    } catch (error) {
      console.error('Failed to end session:', error);
    }

    this.clearSession();
  }

  /**
   * Reset session timeout (call on user activity)
   */
  resetSessionTimeout(): void {
    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
    }

    const expiryTime = Date.now() + this.SESSION_DURATION_MS;
    localStorage.setItem('loggingSessionExpiry', expiryTime.toString());

    this.sessionTimeout = setTimeout(() => {
      this.endSession();
    }, this.SESSION_DURATION_MS);
  }

  /**
   * Clear session data
   */
  private clearSession(): void {
    this.currentSessionId = null;
    localStorage.removeItem('loggingSessionId');
    localStorage.removeItem('loggingSessionExpiry');
    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
      this.sessionTimeout = null;
    }
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Check if user has opted out of logging
   */
  isOptedOut(): boolean {
    return localStorage.getItem('usageLoggingOptOut') === 'true';
  }

  /**
   * Set opt-out preference
   */
  setOptOut(optOut: boolean): void {
    localStorage.setItem('usageLoggingOptOut', optOut ? 'true' : 'false');
  }
}

export const loggingService = new LoggingService();
```

#### 3.2 Update Chat Service

**File**: `src/services/chatService.ts` (modifications)

Add logging to existing chat service. Insert this code at the beginning of the file:

```typescript
import { loggingService } from './loggingService';

// Helper function to save message to logging backend
async function saveMessageToBackend(data: {
  session_id: string;
  message_id: string;
  chart_id: string;
  role: 'user' | 'assistant';
  content: string;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
  usage_total_tokens?: number;
}): Promise<void> {
  const token = LoggingService.authToken;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (loggingService.isOptedOut()) {
    headers['X-Logging-Opt-Out'] = 'true';
  }

  try {
    await fetch('/.netlify/functions/logging/saveMessage', {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });
  } catch (error) {
    console.error('Failed to save message:', error);
    // Don't throw - logging failures shouldn't break the app
  }
}
```

Then modify the `streamMessage()` method to add logging calls:

```typescript
// In streamMessage() method, BEFORE calling edge function:
const sessionId = loggingService.getCurrentSessionId();
if (!sessionId) {
  console.warn('No active logging session');
}

// Generate stable message ID for user message
const userMessageId = crypto.randomUUID();

// Save user message (if we have a session)
if (sessionId && chartId) {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === 'user') {
    await saveMessageToBackend({
      session_id: sessionId,
      message_id: userMessageId,
      chart_id: chartId,
      role: 'user',
      content: lastMessage.content,
    });
  }
}

// ... existing code to call edge function ...

// In the onComplete callback, after receiving AI response:
const assistantMessageId = crypto.randomUUID();

if (sessionId && chartId) {
  await saveMessageToBackend({
    session_id: sessionId,
    message_id: assistantMessageId,
    chart_id: chartId,
    role: 'assistant',
    content: message,
    usage_input_tokens: usage?.input_tokens,
    usage_output_tokens: usage?.output_tokens,
    usage_total_tokens: usage?.total_tokens,
  });
}

// Pass assistantMessageId to callback so it can be used for linking
callbacks.onComplete?.(message, editInstructions, usage, assistantMessageId);
```

**Note**: Update the `onComplete` callback signature to accept `assistantMessageId`:
```typescript
onComplete?: (message: string, editInstructions?: EditInstruction[], usage?: any, messageId?: string) => void;
```

#### 3.3 Update Graph Editing Logic

**File**: `src/App.tsx` (modifications)

Add imports:
```typescript
import { loggingService, LoggingService } from './services/loggingService';
import { saveSnapshot } from './services/snapshotService';
```

Add session initialization in useEffect:
```typescript
useEffect(() => {
  // Initialize logging session on mount
  const initSession = async () => {
    if (currentChartId) {
      await loggingService.initializeSession(currentChartId);

      // Save initial snapshot
      const sessionId = loggingService.getCurrentSessionId();
      if (sessionId) {
        await saveSnapshot({
          session_id: sessionId,
          chart_id: currentChartId,
          graph_data: data,
          edit_type: 'initial',
        });
      }
    }
  };

  initSession();

  // Set auth token for logging service
  if (accessToken) {
    LoggingService.setAuthToken(accessToken);
  }

  // Reset timeout on user activity
  const handleActivity = () => {
    loggingService.resetSessionTimeout();
  };

  window.addEventListener('mousemove', handleActivity);
  window.addEventListener('keypress', handleActivity);

  // Cleanup on unmount
  return () => {
    loggingService.endSession();
    window.removeEventListener('mousemove', handleActivity);
    window.removeEventListener('keypress', handleActivity);
  };
}, [currentChartId, accessToken]);
```

Update `handleDataChange` to save snapshots:
```typescript
const handleDataChange = async (
  newData: ToCData,
  editType: 'manual_edit' | 'undo' | 'redo' = 'manual_edit'
) => {
  // Update local state
  setData(newData);
  setHasUnsavedChanges(true);

  // Save to backend (existing logic)
  debouncedSave(newData);

  // Save snapshot for logging
  const sessionId = loggingService.getCurrentSessionId();
  if (sessionId && currentChartId) {
    await saveSnapshot({
      session_id: sessionId,
      chart_id: currentChartId,
      graph_data: newData,
      edit_type: editType,
    });
  }
};
```

Locate undo/redo handlers and update them:
```typescript
const handleUndo = async () => {
  // ... existing undo logic ...
  await handleDataChange(previousGraph, 'undo');
};

const handleRedo = async () => {
  // ... existing redo logic ...
  await handleDataChange(nextGraph, 'redo');
};
```

#### 3.4 Update Edit Application Logic

**File**: `src/utils/graphEdits.ts` (modifications)

Update the return type:
```typescript
export interface ApplyEditsResult {
  result: ToCData;
  success: boolean;
  errors: string[];
  instructions: EditInstruction[];
}

export function applyEdits(
  graph: ToCData,
  edits: EditInstruction[]
): ApplyEditsResult {
  let result = cloneDeep(graph);
  const errors: string[] = [];

  for (const edit of edits) {
    try {
      result = applySingleEdit(result, edit);
    } catch (error) {
      const errorMsg = `Failed to apply ${edit.type} at ${edit.path}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      errors.push(errorMsg);
      console.error(errorMsg, edit);
      // Continue with remaining edits instead of throwing
    }
  }

  return {
    result,
    success: errors.length === 0,
    errors,
    instructions: edits,
  };
}
```

**File**: `src/components/ChatInterface.tsx` (modifications)

Update AI edit application:
```typescript
// In handleSendMessage after receiving AI response
const assistantMessage = await sendMessage(inputValue, chartId, currentGraph);

// Extract and apply edits
const editInstructions = extractEditInstructions(assistantMessage.content);

if (editInstructions.length > 0) {
  const { result, success, errors, instructions } = applyEdits(
    currentGraph,
    editInstructions
  );

  // Update graph
  onGraphUpdate(result);

  // Save snapshot with AI edit metadata
  const sessionId = loggingService.getCurrentSessionId();
  if (sessionId) {
    await saveSnapshot({
      session_id: sessionId,
      chart_id: chartId,
      graph_data: result,
      edit_type: 'ai_edit',
      triggered_by_message_id: assistantMessage.id,  // Link to AI message!
      edit_instructions: instructions,
      edit_success: success,
      error_message: errors.length > 0 ? errors.join('; ') : null,
    });
  }

  if (!success) {
    // Show error to user
    console.error('Some edits failed:', errors);
    // Optionally add error message to chat
  }
}
```

#### 3.5 Snapshot Service

**File**: `src/services/snapshotService.ts` (new file)

```typescript
import { ToCData } from '../types';
import { loggingService, LoggingService } from './loggingService';

interface SaveSnapshotParams {
  session_id: string;
  chart_id: string;
  graph_data: ToCData;
  edit_type: 'ai_edit' | 'manual_edit' | 'undo' | 'redo' | 'initial';
  triggered_by_message_id?: string | null;
  edit_instructions?: any[] | null;
  edit_success?: boolean;
  error_message?: string | null;
}

export async function saveSnapshot(params: SaveSnapshotParams): Promise<void> {
  const token = LoggingService.authToken;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (loggingService.isOptedOut()) {
    headers['X-Logging-Opt-Out'] = 'true';
  }

  try {
    await fetch('/.netlify/functions/logging/saveSnapshot', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
  } catch (error) {
    console.error('Failed to save snapshot:', error);
    // Don't throw - logging failures shouldn't break the app
  }
}
```

### Phase 4: Privacy & Opt-Out UI

**Duration**: 1 day

#### 4.1 Opt-Out Component

**File**: `src/components/UsageLoggingBanner.tsx` (new file)

```typescript
import React, { useState, useEffect } from 'react';
import { loggingService } from '../services/loggingService';

export const UsageLoggingBanner: React.FC = () => {
  const [isOptedOut, setIsOptedOut] = useState(false);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    // Check if user has already made a choice
    const hasSeenBanner = localStorage.getItem('loggingBannerSeen') === 'true';
    const optedOut = loggingService.isOptedOut();

    setIsOptedOut(optedOut);
    setShowBanner(!hasSeenBanner);
  }, []);

  const handleOptOut = (optOut: boolean) => {
    loggingService.setOptOut(optOut);
    setIsOptedOut(optOut);
    localStorage.setItem('loggingBannerSeen', 'true');
    setShowBanner(false);
  };

  const handleDismiss = () => {
    localStorage.setItem('loggingBannerSeen', 'true');
    setShowBanner(false);
  };

  if (!showBanner) {
    return null;
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-blue-50 border-t border-blue-200 p-4 shadow-lg z-50">
      <div className="max-w-4xl mx-auto flex items-center justify-between">
        <div className="flex-1 pr-4">
          <p className="text-sm text-gray-800">
            <strong>Help us improve:</strong> We collect anonymized usage data
            (chat messages and graph edits) to improve our AI assistant.
            Your data is used solely for research and is not shared with third parties.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleOptOut(false)}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Allow
          </button>
          <button
            onClick={() => handleOptOut(true)}
            className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
          >
            Opt Out
          </button>
          <button
            onClick={handleDismiss}
            className="px-4 py-2 text-gray-600 hover:text-gray-800"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};
```

#### 4.2 Settings Page Integration

Add opt-out toggle to settings page:

```typescript
import { loggingService } from '../services/loggingService';

const SettingsPage: React.FC = () => {
  const [optedOut, setOptedOut] = useState(loggingService.isOptedOut());

  const handleToggle = () => {
    const newValue = !optedOut;
    loggingService.setOptOut(newValue);
    setOptedOut(newValue);
  };

  return (
    <div className="settings-page">
      {/* Other settings... */}

      <div className="setting-item">
        <h3>Usage Data Collection</h3>
        <label>
          <input
            type="checkbox"
            checked={!optedOut}
            onChange={handleToggle}
          />
          <span>
            Allow usage data collection to help improve AI features
          </span>
        </label>
        <p className="text-sm text-gray-600">
          We collect chat messages and graph edits to evaluate and improve
          our AI assistant's prompt engineering. All data is anonymized and
          used solely for research purposes.
        </p>
      </div>
    </div>
  );
};
```

---

## API Endpoints

### Summary Table

| Endpoint | Method | Purpose | Request Body | Response |
|----------|--------|---------|--------------|----------|
| `/logging/createSession` | POST | Initialize new session | `{session_id, chart_id, user_agent}` | Session object |
| `/logging/endSession` | POST | Mark session as ended | `{session_id}` | `{success: true}` |
| `/logging/saveMessage` | POST | Store chat message | `{session_id, message_id, chart_id, role, content, usage_*}` | Message object |
| `/logging/saveSnapshot` | POST | Store graph snapshot | `{session_id, chart_id, graph_data, edit_type, ...}` | Snapshot object |

### Authentication

All endpoints accept optional `Authorization: Bearer <token>` header:
- If present: User ID extracted from JWT token
- If absent: User treated as anonymous (`user_id = NULL`)

### Opt-Out Header

All endpoints respect `X-Logging-Opt-Out: true` header:
- If present: Data saved with `opted_out = true`
- Queries for analysis should filter `WHERE opted_out = false`

---

## Privacy & Opt-Out

### Implementation Details

1. **Opt-out banner**: Shown on first visit to any chart
2. **Settings toggle**: Available in user settings
3. **LocalStorage key**: `usageLoggingOptOut` (true/false)
4. **Database flag**: `opted_out` column in all tables
5. **Header propagation**: `X-Logging-Opt-Out` sent with all API requests

### Data Retention Policy

- **Opted-out data**: Flagged but not deleted (for audit purposes)
- **Query filtering**: All analysis queries must include `WHERE opted_out = false`
- **Anonymization**: No PII stored; user_id is Auth0 subject identifier
- **Retention period**: TBD (recommend 1 year, then archive/delete)

### GDPR/Privacy Compliance

**TODO for legal team**:
- Update privacy policy to disclose data collection
- Add data export endpoint (GDPR right to access)
- Add data deletion endpoint (GDPR right to erasure)
- Document data processing agreement

---

## Query Examples for Analysis

### 1. Session Timeline Reconstruction

```sql
-- Get complete session history with messages and snapshots interleaved
SELECT
  'message' as event_type,
  lm.timestamp,
  lm.role,
  lm.content,
  NULL as edit_type,
  NULL as sequence_number,
  lm.message_id as event_id
FROM logging_messages lm
WHERE lm.session_id = 'TARGET_SESSION_ID'
  AND lm.opted_out = false

UNION ALL

SELECT
  'snapshot' as event_type,
  ls.timestamp,
  NULL as role,
  LEFT(ls.graph_data::text, 100) as content,  -- Preview
  ls.edit_type,
  ls.sequence_number,
  ls.id::text as event_id
FROM logging_snapshots ls
WHERE ls.session_id = 'TARGET_SESSION_ID'
  AND ls.opted_out = false

ORDER BY timestamp;
```

### 2. AI Edit Success Rate

```sql
-- Overall success rate
SELECT
  COUNT(*) as total_ai_edits,
  SUM(CASE WHEN edit_success THEN 1 ELSE 0 END) as successful_edits,
  ROUND(100.0 * SUM(CASE WHEN edit_success THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate_percent
FROM logging_snapshots
WHERE edit_type = 'ai_edit'
  AND opted_out = false;
```

### 3. Prompts That Lead to Failures

```sql
-- Find common patterns in prompts that caused failed edits
SELECT
  lm.content as user_prompt,
  COUNT(*) as failure_count,
  STRING_AGG(DISTINCT ls.error_message, '; ') as error_messages
FROM logging_snapshots ls
JOIN logging_messages lm ON ls.triggered_by_message_id = lm.message_id
WHERE ls.edit_type = 'ai_edit'
  AND ls.edit_success = false
  AND ls.opted_out = false
GROUP BY lm.content
ORDER BY failure_count DESC
LIMIT 20;
```

### 4. Export Session for Replay

```sql
-- Export complete session data as JSON for replay/debugging
SELECT json_build_object(
  'session', (
    SELECT row_to_json(s)
    FROM logging_sessions s
    WHERE s.session_id = 'TARGET_SESSION_ID'
  ),
  'messages', (
    SELECT json_agg(row_to_json(m) ORDER BY m.timestamp)
    FROM logging_messages m
    WHERE m.session_id = 'TARGET_SESSION_ID'
      AND m.opted_out = false
  ),
  'snapshots', (
    SELECT json_agg(row_to_json(ls) ORDER BY ls.sequence_number)
    FROM logging_snapshots ls
    WHERE ls.session_id = 'TARGET_SESSION_ID'
      AND ls.opted_out = false
  )
) as session_data;
```

### 5. Create Evaluation Dataset

```sql
-- Export prompt-completion pairs for future AI evaluation
SELECT
  lm_user.content as user_prompt,
  lm_ai.content as ai_response,
  ls.edit_instructions as generated_edits,
  ls.edit_success as success,
  ls.error_message,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM logging_snapshots ls2
      WHERE ls2.session_id = ls.session_id
        AND ls2.sequence_number = ls.sequence_number + 1
        AND ls2.edit_type = 'undo'
    ) THEN true
    ELSE false
  END as was_undone
FROM logging_snapshots ls
JOIN logging_messages lm_ai ON ls.triggered_by_message_id = lm_ai.message_id
LEFT JOIN LATERAL (
  SELECT content
  FROM logging_messages
  WHERE session_id = ls.session_id
    AND timestamp < lm_ai.timestamp
    AND role = 'user'
  ORDER BY timestamp DESC
  LIMIT 1
) lm_user ON true
WHERE ls.edit_type = 'ai_edit'
  AND ls.opted_out = false
ORDER BY ls.timestamp;
```

---

## Testing Strategy

### Unit Tests

1. **loggingService.ts**:
   - Session creation and expiration
   - Timeout reset logic
   - Opt-out preference storage

2. **graphEdits.ts**:
   - Error handling in `applyEdits()`
   - Success/failure reporting
   - Multiple edit scenarios

3. **snapshotService.ts**:
   - API call construction
   - Error handling (silent failures)

### Integration Tests

1. **Session Flow**:
   ```typescript
   test('creates new session on first load', async () => {
     const chartId = 'test123';
     const sessionId = await loggingService.initializeSession(chartId);

     expect(sessionId).toBeDefined();
     expect(localStorage.getItem('loggingSessionId')).toBe(sessionId);

     // Verify backend received request
     const session = await fetchSession(sessionId);
     expect(session.chart_id).toBe(chartId);
   });
   ```

2. **Message → Edit Linking**:
   ```typescript
   test('links AI message to resulting snapshot', async () => {
     const aiMsg = await receiveAIResponse();
     const { result } = applyEdits(graph, edits);

     await saveSnapshot({
       session_id: sessionId,
       chart_id: chartId,
       graph_data: result,
       edit_type: 'ai_edit',
       triggered_by_message_id: aiMsg.id,
     });

     const snapshot = await fetchLatestSnapshot(sessionId);
     expect(snapshot.triggered_by_message_id).toBe(aiMsg.id);
   });
   ```

3. **Opt-Out Enforcement**:
   ```typescript
   test('respects opt-out preference', async () => {
     loggingService.setOptOut(true);

     await saveSnapshot({...});

     const snapshot = await fetchLatestSnapshot(sessionId);
     expect(snapshot.opted_out).toBe(true);
   });
   ```

### Manual Testing Checklist

- [ ] Create new chart → Verify session created
- [ ] Send 5 messages → Verify all saved to `logging_messages`
- [ ] AI makes edit → Verify snapshot links to message
- [ ] Manually drag node → Verify snapshot saved with `edit_type='manual_edit'`
- [ ] Undo AI edit → Verify undo snapshot created
- [ ] Close tab, reopen → Verify session resumed
- [ ] Wait 30 minutes → Verify session expired
- [ ] Toggle opt-out → Verify new data flagged with `opted_out=true`
- [ ] Run query for timeline → Verify correct ordering

---

## Deployment Checklist

### Pre-Deployment

- [ ] **Database migration** created and tested on staging
- [ ] **Environment variables** verified (NETLIFY_DATABASE_URL)
- [ ] **API endpoints** deployed and tested
- [ ] **Frontend code** merged and built successfully
- [ ] **Privacy policy** updated (legal team)
- [ ] **Opt-out banner** tested and functional

### Deployment Steps

1. **Run database migration** on production:
   ```bash
   psql $DATABASE_URL_PROD < database/migrations/add-usage-logging.sql
   ```

2. **Deploy Netlify functions**:
   ```bash
   git push origin main
   # Wait for Netlify auto-deploy
   ```

3. **Verify deployment**:
   ```bash
   # Test session creation
   curl -X POST https://your-app.netlify.app/.netlify/functions/logging/createSession \
     -H "Content-Type: application/json" \
     -d '{"session_id":"test-123","chart_id":"abc"}'

   # Check database
   psql $DATABASE_URL_PROD -c "SELECT COUNT(*) FROM logging_sessions;"
   ```

4. **Monitor for errors**:
   - Check Netlify function logs
   - Check frontend console for errors
   - Monitor database query performance

### Post-Deployment

- [ ] Smoke test: Create chart, send messages, verify data saved
- [ ] Monitor database size growth
- [ ] Set up alerts for high error rates
- [ ] Schedule weekly review of data quality

### Rollback Plan

If critical issues occur:

1. **Disable logging** via feature flag:
   ```typescript
   // Add to loggingService.ts
   const LOGGING_ENABLED = false;  // Emergency kill switch

   if (!LOGGING_ENABLED) return;
   ```

2. **Revert database migration** (if needed):
   ```sql
   DROP TABLE IF EXISTS logging_snapshots CASCADE;
   DROP TABLE IF EXISTS logging_messages CASCADE;
   DROP TABLE IF EXISTS logging_sessions CASCADE;
   ```

---

## Future Enhancements

### Phase 2 Features (When Building Evals)

1. **User feedback collection**:
   - Thumbs up/down on AI responses
   - "Report issue" button for bad suggestions
   - Database table: `logging_feedback`

2. **Real-time monitoring dashboard**:
   - Live success rate metrics
   - Recent failures list
   - Token usage trends

3. **Automated quality detection**:
   - Detect edit corrections automatically
   - Flag problematic prompts
   - Database table: `logging_corrections`

4. **Data export API**:
   - GDPR-compliant data export for users
   - Endpoint: `GET /logging/exportUserData?user_id=X`

5. **Replay UI**:
   - Visual session replay in admin panel
   - Step through edits with timeline scrubber

### Performance Optimizations

1. **Async writes**: Use message queue (e.g., SQS, Redis) for non-blocking saves
2. **Batching**: Batch multiple snapshots into single database write
3. **Compression**: Compress `graph_data` JSONB (PostgreSQL built-in)
4. **Partitioning**: Partition tables by date for faster queries
5. **Archival**: Move old data (>6 months) to cold storage

---

## Appendix A: Complete Migration SQL

**File**: `database/migrations/add-usage-logging.sql`

```sql
-- Migration: Usage Logging System
-- Created: 2025-11-14
-- Purpose: Track user sessions, chat messages, and graph edits for AI evaluation

BEGIN;

-- Table 1: Session tracking
CREATE TABLE logging_sessions (
  session_id UUID PRIMARY KEY,
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE CASCADE,
  user_id TEXT,
  user_email TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  opted_out BOOLEAN DEFAULT FALSE,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_logging_sessions_chart ON logging_sessions(chart_id);
CREATE INDEX idx_logging_sessions_user ON logging_sessions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_logging_sessions_started ON logging_sessions(started_at);

COMMENT ON TABLE logging_sessions IS 'User session tracking for usage logging and future evaluation';

-- Table 2: Chat message logs
CREATE TABLE logging_messages (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES logging_sessions(session_id) ON DELETE CASCADE,
  message_id UUID NOT NULL UNIQUE,
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  usage_input_tokens INTEGER,
  usage_output_tokens INTEGER,
  usage_total_tokens INTEGER,
  user_id TEXT,
  user_email TEXT,
  opted_out BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_logging_messages_session ON logging_messages(session_id, timestamp);
CREATE INDEX idx_logging_messages_chart ON logging_messages(chart_id);
CREATE INDEX idx_logging_messages_message_id ON logging_messages(message_id);
CREATE INDEX idx_logging_messages_timestamp ON logging_messages(timestamp);

COMMENT ON TABLE logging_messages IS 'Chat message logs for AI evaluation and prompt engineering';

-- Table 3: Graph state snapshots
CREATE TABLE logging_snapshots (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES logging_sessions(session_id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE CASCADE,
  graph_data JSONB NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  edit_type VARCHAR(20) NOT NULL CHECK (edit_type IN ('ai_edit', 'manual_edit', 'undo', 'redo', 'initial')),
  triggered_by_message_id UUID REFERENCES logging_messages(message_id),
  edit_instructions JSONB,
  edit_success BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  user_id TEXT,
  user_email TEXT,
  is_authenticated BOOLEAN DEFAULT FALSE,
  opted_out BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(session_id, sequence_number)
);

CREATE INDEX idx_logging_snapshots_session_seq ON logging_snapshots(session_id, sequence_number);
CREATE INDEX idx_logging_snapshots_chart ON logging_snapshots(chart_id);
CREATE INDEX idx_logging_snapshots_message ON logging_snapshots(triggered_by_message_id) WHERE triggered_by_message_id IS NOT NULL;
CREATE INDEX idx_logging_snapshots_timestamp ON logging_snapshots(timestamp);
CREATE INDEX idx_logging_snapshots_edit_type ON logging_snapshots(edit_type);
CREATE INDEX idx_logging_snapshots_opted_out ON logging_snapshots(opted_out, timestamp) WHERE opted_out = false;

COMMENT ON TABLE logging_snapshots IS 'Graph state snapshots after each edit for replay and evaluation';

COMMIT;

-- Rollback script (save separately as rollback-usage-logging.sql)
-- BEGIN;
-- DROP TABLE IF EXISTS logging_snapshots CASCADE;
-- DROP TABLE IF EXISTS logging_messages CASCADE;
-- DROP TABLE IF EXISTS logging_sessions CASCADE;
-- COMMIT;
```

---

## Appendix B: Directory Structure

```
react-theory-of-change-main/
├── database/
│   └── migrations/
│       └── add-usage-logging.sql
├── netlify/
│   └── functions/
│       ├── logging/
│       │   ├── createSession.ts
│       │   ├── endSession.ts
│       │   ├── saveMessage.ts
│       │   └── saveSnapshot.ts
│       └── utils/
│           └── auth.ts (existing)
└── src/
    ├── components/
    │   ├── UsageLoggingBanner.tsx (new)
    │   └── ChatInterface.tsx (modified)
    ├── services/
    │   ├── loggingService.ts (new)
    │   ├── snapshotService.ts (new)
    │   └── chatService.ts (modified)
    ├── utils/
    │   └── graphEdits.ts (modified - return type change)
    └── App.tsx (modified)
```

---

**End of Plan**
