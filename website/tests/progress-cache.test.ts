import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submissionApi } from '../src/lib/api';
import { fetchProgress, invalidateProgress } from '../src/lib/progress';
import type { ListSubmissionsResponse, SubmissionListItem } from '../src/lib/types';
import { deferred } from './helpers/react-dom';

const accountA = 'progress-account-a';
const accountB = 'progress-account-b';

const request = (accountId: string, force = false) => fetchProgress(accountId, force);
const invalidate = (accountId: string) => invalidateProgress(accountId);

function response(
  problemId = 1,
  status: SubmissionListItem['status'] = 'ACCEPTED',
  totalPages = 1,
): ListSubmissionsResponse {
  return {
    items: [
      {
        id: problemId,
        problem_id: problemId,
        problem_title: `Problem ${problemId}`,
        language: 'CPP',
        status,
        execution_time_ms: null,
        memory_used_kb: null,
        passed_testcases: null,
        total_testcases: null,
        created_at: '2026-11-18T00:00:00Z',
      },
    ],
    pagination: { page: 1, limit: 100, total: totalPages * 100, total_pages: totalPages },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T00:00:00Z'));
  invalidate(accountA);
  invalidate(accountB);
  vi.spyOn(submissionApi, 'listMine').mockResolvedValue(response());
});
afterEach(() => {
  invalidate(accountA);
  invalidate(accountB);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('real progress cache ownership', () => {
  it('reuses a fulfilled cache entry for the same account', async () => {
    const first = request(accountA);
    const progress = await first;
    expect(request(accountA)).toBe(first);
    expect(progress.solvedIds.has(1)).toBe(true);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(1);
  });

  it('does not return A cached progress when B requests its own progress', async () => {
    const previous = await request(accountA);
    vi.mocked(submissionApi.listMine).mockResolvedValue(response(2, 'WRONG_ANSWER'));
    const current = await request(accountB);
    expect(current).not.toBe(previous);
    expect(current.solvedIds.has(1)).toBe(false);
    expect([...current.attemptedIds]).toEqual([2]);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh entry when returning A after A to B to A', async () => {
    await request(accountA);
    vi.mocked(submissionApi.listMine).mockResolvedValue(response(2));
    await request(accountB);
    vi.mocked(submissionApi.listMine).mockResolvedValue(response(3));
    expect([...(await request(accountA)).solvedIds]).toEqual([3]);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(3);
  });

  it('preserves the 60000 ms TTL and refreshes at expiration', async () => {
    const first = request(accountA);
    await first;
    vi.advanceTimersByTime(59999);
    expect(request(accountA)).toBe(first);
    vi.advanceTimersByTime(1);
    const second = request(accountA);
    expect(second).not.toBe(first);
    await second;
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
  });

  it('force refresh bypasses a fulfilled entry for the same account', async () => {
    const first = request(accountA);
    await first;
    vi.mocked(submissionApi.listMine).mockResolvedValue(response(2));
    const second = request(accountA, true);
    expect(second).not.toBe(first);
    expect([...(await second).solvedIds]).toEqual([2]);
    expect(request(accountA)).toBe(second);
  });

  it('invalidates only the named account', async () => {
    const current = request(accountB);
    await current;
    invalidate(accountA);
    expect(request(accountB)).toBe(current);
    invalidate(accountB);
    expect(request(accountB)).not.toBe(current);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent same-account requests', async () => {
    const pending = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValue(pending.promise);
    const first = request(accountA);
    const second = request(accountA);
    expect(second).toBe(first);
    pending.resolve(response());
    expect(await first).toBe(await second);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(1);
  });

  it.each(['A first', 'B first'])(
    'never shares in-flight promises across accounts: %s',
    async (order) => {
      const previous = deferred<ListSubmissionsResponse>();
      const current = deferred<ListSubmissionsResponse>();
      vi.mocked(submissionApi.listMine)
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise);
      const a = request(accountA);
      const obsolete = a.catch((error: unknown) => error);
      const b = request(accountB);
      expect(b).not.toBe(a);
      expect(vi.mocked(submissionApi.listMine).mock.calls[0][1]?.aborted).toBe(true);
      if (order === 'A first') {
        previous.resolve(response());
        await obsolete;
        current.resolve(response(2));
      } else {
        current.resolve(response(2));
        await b;
        previous.resolve(response());
      }
      expect([...(await b).solvedIds]).toEqual([2]);
      expect(await obsolete).toBeInstanceOf(DOMException);
      expect(request(accountB)).toBe(b);
    },
  );

  it('does not let an old A rejection evict B current cache', async () => {
    const pending = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(response(2));
    const first = request(accountA);
    const old = first.catch((error: unknown) => error);
    const current = request(accountB);
    expect(current).not.toBe(first);
    await current;
    pending.reject(new Error('obsolete A failure'));
    await old;
    expect(request(accountB)).toBe(current);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
  });

  it('does not let an older same-account rejection evict a forced refresh', async () => {
    const pending = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(response(2));
    const old = request(accountA).catch((error: unknown) => error);
    const current = request(accountA, true);
    await current;
    pending.reject(new Error('obsolete refresh failure'));
    await old;
    expect(request(accountA)).toBe(current);
  });

  it('clears a failed current request so a later call can retry', async () => {
    vi.mocked(submissionApi.listMine).mockRejectedValueOnce(new Error('temporary failure'));
    await expect(request(accountA)).rejects.toThrow('temporary failure');
    expect([...(await request(accountA)).solvedIds]).toEqual([1]);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
  });

  it('scoped invalidation aborts pending work even when transport later resolves', async () => {
    const pending = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValueOnce(pending.promise);
    const old = request(accountA).catch((error: unknown) => error);
    const signal = vi.mocked(submissionApi.listMine).mock.calls[0][1];
    invalidate(accountA);
    expect(signal?.aborted).toBe(true);
    const current = request(accountB);
    await current;
    pending.resolve(response());
    expect(await old).toBeInstanceOf(DOMException);
    expect(request(accountB)).toBe(current);
  });

  it('stops obsolete pagination before requesting another page with a changed session', async () => {
    const firstPage = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValue(response(2));
    const first = request(accountA);
    const old = first.catch((error: unknown) => error);
    const current = request(accountB);
    expect(current).not.toBe(first);
    await current;
    firstPage.resolve(response(1, 'ACCEPTED', 2));
    await old;
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submissionApi.listMine).mock.calls.map(([params]) => params?.page)).toEqual([
      1, 1,
    ]);
  });

  it('retains aggregation, pagination bounds and existing request parameters', async () => {
    vi.mocked(submissionApi.listMine).mockImplementation(async (params) =>
      response(params?.page, params?.page === 1 ? 'ACCEPTED' : 'WRONG_ANSWER', 11),
    );
    const result = await request(accountA);
    expect(result.truncated).toBe(true);
    expect([...result.solvedIds]).toEqual([1]);
    expect(result.attemptedIds.size).toBe(10);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(10);
    for (const [index, [params, signal]] of vi
      .mocked(submissionApi.listMine)
      .mock.calls.entries()) {
      expect(params).toEqual({ page: index + 1, limit: 100 });
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });
});
