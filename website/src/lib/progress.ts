'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, submissionApi } from './api';
import type { SubmissionListItem } from './types';

/**
 * Detailed per-problem progress is derived from the caller's own submission
 * history for routes that need solved/attempted problem IDs. Profile aggregate
 * statistics use Submission's dedicated /me/profile-stats endpoint instead.
 * One account's results are memoised per page-session. Changing accounts
 * discards that entry; completion invalidates only its owning account.
 */

const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const TTL_MS = 60_000;

export interface Progress {
  submissions: SubmissionListItem[];
  solvedIds: Set<number>;
  attemptedIds: Set<number>;
  /** True when the history was truncated at MAX_PAGES * PAGE_SIZE. */
  truncated: boolean;
}

let progressCache: {
  accountId: string;
  at: number;
  value: Promise<Progress>;
  controller: AbortController;
} | null = null;

async function loadProgress(signal: AbortSignal, isCurrent: () => boolean): Promise<Progress> {
  const submissions: SubmissionListItem[] = [];
  let page = 1;
  let truncated = false;

  for (; page <= MAX_PAGES; page += 1) {
    const res = await submissionApi.listMine({ page, limit: PAGE_SIZE }, signal);
    // Transport cancellation saves work; entry identity prevents obsolete
    // results or further pagination even when the transport ignores abort.
    if (!isCurrent()) throw new DOMException('Progress request superseded', 'AbortError');
    submissions.push(...res.items);
    if (page >= (res.pagination?.total_pages ?? 1)) break;
    if (page === MAX_PAGES) truncated = true;
  }

  const solvedIds = new Set<number>();
  const attemptedIds = new Set<number>();
  for (const submission of submissions) {
    attemptedIds.add(submission.problem_id);
    if (submission.status === 'ACCEPTED') solvedIds.add(submission.problem_id);
  }

  return { submissions, solvedIds, attemptedIds, truncated };
}

export function fetchProgress(accountId: string, force = false): Promise<Progress> {
  const fresh = progressCache?.accountId === accountId && Date.now() - progressCache.at < TTL_MS;
  if (!force && fresh && progressCache) return progressCache.value;

  if (progressCache) invalidateProgress(progressCache.accountId);
  const controller = new AbortController();
  const value: Promise<Progress> = loadProgress(
    controller.signal,
    () => progressCache?.value === value,
  ).catch((err) => {
    // An old rejection must not evict a newer account/refresh request.
    if (progressCache?.value === value) progressCache = null;
    throw err;
  });
  progressCache = { accountId, at: Date.now(), value, controller };
  return value;
}

export function invalidateProgress(accountId: string) {
  if (progressCache?.accountId !== accountId) return;
  const previous = progressCache;
  progressCache = null;
  previous.controller.abort();
}

const EMPTY: Progress = {
  submissions: [],
  solvedIds: new Set(),
  attemptedIds: new Set(),
  truncated: false,
};

/** Loads the signed-in user's progress; resolves to empty sets when signed out. */
export function useProgress(accountId: string | null): {
  progress: Progress;
  loading: boolean;
  reload: () => void;
} {
  const [snapshot, setSnapshot] = useState<{
    accountId: string;
    progress: Progress;
    loading: boolean;
  } | null>(null);
  const previousAccountRef = useRef<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useLayoutEffect(() => {
    const previous = previousAccountRef.current;
    if (previous && previous !== accountId) invalidateProgress(previous);
    previousAccountRef.current = accountId;
    if (!accountId) {
      setSnapshot(null);
      return;
    }

    // Invalidate this subscriber at commit, including unmount/StrictMode replay.
    // Its cleanup does not abort shared same-account cache work for other subscribers.
    let active = true;
    setSnapshot((current) => ({
      accountId,
      progress: current?.accountId === accountId ? current.progress : EMPTY,
      loading: true,
    }));
    fetchProgress(accountId, nonce > 0)
      .then((value) => {
        if (active) setSnapshot({ accountId, progress: value, loading: false });
      })
      .catch((err) => {
        if (!active || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (!(err instanceof ApiError && err.isUnauthorized)) {
          // Progress is decorative — a failure must not break the page.
          console.warn('progress load failed', err);
        }
        setSnapshot({ accountId, progress: EMPTY, loading: false });
      })
      .finally(() => {
        if (active) {
          setSnapshot((current) =>
            current?.accountId === accountId ? { ...current, loading: false } : current,
          );
        }
      });

    return () => {
      active = false;
    };
  }, [accountId, nonce]);

  const reload = useCallback(() => {
    if (!accountId || previousAccountRef.current !== accountId) return;
    invalidateProgress(accountId);
    setNonce((n) => n + 1);
  }, [accountId]);

  // Effect-only clearing would expose the previous owner's flags during commit.
  const owned = snapshot?.accountId === accountId ? snapshot : null;
  return {
    progress: owned?.progress ?? EMPTY,
    loading: Boolean(accountId) && (owned?.loading ?? true),
    reload,
  };
}
