import { useCallback, useEffect, useRef, useState } from 'react';

export interface DashboardFilters {
  dateRange: {
    from: string | null;
    to: string | null;
  };
  meterIds: string[];
  certificateStatus: string | null;
  pageSize?: number;
}

export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  dateRange: {
    from: null,
    to: null,
  },
  meterIds: [],
  certificateStatus: null,
  pageSize: undefined,
};

const STORAGE_KEY_PREFIX = 'solaproof:filters:';
const DEBOUNCE_MS = 300;

/**
 * Build the namespaced storage key. Shape:
 *   solaproof:filters:<namespace>:<userId>
 * When no namespace is supplied the legacy key shape is preserved:
 *   solaproof:filters:<userId>
 */
function getStorageKey(
  userId: string | null | undefined,
  namespace?: string | null,
): string {
  const user = userId ?? 'anonymous';
  if (namespace) {
    return `${STORAGE_KEY_PREFIX}${namespace}:${user}`;
  }
  return `${STORAGE_KEY_PREFIX}${user}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function isValidFilters(value: unknown): value is DashboardFilters {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const dateRange = candidate.dateRange;
  if (typeof dateRange !== 'object' || dateRange === null) {
    return false;
  }
  const range = dateRange as Record<string, unknown>;
  const fromOk = range.from === null || typeof range.from === 'string';
  const toOk = range.to === null || typeof range.to === 'string';
  const meterIdsOk =
    Array.isArray(candidate.meterIds) &&
    candidate.meterIds.every((id) => typeof id === 'string');
  const statusOk =
    candidate.certificateStatus === null || typeof candidate.certificateStatus === 'string';
  const pageSizeOk =
    candidate.pageSize === undefined ||
    candidate.pageSize === null ||
    (typeof candidate.pageSize === 'number' && Number.isFinite(candidate.pageSize));
  return fromOk && toOk && meterIdsOk && statusOk && pageSizeOk;
}

function readStoredFilters<T extends DashboardFilters>(
  userId: string | null | undefined,
  namespace: string | null | undefined,
  defaults: T,
): T {
  if (!isBrowser()) {
    return defaults;
  }
  try {
    const raw = window.localStorage.getItem(getStorageKey(userId, namespace));
    if (!raw) {
      return defaults;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isValidFilters(parsed)) {
      return defaults;
    }
    return {
      ...defaults,
      dateRange: {
        from: parsed.dateRange.from,
        to: parsed.dateRange.to,
      },
      meterIds: [...parsed.meterIds],
      certificateStatus: parsed.certificateStatus,
      ...(parsed.pageSize !== undefined ? { pageSize: parsed.pageSize } : {}),
    } as T;
  } catch {
    return defaults;
  }
}

function writeStoredFilters(
  userId: string | null | undefined,
  namespace: string | null | undefined,
  filters: DashboardFilters,
): void {
  if (!isBrowser()) {
    return;
  }
  try {
    window.localStorage.setItem(
      getStorageKey(userId, namespace),
      JSON.stringify(filters),
    );
  } catch {
    // Ignore storage errors (quota exceeded, privacy mode, etc.)
  }
}

function clearStoredFilters(
  userId: string | null | undefined,
  namespace: string | null | undefined,
): void {
  if (!isBrowser()) {
    return;
  }
  try {
    window.localStorage.removeItem(getStorageKey(userId, namespace));
  } catch {
    // Ignore storage errors
  }
}

export interface UsePersistentFiltersResult<T extends DashboardFilters = DashboardFilters> {
  filters: T;
  setFilters: (next: T | ((prev: T) => T)) => void;
  updateFilters: (patch: Partial<T>) => void;
  resetFilters: () => void;
  isHydrated: boolean;
}

export interface UsePersistentFiltersOptions<T extends DashboardFilters = DashboardFilters> {
  /** Route namespace, e.g. 'dashboard' or 'certificates'. */
  namespace?: string | null;
  /** Defaults used when nothing is persisted. */
  defaults?: T;
}

/**
 * Persist dashboard filter state in localStorage.
 *
 * Backwards compatible: `usePersistentFilters(userId)` keeps the legacy
 * un-namespaced key. Pass a namespace (via the second argument or an options
 * object) to scope state per route.
 */
export function usePersistentFilters<T extends DashboardFilters = DashboardFilters>(
  userId: string | null | undefined,
  namespaceOrOptions?: string | null | UsePersistentFiltersOptions<T>,
): UsePersistentFiltersResult<T> {
  const options: UsePersistentFiltersOptions<T> =
    typeof namespaceOrOptions === 'object' && namespaceOrOptions !== null
      ? namespaceOrOptions
      : { namespace: namespaceOrOptions ?? null };
  const namespace = options.namespace ?? null;
  const defaults = (options.defaults ?? DEFAULT_DASHBOARD_FILTERS) as T;

  const [filters, setFiltersState] = useState<T>(defaults);
  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userIdRef = useRef<string | null | undefined>(userId);
  const namespaceRef = useRef<string | null>(namespace);
  const defaultsRef = useRef<T>(defaults);

  // Restore persisted state on mount (and when the user or namespace changes).
  useEffect(() => {
    userIdRef.current = userId;
    namespaceRef.current = namespace;
    defaultsRef.current = defaults;
    const restored = readStoredFilters(userId, namespace, defaults);
    setFiltersState(restored);
    setIsHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, namespace]);

  // Persist state on change with debouncing.
  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      writeStoredFilters(userIdRef.current, namespaceRef.current, filters);
      debounceRef.current = null;
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [filters, isHydrated]);

  const setFilters = useCallback((next: T | ((prev: T) => T)) => {
    setFiltersState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      return {
        ...resolved,
        dateRange: {
          from: resolved.dateRange.from,
          to: resolved.dateRange.to,
        },
        meterIds: [...resolved.meterIds],
        certificateStatus: resolved.certificateStatus,
      } as T;
    });
  }, []);

  const updateFilters = useCallback((patch: Partial<T>) => {
    setFiltersState((prev) => {
      const next: T = {
        ...prev,
        ...patch,
        dateRange: patch.dateRange
          ? {
              from: patch.dateRange.from,
              to: patch.dateRange.to,
            }
          : prev.dateRange,
        meterIds: patch.meterIds ? [...patch.meterIds] : prev.meterIds,
        certificateStatus:
          patch.certificateStatus !== undefined
            ? patch.certificateStatus
            : prev.certificateStatus,
      } as T;
      return next;
    });
  }, []);

  const resetFilters = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    clearStoredFilters(userIdRef.current, namespaceRef.current);
    setFiltersState(defaultsRef.current);
  }, []);

  return {
    filters,
    setFilters,
    updateFilters,
    resetFilters,
    isHydrated,
  };
}

export default usePersistentFilters;