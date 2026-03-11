import { ToCData } from '../types';
import { EditInstruction } from '../utils/graphEdits';
import { loggingService } from './loggingService';

const API_BASE = '/.netlify/functions';

export interface SaveSnapshotParams {
  session_id: string;
  chart_id: string;
  graph_data: ToCData;
  edit_type: 'ai_edit' | 'manual_edit' | 'undo' | 'redo' | 'initial';
  triggered_by_message_id?: string | null;
  edit_instructions?: EditInstruction[] | null;
  edit_success?: boolean;
  error_message?: string | null;
}

// Debounce state for manual edits
let snapshotTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: SaveSnapshotParams | null = null;
const DEBOUNCE_MS = 2000; // 2 second debounce

/**
 * Save snapshot with debouncing (for manual edits)
 * Batches rapid edits into single snapshot
 */
export function saveSnapshotDebounced(params: SaveSnapshotParams): void {
  // Skip if user has opted out
  if (!loggingService.isLoggingEnabled()) {
    return;
  }

  pendingSnapshot = params;

  if (snapshotTimeout) {
    clearTimeout(snapshotTimeout);
  }

  snapshotTimeout = setTimeout(async () => {
    if (pendingSnapshot) {
      await saveSnapshot(pendingSnapshot);
      pendingSnapshot = null;
    }
  }, DEBOUNCE_MS);
}

/**
 * Save snapshot immediately (for AI edits and initial snapshots).
 * Also called internally by saveSnapshotDebounced after the debounce period.
 */
export async function saveSnapshot(params: SaveSnapshotParams): Promise<void> {
  // Skip if user has opted out
  if (!loggingService.isLoggingEnabled()) {
    return;
  }

  const token = loggingService.getAuthToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${API_BASE}/logging-saveSnapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      throw new Error(`Failed to save snapshot: ${response.status}`);
    }
    loggingService.recordSuccess();
  } catch (error) {
    console.error('[SnapshotService] Failed to save snapshot:', error);
    loggingService.recordFailure();
    // Don't throw - logging failures shouldn't break the app
  }
}

/**
 * Flush any pending debounced snapshot via sendBeacon (reliable on page unload)
 */
export function flushPendingSnapshot(): void {
  if (snapshotTimeout) {
    clearTimeout(snapshotTimeout);
    snapshotTimeout = null;
  }
  if (pendingSnapshot) {
    const blob = new Blob(
      [JSON.stringify(pendingSnapshot)],
      { type: 'application/json' }
    );
    navigator.sendBeacon(`${API_BASE}/logging-saveSnapshot`, blob);
    pendingSnapshot = null;
  }
}
