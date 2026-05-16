// Tests for usePermissionsRefresh — fires a fetch on dialog open and on
// every cross-tab `storage` event, exposes the latest server-side
// `linkSharingLevel`, and signals a divergence-from-local warning the
// caller can surface in UI (plan §PR 2 Task 2.3, L1 mitigation).
//
// The hook is intentionally narrow:
//   - input:  { open, chartId, fetcher } where fetcher is the chartService call
//   - output: { serverLevel, divergedFromLocal, refresh }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePermissionsRefresh } from '../../src/hooks/usePermissionsRefresh';

let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetcher = vi.fn(async () => ({ linkSharingLevel: 'restricted' as const }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePermissionsRefresh', () => {
  it('does not fetch when dialog is closed', () => {
    renderHook(() =>
      usePermissionsRefresh({
        open: false,
        chartId: 'c1',
        localLevel: 'restricted',
        fetcher,
      }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches on open and exposes the server level', async () => {
    fetcher.mockResolvedValueOnce({ linkSharingLevel: 'viewer' as const });

    const { result } = renderHook(() =>
      usePermissionsRefresh({
        open: true,
        chartId: 'c1',
        localLevel: 'restricted',
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.serverLevel).toBe('viewer');
    });
  });

  it('flags divergence when server level differs from local', async () => {
    fetcher.mockResolvedValueOnce({ linkSharingLevel: 'editor' as const });

    const { result } = renderHook(() =>
      usePermissionsRefresh({
        open: true,
        chartId: 'c1',
        localLevel: 'restricted',
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(result.current.divergedFromLocal).toBe(true);
    });
  });

  it('does not flag divergence when server matches local', async () => {
    fetcher.mockResolvedValueOnce({ linkSharingLevel: 'restricted' as const });

    const { result } = renderHook(() =>
      usePermissionsRefresh({
        open: true,
        chartId: 'c1',
        localLevel: 'restricted',
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(result.current.serverLevel).toBe('restricted');
    });
    expect(result.current.divergedFromLocal).toBe(false);
  });

  it('refetches when a cross-tab storage event fires', async () => {
    fetcher.mockResolvedValue({ linkSharingLevel: 'restricted' as const });

    renderHook(() =>
      usePermissionsRefresh({
        open: true,
        chartId: 'c1',
        localLevel: 'restricted',
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'toc:permissions' }));
    });

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it('exposes a refresh() function callers can use to force a re-fetch', async () => {
    fetcher.mockResolvedValue({ linkSharingLevel: 'restricted' as const });

    const { result } = renderHook(() =>
      usePermissionsRefresh({
        open: true,
        chartId: 'c1',
        localLevel: 'restricted',
        fetcher,
      }),
    );

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('skips re-fetch when chartId is null (anonymous chart pre-create)', () => {
    renderHook(() =>
      usePermissionsRefresh({
        open: true,
        chartId: null,
        localLevel: 'restricted',
        fetcher,
      }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
