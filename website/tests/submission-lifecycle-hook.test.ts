// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubmissionLifecycle } from '../src/features/problem-workspace/hooks/useSubmissionLifecycle';
import { ApiError, NetworkError, submissionApi } from '../src/lib/api';
import type { CreateSubmissionResponse, Submission } from '../src/lib/types';
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
const detail: Submission = {
  ...created,
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
    expect(submissionApi.create).toHaveBeenCalledExactlyOnceWith({
      problem_id: 2,
      language: 'JAVA',
      source_code: 'new source\n',
    });
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
      expect(submissionApi.create).toHaveBeenNthCalledWith(2, {
        problem_id: 1,
        language: 'CPP',
        source_code: 'fixture source',
      });
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
