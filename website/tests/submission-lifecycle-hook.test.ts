// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubmissionLifecycle } from '../src/features/problem-workspace/hooks/useSubmissionLifecycle';
import { ApiError, NetworkError, submissionApi } from '../src/lib/api';
import type {
  CreateSubmissionResponse,
  Submission,
  SubmissionDetail,
  SubmissionStreamEvent,
} from '../src/lib/types';
import { TestEventSource } from './helpers/event-source';
import { deferred, renderReact } from './helpers/react-dom';

type Options = Parameters<typeof useSubmissionLifecycle>[0];
let latest: ReturnType<typeof useSubmissionLifecycle>;
let view: Awaited<ReturnType<typeof renderReact>> | undefined;
const created = {
  id: 41,
  problem_id: 1,
  problem_title: 'Fixture problem',
  language: 'CPP',
  status: 'PENDING' as const,
  created_at: '2026-11-17T01:00:00Z',
};
const detail: SubmissionDetail = {
  ...created,
  attempt_id: 'fixture-attempt',
  user_id: 'fixture-user',
  username: 'fixture-user',
  source_code: 'fixture source',
  status: 'ACCEPTED',
  execution_time_ms: 1,
  memory_used_kb: 100,
  passed_testcases: 1,
  total_testcases: 1,
  compile_output: null,
  error_message: null,
  updated_at: '2026-11-17T01:01:00Z',
};

function Probe(options: Options) {
  latest = useSubmissionLifecycle(options);
  return null;
}

function options(): Options {
  return {
    slug: 'fixture-problem',
    user: { id: 'fixture-user', username: 'fixture-user' },
    problem: { id: 1 },
    language: 'CPP',
    code: 'fixture source',
    online: true,
    isRunning: vi.fn(() => false),
    requireAuth: vi.fn(() => true),
    showToast: vi.fn(),
    onSubmitStart: vi.fn(),
    onCompleted: vi.fn(),
  };
}

async function terminal() {
  await act(async () => {
    TestEventSource.instances[0].emit('submission.completed', {
      submission_id: 41,
      attempt_id: 'fixture-attempt',
      status: 'ACCEPTED',
      updated_at: detail.updated_at,
    });
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', TestEventSource);
  TestEventSource.instances = [];
  vi.spyOn(submissionApi, 'create').mockResolvedValue(created);
  vi.spyOn(submissionApi, 'get').mockResolvedValue(detail);
  vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue({
    ticket: 'fixture-ticket',
    expires_at: '2026-11-17T02:00:00Z',
  });
});

afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('submission hook callback boundaries with real React', () => {
  it('uses a new completion callback before terminal delivery without reconnecting on rerender', async () => {
    const props = options();
    view = await renderReact(createElement(Probe, props));
    await act(async () => latest.submit());
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    const onCompleted = vi.fn();
    await view.rerender(
      createElement(Probe, {
        ...props,
        onCompleted,
        onSubmitStart: vi.fn(),
        isRunning: () => false,
      }),
    );
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
    expect(TestEventSource.instances).toHaveLength(1);
    expect(TestEventSource.instances[0].closed).toBe(false);
    await terminal();
    await act(async () => pending.resolve(detail));
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    expect(latest.submission).toEqual(detail);
    expect(latest.submitting).toBe(false);
  });

  it('preserves the captured completion callback for an already running terminal GET', async () => {
    const props = options();
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    view = await renderReact(createElement(Probe, props));
    await act(async () => latest.submit());
    await terminal();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    const onCompleted = vi.fn();
    await view.rerender(createElement(Probe, { ...props, onCompleted }));
    expect(signal.aborted).toBe(false);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(detail));
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('uses the current render prerequisites and keeps Run/auth guard ordering', async () => {
    const props = options();
    view = await renderReact(createElement(Probe, props));
    const isRunning = vi.fn(() => true);
    await view.rerender(createElement(Probe, { ...props, isRunning }));
    await act(async () => latest.submit());
    expect(isRunning).toHaveBeenCalledTimes(1);
    expect(props.requireAuth).not.toHaveBeenCalled();
    expect(submissionApi.create).not.toHaveBeenCalled();
    const requireAuth = vi.fn(() => false);
    await view.rerender(createElement(Probe, { ...props, requireAuth }));
    await act(async () => latest.submit());
    expect(requireAuth).toHaveBeenCalledExactlyOnceWith('submit');
    expect(submissionApi.create).not.toHaveBeenCalled();
    const onSubmitStart = vi.fn(() => expect(submissionApi.create).not.toHaveBeenCalled());
    await view.rerender(
      createElement(Probe, {
        ...props,
        problem: { id: 2 },
        language: 'JAVA',
        code: 'new source\n',
        onSubmitStart,
      }),
    );
    await act(async () => latest.submit());
    expect(onSubmitStart).toHaveBeenCalledTimes(1);
    expect(submissionApi.create).toHaveBeenCalledExactlyOnceWith(
      {
        problem_id: 2,
        language: 'JAVA',
        source_code: 'new source\n',
      },
      expect.any(Function),
    );
  });
});

describe('attempt-correlated completion', () => {
  it.each([
    ['pending B', { attempt_id: 'attempt-b', status: 'PENDING' }, 'another attempt'],
    ['terminal B with same verdict', { attempt_id: 'attempt-b' }, 'another attempt'],
    [
      'terminal B with different verdict',
      { attempt_id: 'attempt-b', status: 'WRONG_ANSWER' },
      'another attempt',
    ],
    ['old backend', {}, 'could not verify'],
    ['legacy null', { attempt_id: null }, 'could not verify'],
    ['empty identity', { attempt_id: '' }, 'could not verify'],
    ['blank identity', { attempt_id: '  ' }, 'could not verify'],
    ['wrong identity type', { attempt_id: 99 }, 'could not verify'],
    [
      'wrong submission',
      { attempt_id: 'fixture-attempt', id: 99 },
      'could not confirm a final result',
    ],
  ] as const)(
    'rejects %s and allows one matching manual completion',
    async (_name, patch, message) => {
      const props = options();
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      await mountHook(props, true);
      await act(async () => latest.submit());
      await deliverTerminal();
      const notified = latest.submission;
      const unverified: SubmissionDetail = { ...detail };
      delete unverified.attempt_id;
      await act(async () => pending.resolve({ ...unverified, ...patch }));
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
      expect(latest.submission).toBe(notified);
      expect(latest.submitting).toBe(false);
      expect(latest.detailFetchError).toContain(message);

      const matching = { ...detail, attempt_id: 'fixture-attempt' };
      vi.mocked(submissionApi.get).mockResolvedValueOnce(matching);
      await act(async () => latest.checkResultOnce());
      expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(matching);
      expect(latest.submission).toEqual(matching);
      expect(latest.detailFetchError).toBe('');
      await act(async () => latest.checkResultOnce());
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      expect(TestEventSource.instances).toHaveLength(1);
    },
  );

  it('does not let a hand-checked terminal B complete a pinned attempt A', async () => {
    const props = options();
    await mountHook(props);
    await act(async () => latest.submit());
    const source = TestEventSource.instances[0];
    await act(async () =>
      source.emit('submission.snapshot', {
        submission_id: 41,
        attempt_id: 'fixture-attempt',
        status: 'JUDGING',
        updated_at: detail.updated_at,
      }),
    );
    const current = latest.submission;
    const mismatched = { ...detail, attempt_id: 'attempt-b' };
    vi.mocked(submissionApi.get).mockResolvedValueOnce(mismatched);
    await act(async () => latest.checkResultOnce());
    expect(latest.submission).toBe(current);
    expect(latest.detailFetchError).toContain('another attempt');
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(source.closed).toBe(false);
  });

  it('uses an owned manual terminal read as current detail before SSE has delivered an attempt', async () => {
    const props = options();
    await mountHook(props);
    await pendingRecovery();
    await act(async () => latest.checkResultOnce());
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    expect(latest.submission).toEqual(detail);
  });

  it('pins even duplicate pending HTTP status as the baseline and refuses a later HTTP attempt switch', async () => {
    const props = options();
    await mountHook(props);
    await pendingRecovery();
    vi.mocked(submissionApi.get).mockResolvedValueOnce({
      ...detail,
      status: 'PENDING',
      updated_at: created.created_at,
    });
    await act(async () => latest.checkResultOnce());
    const pending = latest.submission;
    expect(pending?.status).toBe('PENDING');
    vi.mocked(submissionApi.get).mockResolvedValueOnce({ ...detail, attempt_id: 'attempt-b' });
    await act(async () => latest.checkResultOnce());
    expect(latest.submission).toBe(pending);
    expect(latest.detailFetchError).toContain('another attempt');
    expect(props.onCompleted).not.toHaveBeenCalled();
    await act(async () => latest.checkResultOnce());
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
  });

  it.each([true, false])(
    'checks an unbound GET against the first SSE pin (match=%s)',
    async (match) => {
      const props = options();
      const pending = deferred<SubmissionDetail>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      await mountHook(props);
      await act(async () => latest.submit());
      const check = await startCheck();
      const source = TestEventSource.instances[0];
      await act(async () =>
        source.emit('submission.snapshot', {
          submission_id: 41,
          attempt_id: 'fixture-attempt',
          status: 'PENDING',
          updated_at: created.created_at,
        }),
      );
      const response = { ...detail, attempt_id: match ? 'fixture-attempt' : 'attempt-b' };
      await act(async () => {
        pending.resolve(response);
        await check.done;
      });
      if (match) {
        expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(response);
        expect(latest.submission).toEqual(response);
      } else {
        expect(props.onCompleted).not.toHaveBeenCalled();
        expect(latest.detailFetchError).toContain('another attempt');
        expect(latest.submission?.status).toBe('PENDING');
        expect(source.closed).toBe(false);
      }
    },
  );

  it('ignores a late terminal GET after a new Submit in the same account and problem', async () => {
    const props = options();
    const pending = deferred<SubmissionDetail>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
    await mountHook(props);
    await pendingRecovery();
    await act(async () => latest.stream.reconnect());
    await deliverTerminal();
    const [, signal] = vi.mocked(submissionApi.get).mock.calls[0];
    vi.mocked(submissionApi.create).mockResolvedValueOnce({ ...created, id: 42 });
    await act(async () => latest.submit());
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(detail));
    expect(latest.submission).toMatchObject({ id: 42, status: 'PENDING' });
    expect(latest.submitting).toBe(true);
    expect(latest.detailFetchError).toBe('');
    expect(props.onCompleted).not.toHaveBeenCalled();
  });
});

async function mountHook(props: Options, strict = false) {
  const probe = createElement(Probe, props);
  view = await renderReact(strict ? createElement(StrictMode, null, probe) : probe);
}

async function startSubmit() {
  let done!: Promise<void>;
  await act(async () => {
    done = latest.submit();
  });
  return { done };
}

async function startCheck() {
  let done!: Promise<void>;
  await act(async () => {
    done = latest.checkResultOnce();
  });
  return { done };
}

async function disconnectStream() {
  await act(async () => TestEventSource.instances.at(-1)!.raw('submission.updated', '{invalid'));
}

async function pendingRecovery() {
  await act(async () => latest.submit());
  await disconnectStream();
}

async function deliverTerminal(id = 41) {
  await act(async () =>
    TestEventSource.instances.at(-1)!.emit('submission.completed', {
      submission_id: id,
      attempt_id: 'fixture-attempt',
      status: 'ACCEPTED',
      updated_at: detail.updated_at,
    }),
  );
}

type Invalidation = 'slug' | 'logout' | 'unmount' | 'account' | 'relogin';
async function invalidateContext(kind: Invalidation, props: Options) {
  if (kind === 'unmount') {
    await view!.unmount();
    return;
  }
  if (kind === 'relogin') {
    await view!.rerender(createElement(Probe, { ...props, user: null }));
  }
  await view!.rerender(
    createElement(Probe, {
      ...props,
      ...(kind === 'slug'
        ? { slug: 'another-problem', problem: { id: 2 } }
        : kind === 'logout'
          ? { user: null }
          : { user: { id: 'fixture-user-b', username: 'fixture-user-b' } }),
    }),
  );
}

describe('manual HTTP and SSE status reconciliation', () => {
  const judgingTime = '2026-11-17T01:00:30Z';
  const later = '2026-11-17T02:00:00Z';
  function statusEvent(status: SubmissionStreamEvent['status'], updated_at = judgingTime) {
    return { submission_id: 41, attempt_id: 'fixture-attempt', status, updated_at };
  }

  it.each(['separate acts', 'same batch', 'StrictMode'] as const)(
    'rejects stale manual PENDING after SSE JUDGING in %s and still completes',
    async (mode) => {
      const props = options();
      await mountHook(props, mode === 'StrictMode');
      await act(async () => latest.submit());
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      const check = await startCheck();
      const source = TestEventSource.instances.at(-1)!;
      const advance = () => source.emit('submission.updated', statusEvent('JUDGING'));
      if (mode !== 'same batch') await act(async () => advance());
      await act(async () => {
        if (mode === 'same batch') advance();
        pending.resolve({ ...detail, status: 'PENDING', updated_at: later });
        await check.done;
      });
      expect(latest.submission).toMatchObject({ status: 'JUDGING', updated_at: judgingTime });
      expect(latest.checkingResult).toBe(false);
      expect(latest.detailFetchError).toBe('');
      expect(props.showToast).not.toHaveBeenCalled();
      const accepted = latest.submission;
      await act(async () => {
        source.emit('submission.updated', statusEvent('PENDING', later));
        source.emit('submission.updated', statusEvent('JUDGING'));
      });
      // An unchanged object also proves the manual response did not rewind
      // the synchronous ordering ref behind the rendered JUDGING state.
      expect(latest.submission).toBe(accepted);
      await deliverTerminal();
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    },
  );

  it.each([created.created_at, judgingTime, later, '', 'invalid-time'])(
    'accepts manual JUDGING progression with timestamp %j and rejects later SSE PENDING',
    async (updated_at) => {
      const props = options();
      await mountHook(props);
      await act(async () => latest.submit());
      vi.mocked(submissionApi.get).mockResolvedValueOnce({
        ...detail,
        status: 'JUDGING',
        updated_at,
        execution_time_ms: 23,
      });
      await act(async () => latest.checkResultOnce());
      const accepted = latest.submission;
      expect(accepted).toMatchObject({
        status: 'JUDGING',
        execution_time_ms: 23,
        updated_at:
          updated_at === '' || updated_at === 'invalid-time' ? created.created_at : updated_at,
      });
      const source = TestEventSource.instances.at(-1)!;
      await act(async () => source.emit('submission.snapshot', statusEvent('PENDING', later)));
      expect(latest.submission).toBe(accepted);
      await deliverTerminal();
      expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    },
  );

  it.each(['PENDING', 'JUDGING'] as const)(
    'ignores duplicate/older/invalid manual %s metadata and merges newer metadata once',
    async (status) => {
      const props = options();
      await mountHook(props);
      await act(async () => latest.submit());
      const source = TestEventSource.instances.at(-1)!;
      await act(async () => source.emit('submission.snapshot', statusEvent(status)));
      const accepted = latest.submission;
      for (const updated_at of [
        created.created_at,
        judgingTime,
        '2026-11-17T01:00:30+00:00',
        '',
        'invalid-time',
      ]) {
        vi.mocked(submissionApi.get).mockResolvedValueOnce({ ...detail, status, updated_at });
        await act(async () => latest.checkResultOnce());
        expect(latest.submission).toBe(accepted);
        expect(latest.checkingResult).toBe(false);
        expect(latest.detailFetchError).toBe('');
      }
      expect(props.showToast).not.toHaveBeenCalled();
      vi.mocked(submissionApi.get).mockResolvedValueOnce({ ...detail, status, updated_at: later });
      await act(async () => latest.checkResultOnce());
      expect(latest.submission).toMatchObject({ status, updated_at: later, execution_time_ms: 1 });
      const refreshed = latest.submission;
      await act(async () => source.emit('submission.updated', statusEvent(status, later)));
      expect(latest.submission).toBe(refreshed);
      expect(props.showToast).toHaveBeenCalledExactlyOnceWith(
        `Submission #41 is still ${status === 'PENDING' ? 'queued' : 'judging'}.`,
        'success',
      );
    },
  );

  it('reconciles manual progression before queued SSE updates within the same React batch', async () => {
    const props = options();
    await mountHook(props);
    await act(async () => latest.submit());
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
    const check = await startCheck();
    const source = TestEventSource.instances.at(-1)!;
    await act(async () => {
      pending.resolve({ ...detail, status: 'JUDGING', updated_at: judgingTime });
      await check.done;
      source.emit('submission.updated', statusEvent('PENDING', later));
      source.emit('submission.completed', statusEvent('ACCEPTED', created.created_at));
    });
    expect(latest.submission).toEqual(detail);
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
  });

  it.each(['PENDING', 'JUDGING'] as const)(
    'keeps a terminal SSE while a stale manual %s resolves before terminal detail',
    async (status) => {
      const props = options();
      await mountHook(props);
      await act(async () => latest.submit());
      const manual = deferred<Submission>();
      const terminalDetail = deferred<Submission>();
      vi.mocked(submissionApi.get)
        .mockReturnValueOnce(manual.promise)
        .mockReturnValueOnce(terminalDetail.promise);
      const check = await startCheck();
      await deliverTerminal();
      const terminalSignal = vi.mocked(submissionApi.get).mock.calls[1][1]!;
      const accepted = latest.submission;
      await act(async () => {
        manual.resolve({ ...detail, status, updated_at: later });
        await check.done;
      });
      expect(latest.submission).toBe(accepted);
      expect(latest.submission?.status).toBe('ACCEPTED');
      expect(latest.checkingResult).toBe(false);
      expect(terminalSignal.aborted).toBe(false);
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
      await act(async () => terminalDetail.resolve(detail));
      expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps manual terminal detail authoritative over SSE without ranking terminal verdicts', async () => {
    const props = options();
    await mountHook(props);
    await act(async () => latest.submit());
    const manual = deferred<Submission>();
    const terminalDetail = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(manual.promise)
      .mockReturnValueOnce(terminalDetail.promise);
    const check = await startCheck();
    await deliverTerminal();
    const final = { ...detail, status: 'WRONG_ANSWER' as const, updated_at: created.created_at };
    await act(async () => {
      manual.resolve(final);
      await check.done;
      terminalDetail.resolve(detail);
    });
    expect(latest.submission).toEqual(final);
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(final);
  });

  it('allows terminal manual recovery after a failed terminal-detail GET', async () => {
    const props = options();
    await mountHook(props);
    await act(async () => latest.submit());
    vi.mocked(submissionApi.get).mockRejectedValueOnce(new NetworkError());
    await deliverTerminal();
    expect(latest.detailFetchError).toContain('Verdict received');
    const recovered = {
      ...detail,
      status: 'WRONG_ANSWER' as const,
      updated_at: created.created_at,
    };
    vi.mocked(submissionApi.get).mockResolvedValueOnce(recovered);
    await act(async () => latest.checkResultOnce());
    expect(latest.detailFetchError).toBe('');
    expect(latest.submission).toEqual(recovered);
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(recovered);
  });

  it('cannot identify rejudge from HTTP PENDING alone, but accepts a validated new-attempt snapshot', async () => {
    const props = options();
    await mountHook(props);
    await act(async () => latest.submit());
    await act(async () =>
      TestEventSource.instances[0].emit('submission.snapshot', statusEvent('JUDGING')),
    );
    // A newer timestamp is equally compatible with a stale current-attempt
    // snapshot or a new rejudge. The HTTP DTO supplies no attempt identity.
    vi.mocked(submissionApi.get).mockResolvedValueOnce({
      ...detail,
      status: 'PENDING',
      updated_at: later,
    });
    await act(async () => latest.checkResultOnce());
    expect(latest.submission?.status).toBe('JUDGING');
    await act(async () => latest.stream.reconnect());
    const source = TestEventSource.instances.at(-1)!;
    await act(async () =>
      source.emit('submission.snapshot', {
        ...statusEvent('PENDING', later),
        attempt_id: 'attempt-b',
      }),
    );
    expect(latest.submission?.status).toBe('PENDING');
    await act(async () =>
      source.emit('submission.updated', {
        ...statusEvent('JUDGING', later),
        attempt_id: 'attempt-b',
      }),
    );
    expect(latest.submission?.status).toBe('JUDGING');
  });

  it.each(['PENDING', 'JUDGING'] as const)(
    'does not complete on a terminal-detail GET returning %s and permits later recovery',
    async (status) => {
      const props = options();
      await mountHook(props, true);
      await act(async () => latest.submit());
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      await deliverTerminal();
      const notified = latest.submission;
      expect(notified?.status).toBe('ACCEPTED');
      // A newer timestamp cannot identify a new attempt.
      const snapshot = { ...detail, status, updated_at: later };
      await act(async () => pending.resolve(snapshot));
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
      expect(latest.submission).toBe(notified);
      expect(latest.submitting).toBe(false);
      expect(latest.stream.state).toBe('idle');
      expect(latest.detailFetchError).toMatch(/could not confirm a final result/i);
      await deliverTerminal(); // a queued duplicate must not start an automatic GET
      expect(submissionApi.get).toHaveBeenCalledTimes(1);

      vi.mocked(submissionApi.get).mockResolvedValueOnce(snapshot);
      await act(async () => latest.checkResultOnce());
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      expect(latest.submission).toBe(notified);
      expect(latest.detailFetchError).toMatch(/could not confirm a final result/i);
      expect(latest.checkingResult).toBe(false);
      expect(props.onCompleted).not.toHaveBeenCalled();

      await act(async () => latest.checkResultOnce());
      expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
      expect(latest.submission).toEqual(detail);
      expect(latest.detailFetchError).toBe('');
      await act(async () => latest.checkResultOnce());
      expect(submissionApi.get).toHaveBeenCalledTimes(3);
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
    },
  );

  it('requires an explicit current-detail check after an unbound terminal create response', async () => {
    const props = options();
    vi.mocked(submissionApi.create).mockResolvedValueOnce({ ...created, status: 'ACCEPTED' });
    vi.mocked(submissionApi.get).mockResolvedValueOnce({ ...detail, status: 'PENDING' });
    await mountHook(props);
    await act(async () => latest.submit());
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(latest.submitting).toBe(false);
    expect(latest.detailFetchError).toContain('could not verify');
    expect(submissionApi.get).not.toHaveBeenCalled();
    await act(async () => latest.checkResultOnce());
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(latest.detailFetchError).toContain('could not verify');
    await act(async () => latest.checkResultOnce());
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
  });

  it('allows recovery when the terminal detail carries the wrong submission ID', async () => {
    const props = options();
    vi.mocked(submissionApi.get).mockResolvedValueOnce({ ...detail, id: 99 });
    await mountHook(props);
    await act(async () => latest.submit());
    await deliverTerminal();
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(latest.submission?.id).toBe(41);
    expect(latest.submitting).toBe(false);
    expect(latest.detailFetchError).toMatch(/could not confirm a final result/i);
    await act(async () => latest.checkResultOnce());
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
  });

  it.each(['account', 'slug', 'problem id', 'logout', 'unmount'] as const)(
    'ignores an obsolete nonterminal detail after %s even when HTTP resolves after abort',
    async (kind) => {
      const props = options();
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      await mountHook(props);
      await act(async () => latest.submit());
      await deliverTerminal();
      const [, signal] = vi.mocked(submissionApi.get).mock.calls[0];
      if (kind === 'problem id') {
        await view!.rerender(createElement(Probe, { ...props, problem: { id: 2 } }));
      } else {
        await invalidateContext(kind, props);
      }
      expect(signal?.aborted).toBe(true);
      if (kind !== 'unmount' && kind !== 'logout') {
        vi.mocked(submissionApi.create).mockResolvedValueOnce({
          ...created,
          id: 42,
          problem_id: kind === 'slug' || kind === 'problem id' ? 2 : 1,
        });
        await act(async () => latest.submit());
      }
      await act(async () => pending.resolve({ ...detail, status: 'PENDING' }));
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(latest.detailFetchError).toBe('');
      if (kind !== 'unmount' && kind !== 'logout') {
        expect(latest.submitting).toBe(true);
        expect(latest.submission).toMatchObject({ id: 42, status: 'PENDING' });
      }
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores a superseded A request that later %ss after reconnect adopts B',
    async (outcome) => {
      const props = options();
      await mountHook(props);
      await act(async () => latest.submit());
      await act(async () =>
        TestEventSource.instances[0].emit('submission.snapshot', statusEvent('JUDGING')),
      );
      expect(latest.submission?.status).toBe('JUDGING');
      await disconnectStream();
      vi.mocked(submissionApi.get).mockResolvedValueOnce({ ...detail, status: 'JUDGING' });
      await act(async () => latest.checkResultOnce());
      expect(latest.submission?.execution_time_ms).toBe(detail.execution_time_ms);
      const pending = deferred<SubmissionDetail>();
      const pendingB = deferred<SubmissionDetail>();
      vi.mocked(submissionApi.get)
        .mockReturnValueOnce(pending.promise)
        .mockReturnValueOnce(pendingB.promise);
      const check = await startCheck();
      const signalA = vi.mocked(submissionApi.get).mock.calls.at(-1)?.[1];
      await act(async () => latest.stream.reconnect());
      const source = TestEventSource.instances.at(-1)!;
      await act(async () =>
        source.emit('submission.snapshot', {
          ...statusEvent('PENDING', later),
          attempt_id: 'attempt-b',
        }),
      );
      expect(latest.submission).toMatchObject({
        status: 'PENDING',
        updated_at: later,
        execution_time_ms: null,
        passed_testcases: null,
      });
      expect(signalA?.aborted).toBe(true);
      expect(latest.checkingResult).toBe(false);
      const checkB = await startCheck();
      const signalB = vi.mocked(submissionApi.get).mock.calls.at(-1)?.[1];

      await act(async () => {
        if (outcome === 'resolve') pending.resolve(detail);
        else pending.reject(new ApiError('old attempt A error', 503, 50300));
        await check.done;
      });
      expect(latest.submission).toMatchObject({ status: 'PENDING', updated_at: later });
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(latest.detailFetchError).toBe('');
      expect(latest.checkingResult).toBe(true);
      expect(signalB?.aborted).toBe(false);
      expect(source.closed).toBe(false);
      const completed = { ...detail, attempt_id: 'attempt-b' };
      await act(async () => {
        pendingB.resolve(completed);
        await checkB.done;
      });
      expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(completed);
      expect(latest.submission).toEqual(completed);
      expect(source.closed).toBe(true);
    },
  );

  it('does not track a later rejudge automatically after completing the current lifecycle', async () => {
    const props = options();
    await mountHook(props);
    await act(async () => latest.submit());
    const source = TestEventSource.instances[0];
    await deliverTerminal();
    expect(source.closed).toBe(true);
    expect(latest.stream.state).toBe('idle');
    await act(async () => {
      source.emit('submission.snapshot', {
        ...statusEvent('PENDING', later),
        attempt_id: 'attempt-b',
      });
      await latest.checkResultOnce();
    });
    expect(latest.submission).toEqual(detail);
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
  });

  it('keeps current ordering during a same-account refresh while manual GET is pending', async () => {
    const props = options();
    await mountHook(props);
    await act(async () => latest.submit());
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
    const check = await startCheck();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    await view!.rerender(
      createElement(Probe, { ...props, user: { ...props.user!, username: 'fresh' } }),
    );
    expect(signal.aborted).toBe(false);
    await act(async () =>
      TestEventSource.instances[0].emit('submission.updated', statusEvent('JUDGING')),
    );
    await act(async () => {
      pending.resolve({ ...detail, status: 'PENDING' });
      await check.done;
    });
    expect(latest.submission?.status).toBe('JUDGING');
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
  });

  it.each(['slug', 'account', 'unmount'] as const)(
    'keeps a stale nonterminal response invalid after %s',
    async (kind) => {
      const props = options();
      await mountHook(props);
      await act(async () => latest.submit());
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      const check = await startCheck();
      const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
      await invalidateContext(kind, props);
      expect(signal.aborted).toBe(true);
      const accepted = latest.submission;
      await act(async () => {
        pending.resolve({ ...detail, status: 'JUDGING' });
        await check.done;
      });
      expect(latest.submission).toBe(accepted);
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
    },
  );
});

describe('submission async ownership and completion races', () => {
  it.each(['pending', 'error'] as const)(
    'blocks direct Submit until a manual check finishes with %s',
    async (outcome) => {
      const props = options();
      await mountHook(props);
      await pendingRecovery();
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
      const request = await startCheck();
      const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
      vi.mocked(props.requireAuth).mockClear();
      vi.mocked(props.onSubmitStart).mockClear();
      await act(async () => latest.submit());
      expect(submissionApi.create).toHaveBeenCalledTimes(1);
      expect(props.requireAuth).not.toHaveBeenCalled();
      expect(props.onSubmitStart).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(false);
      expect(latest.checkingResult).toBe(true);
      expect(latest.submission?.id).toBe(41);
      await act(async () => {
        if (outcome === 'pending') pending.resolve({ ...detail, status: 'JUDGING' });
        else pending.reject(new NetworkError());
        await request.done;
      });
      expect(latest.checkingResult).toBe(false);
      vi.mocked(submissionApi.create).mockResolvedValue({ ...created, id: 42 });
      await act(async () => latest.submit());
      expect(submissionApi.create).toHaveBeenCalledTimes(2);
      expect(submissionApi.create).toHaveBeenNthCalledWith(
        2,
        {
          problem_id: 1,
          language: 'CPP',
          source_code: 'fixture source',
        },
        expect.any(Function),
      );
      expect(props.requireAuth).toHaveBeenCalledExactlyOnceWith('submit');
      expect(props.onSubmitStart).toHaveBeenCalledTimes(1);
      expect(latest.submission?.id).toBe(42);
      await act(async () => latest.submit());
      expect(submissionApi.create).toHaveBeenCalledTimes(2);
    },
  );

  it.each<Invalidation>(['slug', 'logout', 'unmount', 'account', 'relogin'])(
    'ignores terminal create responses after %s, including StrictMode unmount',
    async (kind) => {
      const props = options();
      const pending = deferred<CreateSubmissionResponse>();
      vi.mocked(submissionApi.create).mockReturnValue(pending.promise);
      await mountHook(props, kind === 'unmount');
      const request = await startSubmit();
      await invalidateContext(kind, props);
      await act(async () => {
        pending.resolve({ ...created, status: 'ACCEPTED' });
        await request.done;
      });
      expect(submissionApi.get).not.toHaveBeenCalled();
      expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
      if (kind !== 'unmount') {
        expect(latest.submission).toBeNull();
        expect(latest.submitting).toBe(false);
      }
    },
  );

  it.each<Invalidation>(['slug', 'logout', 'unmount', 'account', 'relogin'])(
    'ignores create rejection after %s without stale errors or toasts',
    async (kind) => {
      const props = options();
      const pending = deferred<CreateSubmissionResponse>();
      vi.mocked(submissionApi.create).mockReturnValue(pending.promise);
      await mountHook(props);
      const request = await startSubmit();
      await invalidateContext(kind, props);
      await act(async () => {
        pending.reject(new ApiError('obsolete create failure', 503, 50300));
        await request.done;
      });
      expect(props.showToast).not.toHaveBeenCalled();
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(submissionApi.get).not.toHaveBeenCalled();
      if (kind !== 'unmount') {
        expect(latest.submitting).toBe(false);
        expect(latest.detailFetchError).toBe('');
      }
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'does not let an obsolete create %s clear a newer create busy state',
    async (outcome) => {
      const props = options();
      const previous = deferred<CreateSubmissionResponse>();
      const current = deferred<CreateSubmissionResponse>();
      vi.mocked(submissionApi.create)
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise);
      await mountHook(props);
      const oldRequest = await startSubmit();
      await view!.rerender(
        createElement(Probe, { ...props, slug: 'another-problem', problem: { id: 2 } }),
      );
      const newRequest = await startSubmit();
      await act(async () => {
        if (outcome === 'resolve') previous.resolve({ ...created, status: 'ACCEPTED' });
        else previous.reject(new NetworkError('obsolete create failure'));
        await oldRequest.done;
      });
      expect(latest.submitting).toBe(true);
      expect(latest.submission).toBeNull();
      expect(props.showToast).not.toHaveBeenCalled();
      expect(submissionApi.get).not.toHaveBeenCalled();
      expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
      await act(async () => {
        current.resolve({ ...created, id: 42, problem_id: 2 });
        await newRequest.done;
      });
      expect(latest.submission?.id).toBe(42);
      expect(latest.submitting).toBe(true);
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledExactlyOnceWith(
        42,
        expect.any(AbortSignal),
      );
    },
  );

  it('keeps legitimate create work across rerenders and a truthy user-object refresh', async () => {
    const props = options();
    const pending = deferred<CreateSubmissionResponse>();
    vi.mocked(submissionApi.create).mockReturnValue(pending.promise);
    await mountHook(props);
    const request = await startSubmit();
    await view!.rerender(
      createElement(Probe, { ...props, user: { ...props.user! }, code: 'edited while waiting' }),
    );
    await act(async () => {
      pending.resolve(created);
      await request.done;
    });
    expect(latest.submission).toMatchObject({ id: 41, source_code: 'fixture source' });
    expect(submissionApi.create).toHaveBeenCalledTimes(1);
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
  });

  it('keeps one live subscription and completion after StrictMode effect replay', async () => {
    const props = options();
    await mountHook(props, true);
    await act(async () => latest.submit());
    expect(submissionApi.create).toHaveBeenCalledTimes(1);
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
    expect(TestEventSource.instances).toHaveLength(1);
    expect(TestEventSource.instances[0].closed).toBe(false);
    await deliverTerminal();
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    expect(latest.submission).toEqual(detail);
    expect(latest.submitting).toBe(false);
    expect(TestEventSource.instances[0].closed).toBe(true);
  });

  it.each<Invalidation>(['slug', 'logout', 'unmount', 'account', 'relogin'])(
    'aborts manual GET on %s and rejects its late success even when abort is ignored',
    async (kind) => {
      const props = options();
      await mountHook(props);
      await pendingRecovery();
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
      const request = await startCheck();
      const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      await invalidateContext(kind, props);
      expect(signal.aborted).toBe(true);
      const retained = latest.submission;
      await act(async () => {
        pending.resolve(detail);
        await request.done;
      });
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
      if (kind !== 'unmount') {
        expect(latest.submission).toBe(retained);
        expect(latest.checkingResult).toBe(false);
      }
    },
  );

  it('does not let an obsolete manual catch/finally clear a newer manual busy flag', async () => {
    const props = options();
    await mountHook(props);
    await pendingRecovery();
    const previous = deferred<Submission>();
    const current = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const oldRequest = await startCheck();
    const oldSignal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    // A route reset supersedes the check; Submit itself now honors its busy state.
    await invalidateContext('slug', props);
    vi.mocked(submissionApi.create).mockResolvedValue({ ...created, id: 42, problem_id: 2 });
    await act(async () => latest.submit());
    expect(oldSignal.aborted).toBe(true);
    expect(latest.checkingResult).toBe(false);
    await disconnectStream();
    const newRequest = await startCheck();
    expect(latest.checkingResult).toBe(true);
    await act(async () => {
      previous.reject(new NetworkError('obsolete manual failure'));
      await oldRequest.done;
    });
    expect(latest.checkingResult).toBe(true);
    expect(latest.detailFetchError).toBe('');
    expect(latest.submission?.id).toBe(42);
    await act(async () => {
      current.resolve({ ...detail, id: 42, problem_id: 2, status: 'JUDGING' });
      await newRequest.done;
    });
    expect(latest.checkingResult).toBe(false);
    expect(latest.submission).toMatchObject({ id: 42, status: 'JUDGING' });
  });

  it.each(['resolve', 'reject'] as const)(
    'preserves a newer recovery error when the obsolete manual GET later %s',
    async (outcome) => {
      const props = options();
      await mountHook(props);
      await pendingRecovery();
      const previous = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(previous.promise);
      const oldRequest = await startCheck();
      await invalidateContext('slug', props);
      vi.mocked(submissionApi.create).mockResolvedValue({ ...created, id: 42, problem_id: 2 });
      await act(async () => latest.submit());
      await disconnectStream();
      vi.mocked(submissionApi.get).mockRejectedValueOnce(
        new ApiError('current recovery failure', 503, 50300),
      );
      await act(async () => latest.checkResultOnce());
      expect(latest.detailFetchError).toBe('current recovery failure');
      await act(async () => {
        if (outcome === 'resolve') previous.resolve(detail);
        else previous.reject(new NetworkError('obsolete manual failure'));
        await oldRequest.done;
      });
      expect(latest.detailFetchError).toBe('current recovery failure');
      expect(latest.checkingResult).toBe(false);
      expect(latest.submission?.id).toBe(42);
      expect(props.onCompleted).not.toHaveBeenCalled();
    },
  );

  it('uses request identity to reject an older manual finally within the same generation', async () => {
    const props = options();
    await mountHook(props);
    await pendingRecovery();
    const previous = deferred<Submission>();
    const current = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const check = latest.checkResultOnce;
    let oldRequest!: Promise<void>;
    let newRequest!: Promise<void>;
    await act(async () => {
      oldRequest = check();
      newRequest = check();
    });
    const calls = vi.mocked(submissionApi.get).mock.calls;
    expect(calls[0][1]!.aborted).toBe(true);
    expect(calls[1][1]!.aborted).toBe(false);
    await act(async () => {
      previous.reject(new NetworkError());
      await oldRequest;
    });
    expect(latest.checkingResult).toBe(true);
    expect(latest.detailFetchError).toBe('');
    await act(async () => {
      current.resolve({ ...detail, status: 'JUDGING' });
      await newRequest;
    });
    expect(latest.checkingResult).toBe(false);
    expect(latest.submission?.status).toBe('JUDGING');
    expect(props.showToast).toHaveBeenCalledExactlyOnceWith(
      'Submission #41 is still judging.',
      'success',
    );
  });

  it.each(['manual', 'terminal'] as const)(
    'applies one completion when %s GET wins and both responses settle in the same act',
    async (winner) => {
      const props = options();
      await mountHook(props);
      await pendingRecovery();
      const manual = deferred<Submission>();
      const terminalDetail = deferred<Submission>();
      vi.mocked(submissionApi.get)
        .mockReturnValueOnce(manual.promise)
        .mockReturnValueOnce(terminalDetail.promise);
      const manualRequest = await startCheck();
      await act(async () => latest.stream.reconnect());
      await deliverTerminal();
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      await act(async () => {
        const first = winner === 'manual' ? manual : terminalDetail;
        const second = winner === 'manual' ? terminalDetail : manual;
        first.resolve(detail);
        second.resolve({ ...detail, status: 'WRONG_ANSWER' });
        await manualRequest.done;
      });
      expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
      expect(latest.submission).toEqual(detail);
      expect(latest.checkingResult).toBe(false);
      expect(latest.submitting).toBe(false);
      await act(async () => latest.checkResultOnce());
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
    },
  );

  it('completes a new submission independently and ignores old completion after the new result', async () => {
    const props = options();
    await mountHook(props);
    await pendingRecovery();
    const previous = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(previous.promise);
    const oldManual = await startCheck();
    await act(async () => latest.stream.reconnect());
    await deliverTerminal();
    expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    const nextDetail = { ...detail, id: 42 };
    vi.mocked(submissionApi.create).mockResolvedValue({ ...created, id: 42 });
    vi.mocked(submissionApi.get).mockResolvedValue(nextDetail);
    await act(async () => latest.submit());
    await deliverTerminal(42);
    expect(props.onCompleted).toHaveBeenCalledTimes(2);
    expect(props.onCompleted).toHaveBeenLastCalledWith(nextDetail);
    await act(async () => {
      previous.resolve({ ...detail, status: 'WRONG_ANSWER' });
      await oldManual.done;
    });
    expect(props.onCompleted).toHaveBeenCalledTimes(2);
    expect(latest.submission).toEqual(nextDetail);
  });
});

describe('authenticated account identity isolation', () => {
  it.each(['resolve', 'reject'] as const)(
    'ignores A create %s while B create is pending and lets B complete once',
    async (outcome) => {
      const props = options();
      const nextProps = {
        ...props,
        user: { id: 'fixture-user-b', username: 'fixture-user-b' },
        onCompleted: vi.fn(),
      };
      const previous = deferred<CreateSubmissionResponse>();
      const current = deferred<CreateSubmissionResponse>();
      vi.mocked(submissionApi.create)
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise);
      await mountHook(props);
      const oldRequest = await startSubmit();
      await view!.rerender(createElement(Probe, nextProps));
      const newRequest = await startSubmit();
      await act(async () => {
        if (outcome === 'resolve') previous.resolve({ ...created, status: 'ACCEPTED' });
        else previous.reject(new NetworkError());
        await oldRequest.done;
      });
      expect(latest.submitting).toBe(true);
      expect(latest.submission).toBeNull();
      expect(props.showToast).not.toHaveBeenCalled();
      expect(submissionApi.get).not.toHaveBeenCalled();
      expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
      await act(async () => {
        current.resolve({ ...created, id: 42 });
        await newRequest.done;
      });
      expect(latest.submission).toMatchObject({ id: 42, user_id: nextProps.user.id });
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledExactlyOnceWith(
        42,
        expect.any(AbortSignal),
      );
      const nextDetail = {
        ...detail,
        id: 42,
        user_id: nextProps.user.id,
        username: nextProps.user.username,
      };
      vi.mocked(submissionApi.get).mockResolvedValue(nextDetail);
      await deliverTerminal(42);
      expect(props.onCompleted).not.toHaveBeenCalled();
      expect(nextProps.onCompleted).toHaveBeenCalledExactlyOnceWith(nextDetail);
    },
  );

  it.each([
    ['resolve', 'busy'],
    ['reject', 'busy'],
    ['resolve', 'error'],
    ['reject', 'error'],
  ] as const)('ignores A manual %s while B recovery is %s', async (outcome, stage) => {
    const props = options();
    const nextProps = {
      ...props,
      user: { id: 'fixture-user-b', username: 'fixture-user-b' },
      onCompleted: vi.fn(),
    };
    await mountHook(props);
    await pendingRecovery();
    const previous = deferred<Submission>();
    const current = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const oldRequest = await startCheck();
    const oldSignal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    await view!.rerender(createElement(Probe, nextProps));
    expect(oldSignal.aborted).toBe(true);
    vi.mocked(submissionApi.create).mockResolvedValue({ ...created, id: 42 });
    await pendingRecovery();
    const newRequest = await startCheck();
    const newSignal = vi.mocked(submissionApi.get).mock.calls[1][1]!;
    if (stage === 'error') {
      await act(async () => {
        current.reject(new ApiError('account B recovery error', 503, 50300));
        await newRequest.done;
      });
    }
    await act(async () => {
      if (outcome === 'resolve') previous.resolve(detail);
      else previous.reject(new NetworkError('account A obsolete error'));
      await oldRequest.done;
    });
    expect(latest.submission).toMatchObject({ id: 42, user_id: nextProps.user.id });
    expect(latest.checkingResult).toBe(stage === 'busy');
    expect(latest.detailFetchError).toBe(stage === 'error' ? 'account B recovery error' : '');
    expect(newSignal.aborted).toBe(false);
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(nextProps.onCompleted).not.toHaveBeenCalled();
    expect(props.showToast).not.toHaveBeenCalled();
    const nextDetail = {
      ...detail,
      id: 42,
      user_id: nextProps.user.id,
      username: nextProps.user.username,
    };
    if (stage === 'busy') {
      await act(async () => {
        current.resolve(nextDetail);
        await newRequest.done;
      });
    } else {
      vi.mocked(submissionApi.get).mockResolvedValue(nextDetail);
      await act(async () => latest.checkResultOnce());
    }
    expect(nextProps.onCompleted).toHaveBeenCalledExactlyOnceWith(nextDetail);
    expect(props.onCompleted).not.toHaveBeenCalled();
  });

  it.each(['manual', 'terminal'] as const)(
    'keeps a pending %s GET valid across a same-ID user refresh',
    async (kind) => {
      const props = options();
      await mountHook(props);
      await act(async () => latest.submit());
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
      let request: { done: Promise<void> } | undefined;
      if (kind === 'manual') request = await startCheck();
      else await deliverTerminal();
      const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
      await view!.rerender(
        createElement(Probe, { ...props, user: { ...props.user!, username: 'refreshed-name' } }),
      );
      expect(signal.aborted).toBe(false);
      expect(submissionApi.get).toHaveBeenCalledTimes(1);
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
      expect(TestEventSource.instances).toHaveLength(1);
      await act(async () => {
        pending.resolve(detail);
        await request?.done;
      });
      expect(latest.submission).toEqual(detail);
      expect(props.onCompleted).toHaveBeenCalledExactlyOnceWith(detail);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'aborts an A ticket request and ignores its late %s after B has a stream',
    async (outcome) => {
      const props = options();
      const previous = deferred<Awaited<ReturnType<typeof submissionApi.issueStreamTicket>>>();
      vi.mocked(submissionApi.issueStreamTicket).mockReturnValueOnce(previous.promise);
      await mountHook(props);
      await act(async () => latest.submit());
      const signal = vi.mocked(submissionApi.issueStreamTicket).mock.calls[0][1]!;
      expect(TestEventSource.instances).toHaveLength(0);
      await invalidateContext('account', props);
      expect(signal.aborted).toBe(true);
      expect(latest.stream.state).toBe('idle');
      vi.mocked(submissionApi.create).mockResolvedValue({ ...created, id: 42 });
      await act(async () => latest.submit());
      expect(TestEventSource.instances).toHaveLength(1);
      const source = TestEventSource.instances[0];
      expect(source.url).toContain('/events/submissions/42?');
      await act(async () => {
        source.open();
        if (outcome === 'resolve') previous.resolve({ ticket: 'obsolete-fixture', expires_at: '' });
        else previous.reject(new NetworkError());
      });
      expect(TestEventSource.instances).toHaveLength(1);
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(2);
      expect(latest.stream.state).toBe('open');
      expect(latest.submission?.id).toBe(42);
      expect(source.closed).toBe(false);
      expect(props.showToast).not.toHaveBeenCalled();
      expect(submissionApi.get).not.toHaveBeenCalled();
    },
  );

  it('keeps the B terminal controller owned after a late A finally, including StrictMode cleanup', async () => {
    const props = options();
    const nextProps = { ...props, user: { id: 'fixture-user-b', username: 'fixture-user-b' } };
    const previous = deferred<Submission>();
    const current = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    await mountHook(props, true);
    await act(async () => latest.submit());
    await deliverTerminal();
    const oldSignal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    await view!.rerender(createElement(StrictMode, null, createElement(Probe, nextProps)));
    expect(oldSignal.aborted).toBe(true);
    vi.mocked(submissionApi.create).mockResolvedValue({ ...created, id: 42 });
    await act(async () => latest.submit());
    await deliverTerminal(42);
    const newSignal = vi.mocked(submissionApi.get).mock.calls[1][1]!;
    await act(async () => previous.resolve(detail));
    expect(newSignal.aborted).toBe(false);
    expect(latest.submission?.id).toBe(42);
    expect(props.onCompleted).not.toHaveBeenCalled();
    await view!.unmount();
    expect(newSignal.aborted).toBe(true);
    await act(async () => current.resolve({ ...detail, id: 42 }));
    expect(props.onCompleted).not.toHaveBeenCalled();
  });

  it('ignores account A create responses after a direct switch to account B', async () => {
    const props = options();
    const pending = deferred<CreateSubmissionResponse>();
    vi.mocked(submissionApi.create).mockReturnValue(pending.promise);
    await mountHook(props);
    const request = await startSubmit();
    await view!.rerender(
      createElement(Probe, {
        ...props,
        user: { id: 'fixture-user-b', username: 'fixture-user-b' },
      }),
    );
    await act(async () => {
      pending.resolve(created);
      await request.done;
    });
    expect(latest.submission).toBeNull();
    expect(latest.submitting).toBe(false);
    expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
    expect(submissionApi.get).not.toHaveBeenCalled();
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(props.showToast).not.toHaveBeenCalled();
  });

  it('cancels account A manual GET across a direct switch to account B', async () => {
    const props = options();
    await mountHook(props);
    await pendingRecovery();
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    const request = await startCheck();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    const onCompleted = vi.fn();
    await view!.rerender(
      createElement(Probe, {
        ...props,
        user: { id: 'fixture-user-b', username: 'fixture-user-b' },
        onCompleted,
      }),
    );
    expect(signal.aborted).toBe(true);
    expect(latest.checkingResult).toBe(false);
    await act(async () => {
      pending.resolve(detail);
      await request.done;
    });
    expect(latest.submission).toBeNull();
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
