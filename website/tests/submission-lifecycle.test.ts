// @vitest-environment jsdom

import {
  act,
  createElement,
  StrictMode,
  useLayoutEffect,
  type ComponentProps,
  type ReactNode,
} from 'react';
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
async function shortcut(submit = true, modifier: 'ctrl' | 'meta' = 'ctrl') {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: modifier === 'ctrl',
        metaKey: modifier === 'meta',
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
  vi.mocked(fetchProgress).mockImplementation(async (_accountId, force) => ({
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
    expect(fetchProgress).toHaveBeenLastCalledWith(user.id, true);
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
    expect(state().submission).toMatchObject({ status: 'JUDGING', updated_at: event().updated_at });
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
  it.each(['PENDING', 'JUDGING'] as const)(
    'keeps terminal HTTP %s out of completion presentation and side effects until Retry detail succeeds',
    async (status) => {
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      await mount();
      await click('Submit');
      await terminal();
      const snapshot = detail({ status, updated_at: '2026-11-17T02:00:00Z' });
      await act(async () => pending.resolve(snapshot));
      expect(observed.toast).not.toHaveBeenCalled();
      expect(invalidateProgress).not.toHaveBeenCalled();
      expect(fetchProgress).not.toHaveBeenCalledWith(user.id, true);
      expect(observed.problem!.historyRefreshKey).toBe(0);
      expect(state()).toMatchObject({ submitting: false, submission: { status: 'ACCEPTED' } });
      expect(view!.container.querySelector('[role="alert"]')?.textContent).toMatch(
        /could not confirm a final result/i,
      );
      expect(view!.container.textContent).not.toContain('Judged at');
      expect(view!.container.textContent).not.toContain('Accepted');

      const retry = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(retry.promise);
      await click('Retry detail');
      expect(view!.container.querySelector('[role="alert"] button:disabled')?.textContent).toBe(
        'Checking…',
      );
      expect(view!.container.textContent).not.toContain('Judged at');
      await act(async () => retry.resolve(detail()));
      expect(state().submission).toEqual(detail());
      expect(view!.container.querySelector('[role="alert"]')).toBeNull();
      expect(view!.container.textContent).toContain('Judged at');
      expect(view!.container.textContent).toContain('Accepted');
      expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Accepted', 'success');
      expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
      expect(fetchProgress).toHaveBeenLastCalledWith(user.id, true);
      expect(observed.problem!.historyRefreshKey).toBe(1);
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
    },
  );

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

  it.each([false, true])(
    'clears the warning only on current open and keeps pending status (StrictMode=%s)',
    async (strict) => {
      await mount(strict);
      await click('Submit');
      await disconnect();
      const warning = state().liveUpdateError;
      const pending = deferred<Awaited<ReturnType<typeof submissionApi.issueStreamTicket>>>();
      vi.mocked(submissionApi.issueStreamTicket).mockReturnValueOnce(pending.promise);
      await click('Reconnect');
      expect(state().streamState).toBe('requesting_ticket');
      expect(state().liveUpdateError).toBe(warning);
      await act(async () => pending.resolve({ ticket: 'fixture-reconnect', expires_at: '' }));
      expect(TestEventSource.instances).toHaveLength(2);
      expect(state().streamState).toBe('connecting');
      expect(state().liveUpdateError).toBe(warning);
      expect(view!.container.textContent).toContain(warning);
      await act(async () => {
        TestEventSource.instances[1].open();
      });
      expect(state().streamState).toBe('open');
      expect(state().liveUpdateError).toBe('');
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(2);
      expect(submissionApi.create).toHaveBeenCalledTimes(1);
      expect(submissionApi.get).not.toHaveBeenCalled();
      expect(view!.container.textContent).not.toContain(warning);
      expect(view!.container.textContent).toContain('queued — waiting for a judge worker');
      await act(async () => TestEventSource.instances[1].emit('submission.updated', event()));
      expect(view!.container.textContent).toContain('is being judged');
      await terminal();
      expect(state()).toMatchObject({
        submitting: false,
        liveUpdateError: '',
        detailFetchError: '',
      });
    },
  );

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
      expect(view!.container.textContent).toContain('Live update payload was not valid JSON.');
      expect(view!.container.textContent).toContain(message);
      expect(
        [...view!.container.querySelectorAll('button')].map((button) => button.textContent?.trim()),
      ).toEqual(expect.arrayContaining(['Reconnect', 'Retry detail', 'View submissions']));
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
    expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
  });

  it('retains submission and recovery errors on logout, and does not reset on same-account refresh', async () => {
    await mount();
    await click('Submit');
    observed.user = { ...user, username: 'refreshed-user' };
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

describe('cross-account workspace isolation', () => {
  it('keeps the logout view, then clears submission and both errors when B logs in', async () => {
    await mount();
    await click('Submit');
    await disconnect();
    vi.mocked(submissionApi.get).mockRejectedValue(
      new ApiError('account A detail error', 503, 50300),
    );
    await click('Check result');
    const retained = state().submission;
    const warning = state().liveUpdateError;
    expect(state().detailFetchError).toBe('account A detail error');
    observed.user = null;
    await rerender();
    expect(state()).toMatchObject({
      submission: retained,
      liveUpdateError: warning,
      detailFetchError: 'account A detail error',
      submitting: false,
      checkingResult: false,
    });
    observed.user = { ...user, id: 'fixture-user-b', username: 'fixture-user-b' };
    await rerender();
    expect(state()).toMatchObject({
      submission: null,
      liveUpdateError: '',
      detailFetchError: '',
      submitting: false,
      checkingResult: false,
    });
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    expect(observed.editor!.value).toBe(sourceCode);
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
    expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
  });

  it('clears already completed A submission data when the authenticated account becomes B', async () => {
    await mount();
    await click('Submit');
    await terminal();
    expect(state().submission).toEqual(detail());
    expect(observed.problem!.historyRefreshKey).toBe(1);
    observed.toast.mockClear();
    observed.user = { ...user, id: 'fixture-user-b', username: 'fixture-user-b' };
    await rerender();
    expect(state().submission).toBeNull();
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    expect(observed.toast).not.toHaveBeenCalled();
    expect(observed.problem!.historyRefreshKey).toBe(1);
    // One invalidation for A's completion, one for leaving account A.
    expect(vi.mocked(invalidateProgress).mock.calls).toEqual([[user.id], [user.id]]);
  });

  it('clears tracked submission state on A to B and ignores the closed stream events', async () => {
    await mount();
    await click('Submit');
    const oldSource = TestEventSource.instances[0];
    observed.user = { ...user, id: 'fixture-user-b', username: 'fixture-user-b' };
    await rerender();
    expect(state()).toMatchObject({
      submission: null,
      submitting: false,
      checkingResult: false,
      liveUpdateError: '',
      detailFetchError: '',
    });
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    expect(oldSource.closed).toBe(true);
    await act(async () => {
      oldSource.emit('submission.updated', event());
      oldSource.emit('submission.completed', event({ status: 'ACCEPTED' }));
      oldSource.raw('submission.updated', '{invalid');
    });
    expect(state().submission).toBeNull();
    expect(state().liveUpdateError).toBe('');
    expect(submissionApi.get).not.toHaveBeenCalled();
    expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(observed.problem!.historyRefreshKey).toBe(0);
    expect(observed.toast).not.toHaveBeenCalled();
    vi.mocked(submissionApi.create).mockResolvedValue(created({ id: 42 }));
    await shortcut();
    expect(state().submission).toMatchObject({ id: 42, user_id: 'fixture-user-b' });
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(2);
    expect(TestEventSource.instances).toHaveLength(2);
    expect(TestEventSource.instances[1].closed).toBe(false);
    await act(async () => oldSource.emit('submission.updated', event({ submission_id: 42 })));
    expect(state().submission?.status).toBe('PENDING');
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores account A terminal detail %s after B starts its own lifecycle',
    async (outcome) => {
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      await mount();
      await click('Submit');
      await terminal();
      const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
      observed.user = { ...user, id: 'fixture-user-b', username: 'fixture-user-b' };
      await rerender();
      expect(signal.aborted).toBe(true);
      vi.mocked(submissionApi.create).mockResolvedValue(created({ id: 42 }));
      await shortcut();
      await act(async () => {
        if (outcome === 'resolve') pending.resolve(detail());
        else pending.reject(new NetworkError());
      });
      expect(state()).toMatchObject({
        submitting: true,
        submission: { id: 42, user_id: 'fixture-user-b', status: 'PENDING' },
        detailFetchError: '',
      });
      expect(observed.problem!.historyRefreshKey).toBe(0);
      expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
      expect(fetchProgress).not.toHaveBeenCalledWith(user.id, true);
      expect(observed.toast).not.toHaveBeenCalled();
      vi.mocked(submissionApi.get).mockResolvedValue(
        detail({ id: 42, user_id: 'fixture-user-b', username: 'fixture-user-b' }),
      );
      await act(async () =>
        TestEventSource.instances
          .at(-1)!
          .emit('submission.completed', event({ submission_id: 42, status: 'ACCEPTED' })),
      );
      expect(observed.problem!.historyRefreshKey).toBe(1);
      expect(vi.mocked(invalidateProgress).mock.calls).toEqual([[user.id], ['fixture-user-b']]);
      expect(fetchProgress).toHaveBeenLastCalledWith('fixture-user-b', true);
      expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Accepted', 'success');
    },
  );
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

  it.each(['ctrl', 'meta'] as const)(
    'blocks button and %s keyboard Submit during manual checking, then permits one keyboard POST',
    async (modifier) => {
      await mount();
      await click('Submit');
      await disconnect();
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
      await click('Check result');
      const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
      const submitButton = [...view!.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Submit',
      )!;
      expect(submitButton.disabled).toBe(true);
      expect(state().checkingResult).toBe(true);
      await click('Submit');
      await shortcut(true, modifier);
      expect(submissionApi.create).toHaveBeenCalledTimes(1);
      expect(submissionApi.get).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(false);
      expect(state()).toMatchObject({
        checkingResult: true,
        submitting: false,
        submission: { id: 41, status: 'PENDING' },
      });
      await act(async () => pending.resolve(detail({ status: 'JUDGING' })));
      expect(state().checkingResult).toBe(false);
      expect(submitButton.disabled).toBe(false);
      vi.mocked(submissionApi.create).mockResolvedValue(created({ id: 42 }));
      await shortcut(true, modifier);
      expect(submissionApi.create).toHaveBeenCalledTimes(2);
      expect(submissionApi.create).toHaveBeenNthCalledWith(2, {
        problem_id: 1,
        language: 'CPP',
        source_code: sourceCode,
      });
      expect(state()).toMatchObject({
        checkingResult: false,
        submitting: true,
        submission: { id: 42, status: 'PENDING' },
      });
      expect(observed.stream!.submissionId).toBe(42);
      await shortcut(true, modifier);
      await click('Submit');
      expect(submissionApi.create).toHaveBeenCalledTimes(2);
      expect(invalidateProgress).not.toHaveBeenCalled();
    },
  );

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

describe('SSE recovery and independent detail errors', () => {
  it('keeps the inactive logout presentation and ignores an old open without reactivating tracking', async () => {
    await mount();
    await click('Submit');
    const previous = TestEventSource.instances[0];
    await act(async () => previous.open());
    observed.user = null;
    await rerender();
    await act(async () => previous.open());
    expect(state()).toMatchObject({
      submission: { id: 41, status: 'PENDING' },
      streamState: 'idle',
      liveUpdateError: '',
      submitting: false,
    });
    expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
    expect(view!.container.textContent).toContain('Run your code against the test cases');
    expect(view!.container.textContent).not.toContain('queued — waiting for a judge worker');
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
  });

  it('keeps the warning through a failed reconnect and ignores opens from its replaced source', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await mount();
    await click('Submit');
    await disconnect();
    const warning = state().liveUpdateError;
    await click('Reconnect');
    const previous = TestEventSource.instances[1];
    await act(async () => previous.fail());
    expect(state().streamState).toBe('reconnecting');
    expect(state().liveUpdateError).toBe(warning);
    await act(async () => previous.open());
    expect(state().streamState).toBe('reconnecting');
    expect(view!.container.textContent).toContain(warning);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(TestEventSource.instances).toHaveLength(3);
    await act(async () => previous.open());
    expect(state().streamState).toBe('connecting');
    expect(state().liveUpdateError).toBe(warning);
    await act(async () => TestEventSource.instances[2].open());
    expect(state().liveUpdateError).toBe('');
    expect(view!.container.textContent).not.toContain(warning);
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(3);
    expect(submissionApi.get).not.toHaveBeenCalled();
  });

  it.each(['manual retry', 'terminal event'] as const)(
    'keeps a real detail error through SSE recovery and clears it on successful %s',
    async (recovery) => {
      await mount();
      await click('Submit');
      await disconnect();
      const warning = state().liveUpdateError;
      const message = 'fixture manual detail failure';
      vi.mocked(submissionApi.get).mockRejectedValueOnce(new ApiError(message, 503, 50300));
      await click('Check result');
      expect(view!.container.textContent).toContain(warning);
      expect(view!.container.textContent).toContain(message);
      await click('Reconnect');
      expect(state().detailFetchError).toBe(message);
      expect(view!.container.textContent).toContain(warning);
      await act(async () => TestEventSource.instances[1].open());
      expect(state()).toMatchObject({ liveUpdateError: '', detailFetchError: message });
      expect(view!.container.textContent).not.toContain(warning);
      expect(view!.container.textContent).toContain(message);
      expect(view!.container.textContent).toContain('queued — waiting for a judge worker');
      const retry = [...view!.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Retry detail',
      );
      expect(retry?.disabled).toBe(false);
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      if (recovery === 'manual retry') {
        await click('Retry detail');
        expect(state().checkingResult).toBe(true);
      } else {
        await terminal();
        expect(state().detailFetchError).toBe(message);
      }
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      await act(async () => pending.resolve(detail()));
      expect(state()).toMatchObject({
        submission: { status: 'ACCEPTED' },
        liveUpdateError: '',
        detailFetchError: '',
        checkingResult: false,
      });
      expect(view!.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      expect(observed.problem!.historyRefreshKey).toBe(1);
      expect(invalidateProgress).toHaveBeenCalledTimes(1);
      expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Accepted', 'success');
    },
  );

  it.each(['submission', 'slug', 'logout', 'account'] as const)(
    'ignores old connection recovery after a %s transition without hiding the current detail error',
    async (transition) => {
      await mount();
      await click('Submit');
      const previous = TestEventSource.instances[0];
      await disconnect();
      const warning = state().liveUpdateError;
      if (transition === 'slug') {
        observed.slug = 'another-problem';
        await rerender();
      } else if (transition === 'account' || transition === 'logout') {
        if (transition === 'logout') {
          observed.user = null;
          await rerender();
          await act(async () => previous.open());
          expect(state().liveUpdateError).toBe(warning);
          expect(observed.stream).toMatchObject({ submissionId: null, enabled: false });
        }
        observed.user = { ...user, id: 'fixture-user-b', username: 'fixture-user-b' };
        await rerender();
      }
      vi.mocked(submissionApi.create).mockResolvedValue(
        created({ id: 42, problem_id: transition === 'slug' ? 2 : 1 }),
      );
      await click('Submit');
      await disconnect();
      const message = 'current lifecycle detail failure';
      vi.mocked(submissionApi.get).mockRejectedValueOnce(new ApiError(message, 503, 50300));
      await click('Check result');
      await act(async () => {
        previous.open();
        previous.emit('submission.updated', event());
      });
      expect(state()).toMatchObject({
        submission: { id: 42, status: 'PENDING' },
        liveUpdateError: warning,
        detailFetchError: message,
      });
      expect(view!.container.textContent).toContain(warning);
      expect(view!.container.textContent).toContain(message);
      await click('Reconnect');
      await act(async () => previous.open());
      expect(state().liveUpdateError).toBe(warning);
      await act(async () => TestEventSource.instances.at(-1)!.open());
      expect(state().liveUpdateError).toBe('');
      expect(view!.container.textContent).not.toContain(warning);
      expect(view!.container.textContent).toContain(message);
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(3);
      if (transition === 'logout' || transition === 'account') {
        expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
      } else {
        expect(invalidateProgress).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'preserves current DOM errors when an obsolete account detail request later %s',
    async (outcome) => {
      await mount();
      await click('Submit');
      await disconnect();
      const previous = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(previous.promise);
      await click('Check result');
      observed.user = { ...user, id: 'fixture-user-b', username: 'fixture-user-b' };
      await rerender();
      vi.mocked(submissionApi.create).mockResolvedValue(created({ id: 42 }));
      await click('Submit');
      await disconnect();
      const warning = state().liveUpdateError;
      const message = 'current account detail failure';
      vi.mocked(submissionApi.get).mockRejectedValueOnce(new ApiError(message, 503, 50300));
      await click('Check result');
      await act(async () => {
        if (outcome === 'resolve') previous.resolve(detail({ status: 'WRONG_ANSWER' }));
        else previous.reject(new ApiError('obsolete account error', 503, 50300));
      });
      expect(state()).toMatchObject({
        submission: { id: 42, status: 'PENDING' },
        liveUpdateError: warning,
        detailFetchError: message,
      });
      expect(view!.container.textContent).toContain(warning);
      expect(view!.container.textContent).toContain(message);
      expect(view!.container.textContent).not.toContain('obsolete account error');
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
      expect(observed.problem!.historyRefreshKey).toBe(0);
      expect(observed.toast).not.toHaveBeenCalled();
    },
  );
});

describe('SSE status ordering', () => {
  it('keeps the judging UI after a stale manual GET and still completes through the reconnected stream', async () => {
    await mount();
    await click('Submit');
    await disconnect();
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
    await click('Check result');
    await click('Reconnect');
    const source = TestEventSource.instances.at(-1)!;
    await act(async () => {
      source.open();
      source.emit('submission.snapshot', event());
    });
    expect(view!.container.textContent).toContain('is being judged');
    await act(async () =>
      pending.resolve(detail({ status: 'PENDING', updated_at: '2026-11-17T02:00:00Z' })),
    );
    expect(state().submission).toMatchObject({ status: 'JUDGING', updated_at: event().updated_at });
    expect(view!.container.textContent).toContain('is being judged');
    expect(view!.container.textContent).not.toContain('queued — waiting');
    expect(state().checkingResult).toBe(false);
    expect(state().detailFetchError).toBe('');
    await act(async () => source.emit('submission.completed', event({ status: 'ACCEPTED' })));
    expect(state().submission).toEqual(detail());
    expect(observed.problem!.historyRefreshKey).toBe(1);
    expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(fetchProgress).toHaveBeenLastCalledWith(user.id, true);
    expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Accepted', 'success');
  });

  it('ignores duplicate and older same-status metadata without replacing the React submission object', async () => {
    await mount();
    await click('Submit');
    const source = TestEventSource.instances[0];
    await act(async () => source.emit('submission.updated', event()));
    const accepted = state().submission;
    await act(async () => {
      source.emit('submission.updated', event());
      source.emit('submission.updated', event());
      source.emit('submission.snapshot', event({ updated_at: '2026-11-17T00:59:00Z' }));
    });
    expect(state().submission).toBe(accepted);
    expect(submissionApi.get).not.toHaveBeenCalled();
  });

  it('accepts equal-timestamp phase advances while refusing equal-timestamp backwards updates', async () => {
    await mount();
    await click('Submit');
    const source = TestEventSource.instances[0];
    const updated_at = created().created_at;
    await act(async () =>
      source.emit('submission.snapshot', event({ status: 'PENDING', updated_at })),
    );
    await act(async () =>
      source.emit('submission.updated', event({ status: 'JUDGING', updated_at })),
    );
    expect(state().submission?.status).toBe('JUDGING');
    await act(async () =>
      source.emit('submission.updated', event({ status: 'PENDING', updated_at })),
    );
    expect(state().submission?.status).toBe('JUDGING');
    await act(async () =>
      source.emit('submission.completed', event({ status: 'ACCEPTED', updated_at })),
    );
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    expect(state().submission).toEqual(detail());
  });

  it.each(['', 'invalid-time'])(
    'allows a real phase advance with timestamp %j while retaining valid display metadata',
    async (updated_at) => {
      await mount();
      await click('Submit');
      const source = TestEventSource.instances[0];
      await act(async () => source.emit('submission.updated', event({ updated_at })));
      expect(state().submission).toMatchObject({
        status: 'JUDGING',
        updated_at: created().created_at,
      });
      await act(async () =>
        source.emit('submission.completed', event({ status: 'ACCEPTED', updated_at })),
      );
      expect(submissionApi.get).toHaveBeenCalledTimes(1);
      expect(state().submission).toEqual(detail());
    },
  );

  it.each(['manual', 'automatic'] as const)(
    'keeps ordering across %s reconnect replay and same-account refresh without dropping a clock-skewed terminal',
    async (reconnect) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      await mount();
      await click('Submit');
      await act(async () => TestEventSource.instances[0].emit('submission.snapshot', event()));
      if (reconnect === 'manual') {
        await disconnect();
        await click('Reconnect');
      } else {
        await act(async () => TestEventSource.instances[0].fail());
        await act(async () => vi.advanceTimersByTimeAsync(1000));
      }
      const source = TestEventSource.instances[1];
      const accepted = state().submission;
      await act(async () => {
        source.open();
        source.emit(
          'submission.snapshot',
          event({ status: 'PENDING', updated_at: '2026-11-17T01:00:00Z' }),
        );
        source.emit('submission.updated', event());
      });
      expect(state().submission).toBe(accepted);
      observed.user = { ...user, username: 'refreshed-name' };
      await rerender();
      await act(async () =>
        source.emit(
          'submission.updated',
          event({ status: 'PENDING', updated_at: '2026-11-17T04:00:00Z' }),
        ),
      );
      expect(state().submission).toBe(accepted);
      await act(async () =>
        source.emit(
          'submission.completed',
          event({ status: 'ACCEPTED', updated_at: '2026-11-17T00:59:00Z' }),
        ),
      );
      expect(submissionApi.get).toHaveBeenCalledTimes(1);
      expect(observed.problem!.historyRefreshKey).toBe(1);
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['PENDING', 'ACCEPTED'] as const)(
    'adopts a fresh connection snapshot for attempt B in %s and rejects attempt A events',
    async (status) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await mount();
      await click('Submit');
      await act(async () => TestEventSource.instances[0].emit('submission.snapshot', event()));
      await act(async () => TestEventSource.instances[0].fail());
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      const source = TestEventSource.instances[1];
      const next = event({
        attempt_id: 'fixture-attempt-b',
        status,
        updated_at: '2026-11-17T00:59:00Z',
      });
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
      await act(async () =>
        source.emit(status === 'ACCEPTED' ? 'submission.completed' : 'submission.snapshot', next),
      );
      expect(state().submission?.status).toBe(status);
      await act(async () =>
        source.emit('submission.updated', event({ updated_at: '2026-11-17T04:00:00Z' })),
      );
      expect(state().submission?.status).toBe(status);
      if (status === 'PENDING') {
        await act(async () => source.emit('submission.completed', { ...next, status: 'ACCEPTED' }));
      }
      expect(submissionApi.get).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve(detail()));
      expect(observed.problem!.historyRefreshKey).toBe(1);
      expect(invalidateProgress).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['submission', 'slug', 'account'] as const)(
    'starts independent ordering after a %s transition from a completed submission',
    async (transition) => {
      await mount();
      await click('Submit');
      const previous = TestEventSource.instances[0];
      await terminal();
      if (transition === 'slug') observed.slug = 'another-problem';
      if (transition === 'account')
        observed.user = { ...user, id: 'fixture-user-b', username: 'fixture-user-b' };
      if (transition !== 'submission') await rerender();
      vi.mocked(submissionApi.create).mockResolvedValue(
        created({ id: 42, problem_id: transition === 'slug' ? 2 : 1 }),
      );
      await click('Submit');
      const source = TestEventSource.instances[1];
      await act(async () => {
        previous.emit('submission.updated', event());
        source.emit(
          'submission.snapshot',
          event({ submission_id: 42, attempt_id: 'fixture-next', status: 'PENDING' }),
        );
        source.emit(
          'submission.updated',
          event({ submission_id: 42, attempt_id: 'fixture-next', status: 'JUDGING' }),
        );
      });
      expect(state().submission).toMatchObject({ id: 42, status: 'JUDGING' });
      vi.mocked(submissionApi.get).mockResolvedValue(detail({ id: 42 }));
      await act(async () =>
        source.emit(
          'submission.completed',
          event({ submission_id: 42, attempt_id: 'fixture-next', status: 'ACCEPTED' }),
        ),
      );
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      expect(observed.problem!.historyRefreshKey).toBe(2);
    },
  );

  it('keeps authoritative terminal HTTP detail even when its verdict/time differ from SSE under StrictMode', async () => {
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    await mount(true);
    await click('Submit');
    const source = TestEventSource.instances[0];
    const queuedStatus = observed.stream!.onStatus;
    await act(async () => {
      source.emit('submission.snapshot', event());
      source.emit('submission.updated', event({ status: 'PENDING' }));
      source.emit(
        'submission.completed',
        event({ status: 'ACCEPTED', updated_at: '2026-11-17T04:00:00Z' }),
      );
      source.emit(
        'submission.completed',
        event({ status: 'ACCEPTED', updated_at: '2026-11-17T04:00:00Z' }),
      );
    });
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    const final = detail({ status: 'WRONG_ANSWER' });
    await act(async () => {
      pending.resolve(final);
      await pending.promise;
      queuedStatus(event({ status: 'JUDGING', updated_at: '2026-11-17T05:00:00Z' }));
    });
    expect(state().submission).toEqual(final);
    expect(submissionApi.create).toHaveBeenCalledTimes(1);
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(1);
    expect(invalidateProgress).toHaveBeenCalledTimes(1);
    expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Verdict: Wrong Answer', 'error');
  });

  it.each(['PENDING', 'JUDGING'] as const)(
    'keeps a terminal event while detail is pending despite queued %s with a later timestamp',
    async (status) => {
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
      await mount();
      await click('Submit');
      const source = TestEventSource.instances[0];
      await act(async () => {
        source.emit('submission.completed', event({ status: 'ACCEPTED' }));
        source.emit('submission.updated', event({ status, updated_at: '2026-11-17T03:00:00Z' }));
      });
      expect(state().submission?.status).toBe('ACCEPTED');
      expect(submissionApi.get).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve(detail()));
      expect(state().submission).toEqual(detail());
      expect(observed.problem!.historyRefreshKey).toBe(1);
    },
  );

  it('keeps manual terminal detail authoritative against an already queued status callback', async () => {
    await mount();
    await click('Submit');
    await disconnect();
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(pending.promise);
    await click('Check result');
    const queuedStatus = observed.stream!.onStatus;
    await act(async () => {
      pending.resolve(detail());
      await pending.promise;
      queuedStatus(event({ status: 'JUDGING', updated_at: '2026-11-17T03:00:00Z' }));
    });
    expect(state().submission).toEqual(detail());
    expect(invalidateProgress).toHaveBeenCalledTimes(1);
    expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Accepted', 'success');
  });
});

describe('Workspace Run ownership and action guards', () => {
  const runOutput: RunResponse = {
    status: 'completed',
    compile_output: '',
    diagnostics: [
      {
        kind: 'runtime',
        severity: 'error',
        message: 'obsolete Run diagnostic',
        line: 4,
        column: 1,
      },
    ],
    tests: [
      {
        id: 'sample-1',
        kind: 'sample',
        status: 'runtime_error',
        stdout: 'obsolete Run output',
        stderr: 'old panic',
        expected_output: '1',
        execution_time_ms: 1,
        memory_used_kb: 1,
        diagnostics: [],
      },
    ],
  };

  it('ignores pending A output, diagnostics and testcase selection after a slug change', async () => {
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await mount();
    await click('Run');
    observed.slug = 'another-problem';
    await rerender();
    await click('Tests (1)');
    await click('+ Add case');
    const selected = view!.container.querySelector(
      'textarea[aria-label="Test input for Custom 1"]',
    );
    expect(selected).not.toBeNull();
    await act(async () => pending.resolve(runOutput));
    expect(observed.editor!.diagnostics).toEqual([]);
    expect(observed.editor!.highlightLine).toBeNull();
    expect(view!.container.textContent).not.toContain('obsolete Run diagnostic');
    // A stale first-failure callback would select the sample and hide this input.
    expect(view!.container.querySelector('textarea[aria-label="Test input for Custom 1"]')).toBe(
      selected,
    );
    await click('Result');
    expect(state().runResult).toBeNull();
    expect(state().running).toBe(false);
    await click('Console');
    expect(view!.container.textContent).not.toContain('obsolete Run output');
    await click('Run');
    expect(submissionApi.run).toHaveBeenCalledTimes(2);
  });

  it('hides completed Run result and editor markers in B first commit while preserving the editor', async () => {
    const commits: {
      diagnostics: ComponentProps<typeof CodeEditor>['diagnostics'];
      line: number | null | undefined;
      run: RunResponse | null | undefined;
    }[] = [];
    function OutputObserver() {
      useLayoutEffect(() => {
        commits.push({
          diagnostics: observed.editor?.diagnostics,
          line: observed.editor?.highlightLine,
          run: observed.result?.runResult,
        });
      });
      return createElement(WorkspacePage);
    }
    vi.mocked(submissionApi.run).mockResolvedValue(runOutput);
    view = await renderReact(createElement(OutputObserver));
    await click('Run');
    expect(observed.editor!.diagnostics).toEqual(runOutput.diagnostics);
    expect(observed.editor!.highlightLine).toBe(4);
    const editor = view.container.querySelector('textarea');
    observed.user = { ...user, id: 'account-b', username: 'account-b' };
    await view.rerender(createElement(OutputObserver));
    expect(commits.at(-1)).toEqual({ diagnostics: [], line: null, run: null });
    expect(view.container.querySelector('textarea')).toBe(editor);
    expect(observed.editor!.value).toBe(sourceCode);
    await click('Console');
    expect(view.container.textContent).not.toContain('obsolete Run output');
  });

  it.each(['ctrl', 'meta'] as const)(
    'blocks button and %s keyboard Run during manual checking, then permits one Run',
    async (modifier) => {
      await mount();
      await click('Submit');
      await disconnect();
      const pending = deferred<Submission>();
      vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
      await click('Check result');
      const runButton = [...view!.container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Run',
      )!;
      expect(runButton.disabled).toBe(true);
      await act(async () => runButton.click());
      await shortcut(false, modifier);
      expect(submissionApi.run).not.toHaveBeenCalled();
      expect(state().checkingResult).toBe(true);
      await act(async () => pending.resolve(detail({ status: 'JUDGING' })));
      await shortcut(false, modifier);
      expect(submissionApi.run).toHaveBeenCalledTimes(1);
      expect(submissionApi.create).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves authenticated current-scope Run diagnostics, first failure and language/source payload', async () => {
    vi.mocked(submissionApi.run).mockResolvedValue(runOutput);
    await mount();
    await click('Tests (1)');
    await click('+ Add case');
    await act(async () => observed.editor!.onChange('current source\n'));
    await shortcut(false);
    expect(observed.editor!.diagnostics).toEqual(runOutput.diagnostics);
    expect(observed.editor!.highlightLine).toBe(4);
    expect(vi.mocked(submissionApi.run).mock.calls[0][0]).toMatchObject({
      language: 'CPP',
      source_code: 'current source\n',
    });
    await click('Tests (2)');
    expect(
      view!.container.querySelector('textarea[aria-label="Test input for Custom 1"]'),
    ).toBeNull();
    await click('Submit');
    expect(submissionApi.create).toHaveBeenCalledExactlyOnceWith({
      problem_id: 1,
      language: 'CPP',
      source_code: 'current source\n',
    });
    expect(observed.editor!.diagnostics).toEqual([]);
  });

  it('preserves guest login redirect and offline keyboard Run guards', async () => {
    observed.user = null;
    await mount();
    await click('Run');
    expect(submissionApi.run).not.toHaveBeenCalled();
    expect(observed.push).toHaveBeenCalledExactlyOnceWith('/login?next=/problems/fixture-problem');
    expect(observed.toast).toHaveBeenCalledWith('Sign in to run code', 'error');
    observed.user = user;
    await rerender();
    await act(async () => window.dispatchEvent(new Event('offline')));
    await shortcut(false);
    expect(submissionApi.run).not.toHaveBeenCalled();
    expect(observed.toast).toHaveBeenCalledWith('You appear to be offline', 'error');
  });
});

describe('queued EventSource errors through the real Workspace lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  function retainError(source: TestEventSource) {
    const callback = source.onerror;
    expect(callback).not.toBeNull();
    return () => callback!.call(source, new Event('error'));
  }

  it.each(['normal', 'same-account refresh', 'StrictMode'] as const)(
    'keeps a recovered Workspace connected and completes once after stale errors (%s)',
    async (mode) => {
      await mount(mode === 'StrictMode');
      await click('Submit');
      const previous = TestEventSource.instances[0];
      const queuedError = retainError(previous);
      await act(async () => previous.open());
      if (mode === 'same-account refresh') {
        observed.user = { ...user, username: 'refreshed-user' };
        await rerender();
        expect(TestEventSource.instances).toHaveLength(1);
      }
      await act(async () => queuedError());
      expect(state().streamState).toBe('reconnecting');
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      const current = TestEventSource.instances[1];
      await act(async () => current.open());
      expect(state().streamState).toBe('open');
      await act(async () => queuedError());
      expect(state()).toMatchObject({
        streamState: 'open',
        liveUpdateError: '',
        detailFetchError: '',
        submission: { id: 41, status: 'PENDING' },
      });
      expect(current.closed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => vi.advanceTimersByTimeAsync(20000));
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(2);
      expect(TestEventSource.instances).toHaveLength(2);
      expect(view!.container.textContent).toContain('queued — waiting for a judge worker');
      await act(async () => {
        current.emit('submission.completed', event({ status: 'ACCEPTED' }));
        current.emit('submission.completed', event({ status: 'ACCEPTED' }));
        queuedError();
      });
      expect(state().submission).toEqual(detail());
      expect(state().liveUpdateError).toBe('');
      expect(submissionApi.get).toHaveBeenCalledTimes(1);
      expect(observed.problem!.historyRefreshKey).toBe(1);
      expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
      expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Accepted', 'success');
    },
  );

  it('preserves detail recovery through stream exhaustion, recovery and a stale same-generation error', async () => {
    await mount();
    await click('Submit');
    for (const [index, delay] of [1000, 2000, 4000, 8000, 10000].entries()) {
      await act(async () => TestEventSource.instances[index].fail());
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    const exhausted = retainError(TestEventSource.instances[5]);
    await act(async () => exhausted());
    const warning = 'Live updates are unavailable.';
    expect(state().liveUpdateError).toBe(warning);
    expect(view!.container.textContent).toContain(warning);
    vi.mocked(submissionApi.get).mockRejectedValueOnce(
      new ApiError('independent detail error', 503, 50300),
    );
    await click('Check result');
    await click('Reconnect');
    const previous = TestEventSource.instances[6];
    await act(async () => exhausted());
    expect(state().liveUpdateError).toBe(warning);
    await act(async () => previous.open());
    expect(state()).toMatchObject({
      liveUpdateError: '',
      detailFetchError: 'independent detail error',
    });
    const queuedError = retainError(previous);
    await act(async () => queuedError());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const current = TestEventSource.instances[7];
    await act(async () => current.open());
    await act(async () => queuedError());
    expect(state()).toMatchObject({
      streamState: 'open',
      liveUpdateError: '',
      detailFetchError: 'independent detail error',
    });
    expect(view!.container.textContent).not.toContain(warning);
    expect(view!.container.textContent).toContain('independent detail error');
    expect(current.closed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const pending = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
    await click('Retry detail');
    expect(state().checkingResult).toBe(true);
    await act(async () => pending.resolve(detail()));
    expect(state()).toMatchObject({
      submission: detail(),
      liveUpdateError: '',
      detailFetchError: '',
      checkingResult: false,
    });
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(8);
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    expect(observed.problem!.historyRefreshKey).toBe(1);
    expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
  });

  it.each(['account', 'logout', 'slug', 'submission', 'unmount'] as const)(
    'ignores queued errors after a %s transition without changing the current lifecycle',
    async (transition) => {
      await mount();
      await click('Submit');
      const previous = TestEventSource.instances[0];
      const queuedError = retainError(previous);
      if (transition === 'unmount') await view!.unmount();
      else if (transition === 'logout') {
        observed.user = null;
        await rerender();
      } else {
        if (transition === 'account') {
          observed.user = { ...user, id: 'fixture-user-b', username: 'fixture-user-b' };
          await rerender();
        } else if (transition === 'slug') {
          observed.slug = 'another-problem';
          await rerender();
        } else await disconnect(); // existing recovery permits a new Submit
        vi.mocked(submissionApi.create).mockResolvedValue(
          created({ id: 42, problem_id: transition === 'slug' ? 2 : 1 }),
        );
        await click('Submit');
        await act(async () => TestEventSource.instances.at(-1)!.open());
      }
      expect(previous.closed).toBe(true);
      const close = vi.spyOn(previous, 'close');
      const tickets = vi.mocked(submissionApi.issueStreamTicket).mock.calls.length;
      // The real editor may still have its independent 600ms draft-save timer.
      const timers = vi.getTimerCount();
      const before = {
        streamState: state().streamState,
        liveUpdateError: state().liveUpdateError,
        detailFetchError: state().detailFetchError,
        submission: state().submission,
        submitting: state().submitting,
      };
      await act(async () => queuedError());
      expect(state()).toMatchObject(before);
      expect(close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timers);
      await act(async () => vi.advanceTimersByTimeAsync(20000));
      expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(tickets);
      expect(submissionApi.get).not.toHaveBeenCalled();
      expect(observed.problem!.historyRefreshKey).toBe(0);
      expect(observed.toast).not.toHaveBeenCalled();
      if (transition !== 'logout' && transition !== 'unmount') {
        expect(TestEventSource.instances.at(-1)!.closed).toBe(false);
        expect(state()).toMatchObject({
          streamState: 'open',
          liveUpdateError: '',
          submission: { id: 42, status: 'PENDING' },
        });
      }
    },
  );
});
