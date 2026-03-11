// Re-exports from loggingService for backwards compatibility.
// Snapshot logic now lives in LoggingServiceClass to keep circuit breaker state private.
export type { SaveSnapshotParams } from './loggingService';

import { loggingService } from './loggingService';

export const saveSnapshot = loggingService.saveSnapshot.bind(loggingService);
export const saveSnapshotDebounced = loggingService.saveSnapshotDebounced.bind(loggingService);
export const flushPendingSnapshot = loggingService.flushPendingSnapshot.bind(loggingService);
