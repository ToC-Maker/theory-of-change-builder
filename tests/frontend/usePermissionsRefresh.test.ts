// Tests for usePermissionsRefresh — now a thin storage-event adapter.
//
// As of the App-owns-permissions refactor (figma PR 2 fix-pass), the
// hook no longer fetches directly. The single source of truth for the
// permissions array + linkSharingLevel lives in App.tsx, which polls
// every 30s. This hook's only job: listen for cross-tab `storage`
// events and notify the caller to invalidate (i.e. refetch).
//
// Input:  { enabled, onInvalidate }
// Output: nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePermissionsRefresh } from '../../src/hooks/usePermissionsRefresh';

let onInvalidate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onInvalidate = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePermissionsRefresh (invalidator)', () => {
  it('does not subscribe when disabled', () => {
    renderHook(() => usePermissionsRefresh({ enabled: false, onInvalidate }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'toc:permissions' }));
    });
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('calls onInvalidate when a cross-tab storage event fires', () => {
    renderHook(() => usePermissionsRefresh({ enabled: true, onInvalidate }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'toc:permissions' }));
    });
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('is key-agnostic — any storage event triggers an invalidate', () => {
    renderHook(() => usePermissionsRefresh({ enabled: true, onInvalidate }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key' }));
    });
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('stops invoking onInvalidate after unmount', () => {
    const { unmount } = renderHook(() => usePermissionsRefresh({ enabled: true, onInvalidate }));
    unmount();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'toc:permissions' }));
    });
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('survives onInvalidate identity churn (uses a ref)', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) => usePermissionsRefresh({ enabled: true, onInvalidate: cb }),
      { initialProps: { cb: cb1 } },
    );
    rerender({ cb: cb2 });
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'toc:permissions' }));
    });
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
