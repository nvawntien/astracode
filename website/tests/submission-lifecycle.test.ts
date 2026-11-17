// @vitest-environment jsdom

import { act, createElement, StrictMode, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspacePage from '../src/app/problems/[slug]/page';
import { ApiError, NetworkError, problemApi, submissionApi } from '../src/lib/api';
import { fetchProgress, invalidateProgress } from '../src/lib/progress';
import type { useSubmissionStream } from '../src/lib/submission-stream';
import type { CodeEditor } from '../src/components/CodeEditor';
import type { ProblemPanel } from '../src/components/workspace/ProblemPanel';
import type { ResultPanel } from '../src/features/problem-workspace/components/ResultPanel';
import type {
  CreateSubmissionResponse,
  Me,
  Problem,
  RunResponse,
  Submission,
  SubmissionStreamEvent,
} from '../src/lib/types';
import { TestEventSource } from './helpers/event-source';
import { deferred, renderReact } from './helpers/react-dom';

const observed = vi.hoisted(() => ({
  slug: 'fixture-problem',
  user: null as Me | null,
  push: vi.fn(),
  toast: vi.fn(),
  editor: null as ComponentProps<typeof CodeEditor> | null,
  problem: null as ComponentProps<typeof ProblemPanel> | null,
  result: null as ComponentProps<typeof ResultPanel> | null,
  stream: null as Parameters<typeof useSubmissionStream>[0] | null,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: observed.slug }),
  useRouter: () => ({ push: observed.push }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ user: observed.user, loading: false }),
}));
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ showToast: observed.toast }) }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/CodeEditor', () => ({
  CodeEditor: (props: ComponentProps<typeof CodeEditor>) => {
    observed.editor = props;
    return createElement('textarea', {
      'aria-label': 'Fixture editor',
      value: props.value,
      readOnly: true,
    });
  },
}));
vi.mock('@/components/workspace/ProblemPanel', () => ({
  ProblemPanel: (props: ComponentProps<typeof ProblemPanel>) => {
    observed.problem = props;
    return createElement('section', { 'data-testid': 'problem' }, props.problem.title);
  },
  ProblemPanelSkeleton: () => createElement('p', null, 'Loading fixture problem'),
  ProblemNotFound: () => createElement('p', null, 'Missing fixture problem'),
}));
vi.mock('@/features/problem-workspace/components/ResultPanel', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/features/problem-workspace/components/ResultPanel')
    >();
  return {
    ...actual,
    ResultPanel: (props: ComponentProps<typeof ResultPanel>) => {
      observed.result = props;
      return createElement(actual.ResultPanel, props);
    },
  };
});
vi.mock('@/lib/progress', () => ({ fetchProgress: vi.fn(), invalidateProgress: vi.fn() }));
vi.mock('@/lib/submission-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/submission-stream')>();
  return {
    ...actual,
    useSubmissionStream: (options: Parameters<typeof useSubmissionStream>[0]) => {
      observed.stream = options;
      return actual.useSubmissionStream(options);
    },
  };
});

const user: Me = {
  id: 'fixture-user',
  username: 'fixture-user',
  full_name: 'Fixture User',
  email: 'fixture@example.test',
  role: 'user',
  rating: 0,
  is_active: true,
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
};
const problem: Problem = {
  id: 1,
  slug: 'fixture-problem',
  title: 'Fixture problem',
  description: '',
  input_format: '',
  output_format: '',
  difficulty: 'easy',
  time_limit: 1,
  memory_limit: 128,
  created_at: '2026-11-17T00:00:00Z',
  examples: [{ input: '1', expected_output: '1' }],
};
const sourceCode = '  submitted source\n';
function created(overrides: Partial<CreateSubmissionResponse> = {}): CreateSubmissionResponse {
  return {
    id: 41,
    problem_id: 1,
    problem_title: 'Fixture problem',
    language: 'CPP',
    status: 'PENDING',
    created_at: '2026-11-17T01:00:00Z',
    ...overrides,
  };
}
function detail(overrides: Partial<Submission> = {}): Submission {
  return {
    ...created(),
    user_id: user.id,
    username: user.username,
    source_code: sourceCode,
    status: 'ACCEPTED',
    execution_time_ms: 12,
    memory_used_kb: 2048,
    passed_testcases: 3,
    total_testcases: 3,
    compile_output: null,
    error_message: null,
    updated_at: '2026-11-17T01:01:00Z',
    ...overrides,
  };
}
function event(overrides: Partial<SubmissionStreamEvent> = {}): SubmissionStreamEvent {
  return {
    submission_id: 41,
    attempt_id: 'fixture-attempt',
    status: 'JUDGING',
    updated_at: '2026-11-17T01:00:30Z',
    ...overrides,
  };
}
let view: Awaited<ReturnType<typeof renderReact>> | undefined;

async function mount(strict = false) {
  const page = createElement(WorkspacePage);
  view = await renderReact(strict ? createElement(StrictMode, null, page) : page);
}
async function rerender() {
  await view!.rerender(createElement(WorkspacePage));
}
async function click(text: string) {
  const button = [...view!.container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  expect(button, `button ${text}`).toBeDefined();
  await act(async () => button!.click());
}
async function shortcut(submit = true) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        shiftKey: submit,
        bubbles: true,
      }),
    );
  });
}
async function disconnect() {
  await act(async () => TestEventSource.instances.at(-1)!.raw('submission.updated', '{invalid'));
}
async function terminal() {
  await act(async () =>
    TestEventSource.instances.at(-1)!.emit('submission.completed', event({ status: 'ACCEPTED' })),
  );
}
function state() {
  expect(observed.result).not.toBeNull();
  return observed.result!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', TestEventSource);
  // Node 25 also exposes storage globals; use this test's jsdom Storage objects.
  const domWindow = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
  vi.stubGlobal('localStorage', domWindow.localStorage);
  vi.stubGlobal('sessionStorage', domWindow.sessionStorage);
  TestEventSource.instances = [];
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('astra-lang', 'CPP');
  localStorage.setItem('astra-draft:1:CPP', sourceCode);
  observed.slug = problem.slug;
  observed.user = user;
  observed.result = observed.editor = observed.problem = null;
  observed.stream = null;
  vi.spyOn(problemApi, 'bySlug').mockImplementation(async (slug) => ({
    ...problem,
    id: slug === problem.slug ? 1 : 2,
    slug,
  }));
  vi.spyOn(submissionApi, 'create').mockResolvedValue(created());
  vi.spyOn(submissionApi, 'get').mockResolvedValue(detail());
  vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue({
    ticket: 'fixture-ticket',
    expires_at: '2026-11-17T02:00:00Z',
  });
  vi.spyOn(submissionApi, 'run').mockResolvedValue({
    status: 'completed',
    tests: [],
    diagnostics: [],
    compile_output: '',
  });
  vi.mocked(fetchProgress).mockImplementation(async (force) => ({
    submissions: [],
    solvedIds: new Set(force ? [1] : []),
    attemptedIds: new Set(force ? [1] : []),
    truncated: false,
  }));
  // jsdom queues zero-delay storage events for fixture writes.
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(async () => {
  try {
    await view?.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('official submission guards, creation and completion with real React', () => {
  it('rejects unauthenticated Submit and preserves the existing login redirect', async () => {
    observed.user = null;
    await mount();
    await click('Submit');
    expect(submissionApi.create).not.toHaveBeenCalled();
    expect(observed.toast).toHaveBeenCalledWith('Sign in to submit', 'error');
    expect(observed.push).toHaveBeenCalledExactlyOnceWith('/login?next=/problems/fixture-problem');
  });

  it('rejects offline keyboard Submit even though it bypasses the disabled button', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await mount();
    await shortcut();
    expect(submissionApi.create).not.toHaveBeenCalled();
    expect(observed.toast).toHaveBeenCalledWith('You appear to be offline', 'error');
  });

  it('rejects whitespace-only source without changing its stored format', async () => {
    localStorage.setItem('astra-draft:1:CPP', ' \n\t');
    await mount();
    await click('Submit');
    expect(submissionApi.create).not.toHaveBeenCalled();
    expect(observed.toast).toHaveBeenCalledWith('Write some code before submitting', 'error');
  });

  it('blocks Submit while Run is pending, and blocks Run/Submit while creation is pending', async () => {
    const run = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValue(run.promise);
    await mount();
    await click('Run');
    await shortcut();
    expect(submissionApi.create).not.toHaveBeenCalled();
    await act(async () =>
      run.resolve({ status: 'completed', tests: [], diagnostics: [], compile_output: '' }),
    );
    const create = deferred<CreateSubmissionResponse>();
    vi.mocked(submissionApi.create).mockReturnValue(create.promise);
    await click('Submit');
    await shortcut();
    await shortcut(false);
    expect(submissionApi.create).toHaveBeenCalledTimes(1);
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    expect(state().submitting).toBe(true);
  });

  it('sends the exact payload, clears Run/diagnostics and tracks pending creation metadata', async () => {
    const diagnostic = {
      kind: 'compile',
      severity: 'error',
      line: 5,
      column: 1,
      message: 'bad source',
    };
    vi.mocked(submissionApi.run).mockResolvedValue({
      status: 'compile_error',
      tests: [],
      diagnostics: [diagnostic],
      compile_output: 'bad source',
    });
    await mount();
    await click('Run');
    expect(state().runResult?.status).toBe('compile_error');
    expect(observed.editor!.highlightLine).toBe(5);
    const pending = deferred<CreateSubmissionResponse>();
    vi.mocked(submissionApi.create).mockReturnValue(pending.promise);
    await click('Submit');
    expect(submissionApi.create).toHaveBeenCalledExactlyOnceWith({
      problem_id: 1,
      language: 'CPP',
      source_code: sourceCode,
    });
    expect(state()).toMatchObject({
      submitting: true,
      submission: null,
      runResult: null,
      diagnostics: [],
      liveUpdateError: '',
      detailFetchError: '',
    });
    expect(observed.editor!.highlightLine).toBeNull();
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    await act(async () => pending.resolve(created()));
    expect(state().submission).toEqual({
      ...created(),
      user_id: user.id,
      username: user.username,
      source_code: sourceCode,
      execution_time_ms: null,
      memory_used_kb: null,
      passed_testcases: null,
      total_testcases: null,
      compile_output: null,
      error_message: null,
      updated_at: created().created_at,
    });
    expect(state().submitting).toBe(true);
    expect(observed.stream).toMatchObject({ submissionId: 41, enabled: true });
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledExactlyOnceWith(
      41,
      expect.any(AbortSignal),
    );
  });

  it.each([
    [
      new NetworkError(),
      'AstraCode is temporarily unreachable. Check your connection and try again.',
    ],
    [new ApiError('not eligible', 403, 40300), 'not eligible'],
    [new ApiError('', 400, 40000), 'Submission rejected'],
    [new Error('unexpected'), 'Submission failed'],
  ])('restores submitting after create error %s', async (error, message) => {
    vi.mocked(submissionApi.create).mockRejectedValue(error);
    await mount();
    await click('Submit');
    expect(state()).toMatchObject({
      submitting: false,
      submission: null,
      runResult: null,
      detailFetchError: '',
    });
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    expect(observed.toast).toHaveBeenCalledWith(message, 'error');
    expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
  });

  it('immediately fetches details for terminal creation without requesting an SSE ticket', async () => {
    vi.mocked(submissionApi.create).mockResolvedValue(created({ status: 'ACCEPTED' }));
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    await mount();
    expect(observed.problem).toMatchObject({ solved: false, attempted: false });
    await click('Submit');
    expect(state().submitting).toBe(true);
    expect(submissionApi.get).toHaveBeenCalledExactlyOnceWith(41, expect.any(AbortSignal));
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
    await act(async () => pending.resolve(detail()));
    expect(state()).toMatchObject({
      submitting: false,
      submission: detail(),
      liveUpdateError: '',
      detailFetchError: '',
    });
    expect(observed.problem!.historyRefreshKey).toBe(1);
    expect(observed.problem).toMatchObject({ solved: true, attempted: true });
    expect(invalidateProgress).toHaveBeenCalledTimes(1);
    expect(fetchProgress).toHaveBeenLastCalledWith(true);
    expect(observed.toast).toHaveBeenCalledWith('Accepted', 'success');
  });

  it('updates matching statuses and fetches one terminal detail despite duplicate events/callbacks', async () => {
    await mount();
    await click('Submit');
    const source = TestEventSource.instances[0];
    await act(async () => source.emit('submission.updated', event({ submission_id: 999 })));
    expect(state().submission!.status).toBe('PENDING');
    await act(async () => source.emit('submission.updated', event()));
    expect(state().submission).toMatchObject({ status: 'JUDGING', updated_at: event().updated_at });
    const older = event({ status: 'PENDING', updated_at: '2026-11-17T00:59:00Z' });
    await act(async () => source.emit('submission.updated', older));
    // Matching events follow arrival order; there is no timestamp monotonicity guard.
    expect(state().submission).toMatchObject({ status: 'PENDING', updated_at: older.updated_at });
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    const terminalCallback = observed.stream!.onTerminal;
    await act(async () => {
      source.emit('submission.completed', event({ status: 'ACCEPTED' }));
      source.emit('submission.completed', event({ status: 'ACCEPTED' }));
      // Also exercise the page's independent ref guard, beyond the stream's guard.
      terminalCallback(event({ status: 'ACCEPTED' }));
    });
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    expect(state().submission!.status).toBe('ACCEPTED');
    expect(source.closed).toBe(true);
    await act(async () => pending.resolve(detail()));
    expect(state().submission).toEqual(detail());
    expect(observed.problem!.historyRefreshKey).toBe(1);
    expect(invalidateProgress).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate creation or final side effects under StrictMode', async () => {
    await mount(true);
    await click('Submit');
    await terminal();
    expect(submissionApi.create).toHaveBeenCalledTimes(1);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    expect(invalidateProgress).toHaveBeenCalledTimes(1);
    expect(observed.problem!.historyRefreshKey).toBe(1);
  });
});

describe('submission recovery and cancellation', () => {
  it('exposes stream recovery UI and checks a pending result once without pretending it completed', async () => {
    await mount();
    await click('Submit');
    await disconnect();
    expect(state()).toMatchObject({
      submitting: false,
      checkingResult: false,
      liveUpdateError: 'Live update payload was not valid JSON.',
    });
    expect(observed.stream).toMatchObject({ submissionId: 41, enabled: true });
    expect(view!.container.textContent).toContain(
      'Submission #41 is saved, but live updates are unavailable.',
    );
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    await click('Check result');
    expect(state().checkingResult).toBe(true);
    expect(submissionApi.get).toHaveBeenCalledExactlyOnceWith(41, expect.any(AbortSignal));
    // The actual callback also guards repeated checks independently of its disabled button.
    await act(async () => {
      await state().onCheckResult();
    });
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(detail({ status: 'JUDGING' })));
    expect(state()).toMatchObject({
      checkingResult: false,
      submission: { status: 'JUDGING' },
      liveUpdateError: 'Live update payload was not valid JSON.',
    });
    expect(observed.stream!.submissionId).toBe(41);
    expect(observed.toast).toHaveBeenCalledWith('Submission #41 is still judging.', 'success');
    expect(invalidateProgress).not.toHaveBeenCalled();
    expect(observed.problem!.historyRefreshKey).toBe(0);
  });

  it('characterizes a successful reconnect that leaves the page recovery warning until completion', async () => {
    await mount();
    await click('Submit');
    await disconnect();
    const warning = state().liveUpdateError;
    await click('Reconnect');
    expect(TestEventSource.instances).toHaveLength(2);
    await act(async () => {
      TestEventSource.instances[1].open();
      TestEventSource.instances[1].emit('submission.updated', event());
    });
    expect(state().streamState).toBe('open');
    expect(state().liveUpdateError).toBe(warning);
    await terminal();
    expect(state()).toMatchObject({ submitting: false, liveUpdateError: '', detailFetchError: '' });
  });

  it.each([
    [
      new NetworkError(),
      'Verdict received, but submission details could not be loaded. Check your connection and try again.',
    ],
    [new ApiError('detail unavailable', 503, 50300), 'detail unavailable'],
    [new Error('unexpected'), 'Verdict received, but submission detail could not be loaded.'],
  ])(
    'keeps the terminal verdict and exposes manual recovery for detail error %s',
    async (error, message) => {
      vi.mocked(submissionApi.get).mockRejectedValue(error);
      await mount();
      await click('Submit');
      const terminalCallback = observed.stream!.onTerminal;
      await terminal();
      expect(state()).toMatchObject({
        submitting: false,
        submission: { id: 41, status: 'ACCEPTED' },
        detailFetchError: message,
      });
      expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
      expect(invalidateProgress).not.toHaveBeenCalled();
      await act(async () => terminalCallback(event({ status: 'ACCEPTED' })));
      expect(submissionApi.get).toHaveBeenCalledTimes(1); // ref stays latched after failure
      vi.mocked(submissionApi.get).mockResolvedValue(detail({ status: 'WRONG_ANSWER' }));
      await click('Retry detail');
      expect(vi.mocked(submissionApi.get).mock.calls[1]).toEqual([41, expect.any(AbortSignal)]);
      expect(state()).toMatchObject({
        submitting: false,
        checkingResult: false,
        detailFetchError: '',
        submission: { status: 'WRONG_ANSWER' },
      });
      expect(observed.toast).toHaveBeenCalledWith('Verdict: Wrong Answer', 'error');
      expect(invalidateProgress).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      new NetworkError(),
      'AstraCode is temporarily unreachable. Check your connection and try again.',
    ],
    [new ApiError('cannot read', 403, 40300), 'cannot read'],
    [new Error('unknown'), 'Could not read the submission.'],
  ])(
    'keeps the pending submission and clears checkingResult after manual error %s',
    async (error, message) => {
      await mount();
      await click('Submit');
      await disconnect();
      vi.mocked(submissionApi.get).mockRejectedValue(error);
      await click('Check result');
      expect(state()).toMatchObject({
        checkingResult: false,
        submission: { id: 41, status: 'PENDING' },
        detailFetchError: message,
      });
      expect(observed.stream!.submissionId).toBe(41);
      expect(invalidateProgress).not.toHaveBeenCalled();
      // While a live-update error exists, the pending/live branch precedes detailFetchError in ResultPanel.
      expect(view!.container.textContent).toContain('Live update payload was not valid JSON.');
      expect(view!.container.textContent).not.toContain(message);
    },
  );

  it('aborts terminal detail on unmount and ignores a late response even if the transport ignores abort', async () => {
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    await mount();
    await click('Submit');
    await terminal();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    expect(signal.aborted).toBe(false);
    await view!.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(detail()));
    expect(invalidateProgress).not.toHaveBeenCalled();
    expect(observed.toast).not.toHaveBeenCalledWith('Accepted', 'success');
  });

  it('aborts old detail, resets tracking on slug change and re-arms the terminal guard for a new Submit', async () => {
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
    await mount();
    await click('Submit');
    await terminal();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    observed.slug = 'another-problem';
    await rerender();
    expect(signal.aborted).toBe(true);
    expect(state()).toMatchObject({
      submitting: false,
      checkingResult: false,
      submission: null,
      liveUpdateError: '',
      detailFetchError: '',
    });
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    await act(async () => pending.reject(new DOMException('aborted', 'AbortError')));
    expect(state().detailFetchError).toBe('');
    vi.mocked(submissionApi.create).mockResolvedValue(created({ id: 42, problem_id: 2 }));
    vi.mocked(submissionApi.get).mockResolvedValue(detail({ id: 42, problem_id: 2 }));
    await click('Submit');
    await act(async () =>
      TestEventSource.instances
        .at(-1)!
        .emit('submission.completed', event({ submission_id: 42, status: 'ACCEPTED' })),
    );
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submissionApi.get).mock.calls[1][0]).toBe(42);
  });

  it('keeps the newer abort controller when an older aborted request finishes later', async () => {
    const previous = deferred<Submission>();
    const current = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    await mount();
    await click('Submit');
    await terminal();
    const oldSignal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    observed.slug = 'another-problem';
    await rerender();
    vi.mocked(submissionApi.create).mockResolvedValue(created({ id: 42, problem_id: 2 }));
    await click('Submit');
    await act(async () =>
      TestEventSource.instances
        .at(-1)!
        .emit('submission.completed', event({ submission_id: 42, status: 'ACCEPTED' })),
    );
    const newSignal = vi.mocked(submissionApi.get).mock.calls[1][1]!;
    expect(oldSignal.aborted).toBe(true);
    await act(async () => previous.resolve(detail()));
    expect(newSignal.aborted).toBe(false);
    await view!.unmount();
    expect(newSignal.aborted).toBe(true);
    await act(async () => current.resolve(detail({ id: 42, problem_id: 2 })));
    expect(invalidateProgress).not.toHaveBeenCalled();
  });

  it('aborts terminal detail on logout but retains the existing submission object', async () => {
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    await mount();
    await click('Submit');
    await terminal();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    observed.user = null;
    await rerender();
    expect(signal.aborted).toBe(true);
    expect(state()).toMatchObject({
      submitting: false,
      checkingResult: false,
      submission: { id: 41, status: 'ACCEPTED' },
    });
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    await act(async () => pending.resolve(detail()));
    expect(invalidateProgress).not.toHaveBeenCalled();
  });

  it('retains submission and recovery errors on logout, and does not reset on a truthy user change', async () => {
    await mount();
    await click('Submit');
    observed.user = { ...user, id: 'another-fixture-user', username: 'another-user' };
    await rerender();
    expect(state().submitting).toBe(true);
    expect(observed.stream!.submissionId).toBe(41);
    await disconnect();
    const retained = state().submission;
    const warning = state().liveUpdateError;
    observed.user = null;
    await rerender();
    expect(state()).toMatchObject({
      submitting: false,
      checkingResult: false,
      submission: retained,
      liveUpdateError: warning,
    });
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
  });
});

describe('async lifecycle response validity', () => {
  it('ignores creation completing after a slug change', async () => {
    const pending = deferred<CreateSubmissionResponse>();
    vi.mocked(submissionApi.create).mockReturnValue(pending.promise);
    await mount();
    await click('Submit');
    observed.slug = 'another-problem';
    await rerender();
    expect(state().submission).toBeNull();
    expect(state().submitting).toBe(false);
    await act(async () => pending.resolve(created()));
    expect(observed.problem!.problem.id).toBe(2);
    expect(state().submission).toBeNull();
    expect(state().submitting).toBe(false);
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
    expect(submissionApi.get).not.toHaveBeenCalled();
  });

  it('ignores creation completing after logout', async () => {
    const pending = deferred<CreateSubmissionResponse>();
    vi.mocked(submissionApi.create).mockReturnValue(pending.promise);
    await mount();
    await click('Submit');
    observed.user = null;
    await rerender();
    await act(async () => pending.resolve(created()));
    expect(state()).toMatchObject({
      submitting: false,
      submission: null,
    });
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
    expect(submissionApi.get).not.toHaveBeenCalled();
  });

  it('ignores manual checking that resolves after slug reset', async () => {
    await mount();
    await click('Submit');
    await disconnect();
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    await click('Check result');
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    observed.slug = 'another-problem';
    await rerender();
    expect(signal.aborted).toBe(true);
    expect(state()).toMatchObject({ checkingResult: false, submission: null });
    await act(async () => pending.resolve(detail()));
    expect(observed.problem!.problem.id).toBe(2);
    expect(state().submission).toBeNull();
    expect(invalidateProgress).not.toHaveBeenCalled();
    expect(observed.problem!.historyRefreshKey).toBe(0);
  });

  it('preserves keyboard Submit during manual checking while ignoring the old result', async () => {
    await mount();
    await click('Submit');
    await disconnect();
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    await click('Check result');
    expect(state().checkingResult).toBe(true);
    vi.mocked(submissionApi.create).mockResolvedValue(created({ id: 42 }));
    // Buttons are disabled by busy, but the existing keyboard guard omits checkingResult.
    await shortcut();
    expect(submissionApi.create).toHaveBeenCalledTimes(2);
    expect(observed.stream!.submissionId).toBe(42);
    await act(async () => pending.resolve(detail()));
    expect(state()).toMatchObject({
      checkingResult: false,
      submitting: true,
      submission: { id: 42, status: 'PENDING' },
    });
    expect(observed.stream!.submissionId).toBe(42);
    expect(invalidateProgress).not.toHaveBeenCalled();
  });

  it('completes once when terminal detail wins over an older manual GET', async () => {
    await mount();
    await click('Submit');
    await disconnect();
    const manual = deferred<Submission>();
    const terminalDetail = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(manual.promise)
      .mockReturnValueOnce(terminalDetail.promise);
    await click('Check result');
    await click('Reconnect');
    await terminal();
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    await act(async () => terminalDetail.resolve(detail()));
    expect(observed.problem!.historyRefreshKey).toBe(1);
    expect(state().checkingResult).toBe(false);
    await act(async () => manual.resolve(detail()));
    expect(observed.problem!.historyRefreshKey).toBe(1);
    expect(invalidateProgress).toHaveBeenCalledTimes(1);
  });
});
