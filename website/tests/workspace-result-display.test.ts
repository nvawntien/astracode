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
import { draftKey } from '../src/lib/templates';
import type { CodeEditor } from '../src/components/CodeEditor';
import { ApiError, NetworkError, problemApi, submissionApi } from '../src/lib/api';
import { fetchProgress, invalidateProgress } from '../src/lib/progress';
import type {
  CreateSubmissionResponse,
  Me,
  Problem,
  RunResponse,
  Submission,
  SubmissionDetail,
  SubmissionStreamEvent,
} from '../src/lib/types';
import { TestEventSource } from './helpers/event-source';
import { deferred, renderReact } from './helpers/react-dom';

// The actual Workspace, ResultPanel, ProblemPanel and lifecycle hooks render.
// Authentication, network I/O, progress loading, page chrome and editor internals
// are fixtures; progress cache isolation is covered by its dedicated suites.
const observed = vi.hoisted(() => ({
  user: null as Me | null,
  slug: 'result-problem',
  toast: vi.fn(),
  push: vi.fn(),
  editor: null as ComponentProps<typeof CodeEditor> | null,
  commits: [] as string[],
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
      value: props.value,
      readOnly: true,
      'aria-label': 'Result fixture editor',
    });
  },
}));
vi.mock('@/lib/progress', () => ({ fetchProgress: vi.fn(), invalidateProgress: vi.fn() }));

const user: Me = {
  id: 'result-user',
  username: 'result-user',
  full_name: 'Result User',
  email: 'result@example.test',
  role: 'user',
  rating: 0,
  is_active: true,
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
};
const problem: Problem = {
  id: 1,
  slug: 'result-problem',
  title: 'Result problem',
  description: 'Public statement',
  input_format: '',
  output_format: '',
  difficulty: 'easy',
  time_limit: 1,
  memory_limit: 128,
  created_at: user.created_at,
  examples: [{ input: '1', expected_output: '2' }],
};
const created: CreateSubmissionResponse = {
  id: 41,
  problem_id: 1,
  problem_title: problem.title,
  language: 'CPP',
  status: 'PENDING',
  created_at: user.created_at,
};
const official: SubmissionDetail = {
  ...created,
  attempt_id: 'result-attempt',
  user_id: user.id,
  username: user.username,
  source_code: '// official source',
  status: 'COMPILATION_ERROR',
  execution_time_ms: null,
  memory_used_kb: null,
  passed_testcases: 0,
  total_testcases: 1,
  compile_output: 'official compiler output',
  error_message: null,
  updated_at: user.updated_at,
};
const runResult: RunResponse = {
  status: 'completed',
  compile_output: '',
  diagnostics: [],
  tests: [
    {
      id: 'sample-1',
      kind: 'sample',
      status: 'accepted',
      stdout: 'Run console output',
      stderr: '',
      expected_output: '2',
      execution_time_ms: 7,
      memory_used_kb: 128,
      diagnostics: [],
    },
  ],
};
let view: Awaited<ReturnType<typeof renderReact>> | undefined;

function Fixture() {
  useLayoutEffect(() => {
    observed.commits.push(document.querySelector('#workspace-result-panel')?.textContent ?? '');
  });
  return createElement(WorkspacePage);
}
function element(strict = false) {
  const child = createElement(Fixture);
  return strict ? createElement(StrictMode, null, child) : child;
}
async function mount(strict = false) {
  view = await renderReact(element(strict));
}
function panel() {
  return view!.container.querySelector<HTMLElement>('#workspace-result-panel')!;
}
function text() {
  return panel().textContent ?? '';
}
function button(label: string) {
  const node = [...view!.container.querySelectorAll('button')].find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label,
  );
  expect(node, label).toBeDefined();
  return node!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function event(
  status: SubmissionStreamEvent['status'] = 'COMPILATION_ERROR',
  id = 41,
): SubmissionStreamEvent {
  return {
    submission_id: id,
    attempt_id: 'result-attempt',
    status,
    updated_at: '2026-11-18T00:01:00Z',
  };
}
async function finishOfficial() {
  await click('Submit');
  await act(async () => TestEventSource.instances.at(-1)!.emit('submission.completed', event()));
  expect(text()).toContain(official.compile_output);
}
async function shortcut() {
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', TestEventSource);
  TestEventSource.instances = [];
  const domWindow = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
  vi.stubGlobal('localStorage', domWindow.localStorage);
  vi.stubGlobal('sessionStorage', domWindow.sessionStorage);
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('astra-lang', 'CPP');
  localStorage.setItem(draftKey(user.id, 1, 'CPP'), '// draft');
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
  observed.user = user;
  observed.slug = problem.slug;
  observed.commits = [];
  observed.editor = null;
  vi.spyOn(problemApi, 'bySlug').mockImplementation(async (slug) => ({
    ...problem,
    slug,
    id: slug === problem.slug ? 1 : 2,
  }));
  vi.spyOn(submissionApi, 'create').mockResolvedValue(created);
  vi.spyOn(submissionApi, 'get').mockResolvedValue(official);
  vi.spyOn(submissionApi, 'run').mockResolvedValue(runResult);
  vi.spyOn(submissionApi, 'listMine').mockResolvedValue({
    items: [official],
    pagination: { page: 1, limit: 10, total: 1, total_pages: 1 },
  });
  vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue({
    ticket: 'result-ticket',
    expires_at: user.updated_at,
  });
  vi.mocked(fetchProgress).mockResolvedValue({
    submissions: [],
    solvedIds: new Set(),
    attemptedIds: new Set(),
    truncated: false,
  });
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

describe('action-owned result presentation with real Workspace and ResultPanel', () => {
  it.each([false, true])(
    'shows a newer Run while retaining access to the official result (StrictMode=%s)',
    async (strict) => {
      await mount(strict);
      await finishOfficial();
      await act(async () => observed.editor!.onChange('// edited code'));
      const pending = deferred<RunResponse>();
      vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
      await click('Run');
      expect(text()).toContain('Running your code');
      expect(text()).not.toContain(official.compile_output);
      await act(async () => pending.resolve(runResult));
      expect(text()).toContain('All selected test cases passed');
      expect(text()).not.toContain(official.compile_output);
      await click('View submission result');
      expect(text()).toContain(official.compile_output);
      expect(submissionApi.get).toHaveBeenCalledTimes(1);
      await click('View Run result');
      expect(text()).toContain('All selected test cases passed');
      await click('View submission result');
      await click('View all submissions');
      expect(submissionApi.listMine).toHaveBeenCalledWith(
        { problem_id: 1, page: 1, limit: 10 },
        expect.any(AbortSignal),
      );
      expect(submissionApi.create).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['compile', 'runtime'] as const)(
    'shows current Run %s failure instead of an old official verdict',
    async (kind) => {
      await mount();
      await finishOfficial();
      const diagnostic = {
        kind,
        severity: 'error',
        message: 'current Run diagnostic',
        line: 3,
        column: 1,
      };
      const failure: RunResponse =
        kind === 'compile'
          ? {
              status: 'compile_error',
              compile_output: 'current Run compiler output',
              diagnostics: [diagnostic],
              tests: [],
            }
          : {
              ...runResult,
              diagnostics: [diagnostic],
              tests: [
                {
                  ...runResult.tests[0],
                  status: 'runtime_error',
                  stdout: '',
                  stderr: 'current Run panic',
                },
              ],
            };
      vi.mocked(submissionApi.run).mockResolvedValueOnce(failure);
      await click('Run');
      expect(text()).not.toContain(official.compile_output);
      expect(text()).toContain('current Run diagnostic');
      expect(observed.editor?.highlightLine).toBe(3);
      await click('Console');
      expect(text()).toContain(
        kind === 'compile' ? 'current Run compiler output' : 'current Run panic',
      );
      await click('Result');
      expect(text()).not.toContain(official.compile_output);
    },
  );

  it.each(['collapsed button', 'collapsed keyboard', 'expanded button'] as const)(
    'opens Result at the retained height on %s Run',
    async (mode) => {
      sessionStorage.setItem('astra-bottom', '310');
      await mount();
      await click('Console');
      if (mode.startsWith('collapsed')) await click('Collapse panel');
      const pending = deferred<RunResponse>();
      vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
      if (mode === 'collapsed keyboard') await shortcut();
      else await click('Run');
      expect(panel().style.height).toBe('310px');
      expect(button('Result').getAttribute('aria-selected')).toBe('true');
      expect(button('Collapse panel').getAttribute('aria-expanded')).toBe('true');
      expect(text()).toContain('Running your code');
      expect(sessionStorage.getItem('astra-bottom')).toBe('310');
      await act(async () => pending.resolve(runResult));
      expect(text()).toContain('All selected test cases passed');
      expect(panel().style.height).toBe('310px');
    },
  );

  it('shows pending content for a second Run and preserves explicit source choice through completion', async () => {
    await mount();
    await finishOfficial();
    await click('Run');
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await click('Run');
    expect(text()).toContain('Running your code');
    expect(text()).not.toContain('All selected test cases passed');
    await click('View submission result');
    expect(text()).toContain(official.compile_output);
    await act(async () => pending.resolve(runResult));
    expect(text()).toContain(official.compile_output);
    expect(text()).not.toContain('All selected test cases passed');
    await click('View Run result');
    expect(text()).toContain('All selected test cases passed');
  });

  it('selects official presentation on Submit while creation is pending and retains console', async () => {
    await mount();
    await click('Run');
    const pending = deferred<CreateSubmissionResponse>();
    vi.mocked(submissionApi.create).mockReturnValueOnce(pending.promise);
    await click('Collapse panel');
    await click('Submit');
    expect(button('Result').getAttribute('aria-selected')).toBe('true');
    expect(panel().style.height).toBe('235px');
    expect(text()).toContain('Submitting your code');
    expect(text()).not.toContain('All selected test cases passed');
    await act(async () => pending.resolve({ ...created, id: 42 }));
    await act(async () => TestEventSource.instances.at(-1)!.open());
    expect(text()).toContain('Submission #42');
    expect(text()).toContain('queued');
    await shortcut();
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    await click('Console');
    expect(text()).toContain('Run console output');
    await click('Result');
    expect(text()).toContain('Submission #42');
  });

  it('keeps Run selected when a legally tracked official submission finishes in the background', async () => {
    await mount();
    await click('Submit');
    await act(async () => TestEventSource.instances.at(-1)!.raw('submission.updated', '{invalid'));
    await click('Reconnect');
    const source = TestEventSource.instances.at(-1)!;
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    // Existing stream-error handling released submitting, so the existing Run
    // guards permit this action; no concurrent new Submit is invented here.
    await click('Run');
    await act(async () => {
      source.open();
      source.emit('submission.updated', event('JUDGING'));
    });
    expect(text()).toContain('Running your code');
    await act(async () => source.emit('submission.completed', event()));
    expect(text()).toContain('Running your code');
    expect(text()).not.toContain(official.compile_output);
    await act(async () => pending.resolve(runResult));
    expect(text()).toContain('All selected test cases passed');
    expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(observed.toast).toHaveBeenCalledTimes(1);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    await click('View submission result');
    expect(text()).toContain(official.compile_output);
  });

  it('keeps an explicit official view when the pending Run later reports unavailable', async () => {
    await mount();
    await finishOfficial();
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await click('Run');
    await act(async () => {
      button('View submission result').click();
      pending.reject(new ApiError('unavailable', 501, 50100));
    });
    expect(button('Result').getAttribute('aria-selected')).toBe('true');
    expect(text()).toContain(official.compile_output);
    await click('Console');
    expect(text()).toContain('Custom tests are unavailable');
  });

  it('keeps official manual recovery accessible and respects a later explicit Run choice', async () => {
    vi.mocked(submissionApi.get).mockRejectedValueOnce(new NetworkError());
    await mount();
    await click('Submit');
    await act(async () => TestEventSource.instances.at(-1)!.emit('submission.completed', event()));
    expect(text()).toContain('Verdict received');
    await click('Run');
    expect(text()).toContain('All selected test cases passed');
    expect(text()).not.toContain('Verdict received');
    await click('View submission result');
    expect(text()).toContain('Verdict received');
    const recovery = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(recovery.promise);
    await click('Retry detail');
    await click('View Run result');
    await act(async () => recovery.resolve(official));
    expect(text()).toContain('All selected test cases passed');
    expect(text()).not.toContain(official.compile_output);
    await click('View submission result');
    expect(text()).toContain(official.compile_output);
    expect(text()).not.toContain('Verdict received');
    expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
  });

  it('keeps a same-verdict attempt mismatch separate from Run and opens current history detail', async () => {
    const pending = deferred<SubmissionDetail>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(pending.promise);
    await mount();
    await click('Submit');
    const source = TestEventSource.instances.at(-1)!;
    await act(async () => source.emit('submission.completed', event()));
    const current = {
      ...official,
      attempt_id: 'rejudge-attempt',
      compile_output: 'current attempt diagnostics',
    };
    await act(async () => pending.resolve(current));
    expect(panel().querySelector('[role="alert"]')?.textContent).toContain('another attempt');
    expect(text()).not.toContain('current attempt diagnostics');
    expect(observed.toast).not.toHaveBeenCalled();
    expect(invalidateProgress).not.toHaveBeenCalled();
    expect(fetchProgress).not.toHaveBeenCalledWith(user.id, true);
    expect(submissionApi.listMine).not.toHaveBeenCalled();
    expect(submissionApi.get).toHaveBeenCalledTimes(1);

    await click('Run');
    expect(text()).toContain('All selected test cases passed');
    expect(text()).not.toContain('another attempt');
    await click('View submission result');
    expect(text()).toContain('another attempt');
    await click('View submissions');
    expect(submissionApi.listMine).toHaveBeenCalledTimes(1);
    vi.mocked(submissionApi.get).mockResolvedValueOnce(current);
    const row = [...view!.container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('#41'),
    );
    expect(row).toBeDefined();
    await act(async () => row!.click());
    expect(submissionApi.get).toHaveBeenLastCalledWith(41, expect.any(AbortSignal));
    expect(
      view!.container.querySelector('[aria-label="Submission detail"]')?.textContent,
    ).toContain('current attempt diagnostics');
    expect(text()).toContain('another attempt');
    expect(invalidateProgress).not.toHaveBeenCalled();

    await click('Retry detail');
    expect(text()).toContain(official.compile_output);
    expect(text()).not.toContain('another attempt');
    expect(observed.toast).toHaveBeenCalledTimes(1);
    expect(invalidateProgress).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(fetchProgress).toHaveBeenLastCalledWith(user.id, true);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
    expect(submissionApi.get).toHaveBeenCalledTimes(3);
  });

  it.each(['network', 'unavailable'] as const)(
    'does not fall back to an unrelated official verdict after a Run %s error',
    async (failure) => {
      await mount();
      await finishOfficial();
      vi.mocked(submissionApi.run).mockRejectedValueOnce(
        failure === 'network' ? new NetworkError() : new ApiError('unavailable', 501, 50100),
      );
      await click('Collapse panel');
      await click('Run');
      expect(panel().style.height).toBe('235px');
      if (failure === 'unavailable') {
        expect(text()).toContain('Custom tests are unavailable');
        await click('Result');
      }
      expect(text()).not.toContain(official.compile_output);
      expect(text()).toContain('Run your code against the test cases');
      await click('View submission result');
      expect(text()).toContain(official.compile_output);
    },
  );

  it.each([
    ['account', 'run'],
    ['logout', 'run'],
    ['problem', 'run'],
    ['account', 'submission'],
    ['logout', 'submission'],
    ['problem', 'submission'],
  ] as const)(
    'resets display ownership on %s from %s before the first commit',
    async (change, source) => {
      await mount();
      await finishOfficial();
      vi.mocked(submissionApi.run).mockResolvedValueOnce({
        status: 'compile_error',
        compile_output: 'private Run marker',
        diagnostics: [],
        tests: [],
      });
      await click('Run');
      expect(text()).toContain('private Run marker');
      if (source === 'submission') {
        await click('View submission result');
        expect(text()).toContain(official.compile_output);
      }
      const commitStart = observed.commits.length;
      if (change === 'problem') observed.slug = 'other-problem';
      else observed.user = change === 'logout' ? null : { ...user, id: 'other-account' };
      await view!.rerender(element());
      const scopeCommits = observed.commits.slice(commitStart);
      expect(scopeCommits.length).toBeGreaterThan(0);
      for (const commit of scopeCommits) {
        expect(commit).not.toContain('private Run marker');
        expect(commit).not.toContain(official.compile_output);
      }
      expect(text()).not.toContain('private Run marker');
      expect(text()).not.toContain(official.compile_output);
      expect(text()).toContain('Run your code against the test cases');
    },
  );

  it('preserves source selection through same-ID refresh, bottom tabs and collapse/expand', async () => {
    await mount();
    await finishOfficial();
    await click('Run');
    await click('View submission result');
    observed.user = { ...user, full_name: 'Refreshed' };
    await view!.rerender(element());
    expect(text()).toContain(official.compile_output);
    await click('Console');
    await click('Tests (1)');
    await click('Result');
    expect(text()).toContain(official.compile_output);
    await click('Collapse panel');
    await click('Expand panel');
    expect(text()).toContain(official.compile_output);
    await click('View Run result');
    expect(text()).toContain('All selected test cases passed');
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
  });

  it('does not let obsolete Run completion replace a new problem Submit selection', async () => {
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await mount();
    await click('Run');
    observed.slug = 'other-problem';
    await view!.rerender(element());
    vi.mocked(submissionApi.create).mockResolvedValueOnce({ ...created, id: 42, problem_id: 2 });
    await click('Submit');
    await act(async () =>
      pending.resolve({
        status: 'compile_error',
        compile_output: 'obsolete Run marker',
        diagnostics: [],
        tests: [],
      }),
    );
    expect(text()).toContain('Submission #42');
    expect(text()).not.toContain('obsolete Run marker');
    expect(vi.mocked(submissionApi.run).mock.calls[0][1]!.aborted).toBe(true);
  });
});

describe('testcase collection in the real Workspace', () => {
  it('rejects a full collection from Add Example without changing mobile view, tab or Run payload', async () => {
    window.innerWidth = 700;
    await mount();
    const example = 'Use input from example 1 as a test';
    await click(example);
    expect(button('Code').getAttribute('aria-selected')).toBe('true');
    expect(button('Tests (2)').getAttribute('aria-selected')).toBe('true');
    for (let i = 0; i < 8; i++) await click('+ Add case');
    await click('Case 1');
    await shortcut();
    const originalRequest = vi.mocked(submissionApi.run).mock.calls[0][0];
    expect(originalRequest.testcases).toHaveLength(10);

    await click('Console');
    await click('Problem');
    observed.toast.mockClear();
    await click(example);
    expect(button('Problem').getAttribute('aria-selected')).toBe('true');
    expect(observed.toast.mock.calls).toEqual([['Maximum of 10 test cases', 'error']]);
    expect(observed.push).not.toHaveBeenCalled();

    await click('Code');
    expect(button('Console').getAttribute('aria-selected')).toBe('true');
    await click('Tests (10)');
    expect(button('Case 1').getAttribute('aria-pressed')).toBe('true');
    await shortcut();
    expect(submissionApi.run).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submissionApi.run).mock.calls[1][0]).toEqual(originalRequest);
  });

  it('sends ordered current testcase values after a selected deletion and selects failures by surviving ID', async () => {
    // Keep values distinct even on the original implementation so this case
    // exercises selection and response mapping independently of ID collisions.
    let timestamp = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => timestamp++);
    await mount();
    await click('+ Add case');
    await click('+ Add case');
    await click('+ Add case');
    await click('Remove Custom 3');
    expect(button('Custom 2').getAttribute('aria-pressed')).toBe('true');
    await click('Use input from example 1 as a test');
    expect(button('Custom 3').getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      const input = view!.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Test input for Custom 3"]',
      )!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '  edited\n',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await shortcut();
    const [request] = vi.mocked(submissionApi.run).mock.calls[0];
    expect(request).toEqual({
      problem_id: problem.id,
      language: 'CPP',
      source_code: '// draft',
      testcases: [
        { id: 'sample-1', kind: 'sample', stdin: '1', expected_output: '2' },
        { id: expect.any(String), kind: 'custom', stdin: '', expected_output: null },
        { id: expect.any(String), kind: 'custom', stdin: '', expected_output: null },
        { id: expect.any(String), kind: 'custom', stdin: '  edited\n', expected_output: '2' },
      ],
    });

    await click('Tests (4)');
    await click('Remove Custom 1');
    await click('Custom 2');
    await act(async () =>
      pending.resolve({
        ...runResult,
        tests: request.testcases.map((test, index) => ({
          ...runResult.tests[0],
          id: test.id,
          kind: test.kind,
          expected_output: test.expected_output,
          status: index === 1 || index === 3 ? 'wrong_answer' : 'accepted',
        })),
      }),
    );
    expect(button('Custom 3').getAttribute('aria-pressed')).toBe('true');
    expect(
      view!.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Test input for Custom 3"]',
      )?.value,
    ).toBe('  edited\n');
  });
});

function loadExamples(count: number) {
  vi.mocked(problemApi.bySlug).mockImplementation(async () => ({
    ...problem,
    examples: Array.from({ length: count }, (_, i) => ({
      input: `stdin ${i + 1}\n`,
      expected_output: `stdout ${i + 1}\n`,
    })),
  }));
}

function checkbox(caseName: string) {
  const input = [
    ...view!.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((control) => control.getAttribute('aria-label') === `Include ${caseName} in Run`);
  expect(input, caseName).toBeDefined();
  return input!;
}

async function toggle(caseName: string) {
  await act(async () => checkbox(caseName).click());
}

async function editCase(label: string, value: string) {
  const input = view!.container.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('explicit Run testcase selection in the real Workspace', () => {
  it.each(['button', 'keyboard', 'stacked keyboard', 'mobile button'] as const)(
    'reveals zero-selection guidance and sends no request on %s Run',
    async (mode) => {
      loadExamples(11);
      if (mode === 'stacked keyboard') window.innerWidth = 900;
      if (mode === 'mobile button') window.innerWidth = 700;
      await mount();
      if (mode === 'stacked keyboard' || mode === 'mobile button') await click('Code');
      if (mode !== 'mobile button') await click('Collapse panel');
      if (mode === 'stacked keyboard') await click('Problem');
      if (mode === 'button' || mode === 'mobile button') await click('Run');
      else await shortcut();
      expect(submissionApi.run).not.toHaveBeenCalled();
      expect(submissionApi.create).not.toHaveBeenCalled();
      if (mode === 'stacked keyboard')
        expect(button('Code').getAttribute('aria-selected')).toBe('true');
      if (mode !== 'mobile button') {
        expect(button('Collapse panel').getAttribute('aria-expanded')).toBe('true');
      }
      expect(button('Tests (11)').getAttribute('aria-selected')).toBe('true');
      expect(text()).toContain('Select 1–10 test cases to run.');
      expect(checkbox('Case 11').checked).toBe(false);
    },
  );

  it('sends only explicitly included cases in collection order and reuses inclusion until changed', async () => {
    loadExamples(11);
    await mount(true);
    await toggle('Case 11');
    await toggle('Case 5');
    await toggle('Case 2');
    expect(button('Case 1').getAttribute('aria-pressed')).toBe('true');
    await click('Case 5');
    expect(checkbox('Case 5').checked).toBe(true);
    expect(text()).toContain('3 / 10 selected · 11 available');
    observed.user = { ...user };
    await view!.rerender(element(true));
    expect(text()).toContain('3 / 10 selected · 11 available');

    await click('Collapse panel');
    vi.mocked(submissionApi.run).mockImplementation(async ({ testcases }) => ({
      ...runResult,
      tests: testcases.map(({ id, kind }) => ({ ...runResult.tests[0], id, kind })),
    }));
    await click('Run');
    expect(button('Result').getAttribute('aria-selected')).toBe('true');
    expect(button('Collapse panel').getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('All selected test cases passed');
    const request = {
      problem_id: problem.id,
      language: 'CPP',
      source_code: '// draft',
      testcases: [2, 5, 11].map((n) => ({
        id: `sample-${n}`,
        kind: 'sample',
        stdin: `stdin ${n}\n`,
        expected_output: `stdout ${n}\n`,
      })),
    };
    expect(submissionApi.run).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
    await shortcut();
    expect(submissionApi.run).toHaveBeenLastCalledWith(request, expect.any(AbortSignal));

    await click('Tests (11)');
    await click('Case 1');
    expect(text()).toContain('Not included in the last Run');
    expect(text()).not.toContain('Actual Output');
    await toggle('Case 5');
    await shortcut();
    expect(submissionApi.run).toHaveBeenCalledTimes(3);
    expect(submissionApi.run).toHaveBeenLastCalledWith(
      { ...request, testcases: [request.testcases[0], request.testcases[2]] },
      expect.any(AbortSignal),
    );
  });

  it('keeps the previous result and console after empty Run, and Submit still sends only source', async () => {
    await mount();
    await click('Run');
    await click('Tests (1)');
    await toggle('Case 1');
    await click('Run');
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Select 1–10 test cases to run.');
    await click('Console');
    expect(text()).toContain('Run console output');
    await click('Result');
    expect(text()).toContain('All selected test cases passed');
    await click('Submit');
    expect(submissionApi.create).toHaveBeenCalledExactlyOnceWith(
      { problem_id: problem.id, language: 'CPP', source_code: '// draft' },
      expect.any(Function),
    );
    expect(button('Result').getAttribute('aria-selected')).toBe('true');
  });
});

describe('Run result attribution by submitted testcase values', () => {
  it.each([
    { change: 'uncheck A', toggleCases: [1], nextCases: [2], bothFail: false },
    { change: 'replace A with C', toggleCases: [1, 3], nextCases: [2, 3], bothFail: false },
    { change: 'uncheck both', toggleCases: [1, 2], nextCases: [], bothFail: false },
    { change: 'keep A checked', toggleCases: [], nextCases: [1, 2], bothFail: false },
    { change: 'uncheck A when both fail', toggleCases: [1], nextCases: [2], bothFail: true },
  ])(
    'focuses the first snapshot failure after pending Run selection changes: $change',
    async ({ toggleCases, nextCases, bothFail }) => {
      loadExamples(3);
      await mount(true);
      await toggle('Case 3');
      await click('Case 2');

      const pending = deferred<RunResponse>();
      vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
      const testcase = (n: number) => ({
        id: `sample-${n}`,
        kind: 'sample',
        stdin: `stdin ${n}\n`,
        expected_output: `stdout ${n}\n`,
      });
      const original = {
        problem_id: problem.id,
        language: 'CPP',
        source_code: '// draft',
        testcases: [testcase(1), testcase(2)],
      };
      await click('Run');
      expect(submissionApi.run).toHaveBeenCalledExactlyOnceWith(original, expect.any(AbortSignal));
      await click('Tests (3)');
      for (const n of toggleCases) await toggle(`Case ${n}`);
      expect(button('Case 2').getAttribute('aria-pressed')).toBe('true');

      const firstFailure = {
        ...runResult.tests[0],
        status: 'wrong_answer' as const,
        stdout: 'original A output',
        expected_output: original.testcases[0].expected_output,
      };
      const secondResult = {
        ...runResult.tests[0],
        id: 'sample-2',
        status: bothFail ? ('runtime_error' as const) : ('accepted' as const),
        stdout: 'original B output',
        expected_output: original.testcases[1].expected_output,
      };
      await act(async () =>
        pending.resolve({
          ...runResult,
          // Deliberately reverse the failures to check submitted execution order.
          tests: bothFail ? [secondResult, firstFailure] : [firstFailure, secondResult],
        }),
      );
      await click('Result');
      expect(text()).toContain(`${bothFail ? 2 : 1} failed among selected test cases`);
      expect(text()).toContain('sample-1');
      expect(text()).toContain('sample-2');
      await click('Console');
      expect(text()).toContain('original A output');
      expect(text()).toContain('original B output');
      expect(submissionApi.run).toHaveBeenCalledExactlyOnceWith(original, expect.any(AbortSignal));

      await click('Tests (3)');
      expect(button('Case 1').getAttribute('aria-pressed')).toBe('true');
      expect(text()).toContain('original A output');
      expect([1, 2, 3].filter((n) => checkbox(`Case ${n}`).checked)).toEqual(nextCases);
      await click('Run');
      if (nextCases.length > 0) {
        expect(submissionApi.run).toHaveBeenCalledTimes(2);
        expect(submissionApi.run).toHaveBeenLastCalledWith(
          { ...original, testcases: nextCases.map(testcase) },
          expect.any(AbortSignal),
        );
      } else {
        expect(submissionApi.run).toHaveBeenCalledTimes(1);
        expect(text()).toContain('Select 1–10 test cases to run.');
        expect(button('Case 1').getAttribute('aria-pressed')).toBe('true');
      }
    },
  );

  it.each([
    ['Test input for Custom 1', 'input Y'],
    ['Expected output for Custom 1', 'expected B'],
  ])('keeps a deferred verdict off the edited case after changing %s', async (field, edit) => {
    await mount();
    await click('Use input from example 1 as a test');
    await editCase('Test input for Custom 1', 'input X');
    await editCase('Expected output for Custom 1', 'expected A');
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await shortcut();
    const [request] = vi.mocked(submissionApi.run).mock.calls[0];
    expect(request.testcases[1]).toEqual({
      id: 'custom-1',
      kind: 'custom',
      stdin: 'input X',
      expected_output: 'expected A',
    });

    await click('Tests (2)');
    await editCase(field, edit);
    await click('Case 1');
    await act(async () =>
      pending.resolve({
        ...runResult,
        tests: [
          ...runResult.tests,
          {
            ...runResult.tests[0],
            id: 'custom-1',
            kind: 'custom',
            status: 'wrong_answer',
            stdout: 'output for original values',
            expected_output: 'expected A',
          },
        ],
      }),
    );

    expect(button('Case 1').getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('Run console output');
    await click('Custom 1');
    expect(text()).not.toContain('output for original values');
    expect(text()).toContain('Changed since the last Run');
    await click('Console');
    expect(text()).toContain('output for original values');
    await click('Result');
    expect(text()).toContain('1 failed');
  });

  it('keeps the original execution snapshot across pending inclusion, delete and add changes', async () => {
    await mount();
    await click('+ Add case');
    await click('+ Add case');
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await click('Run');
    const [request] = vi.mocked(submissionApi.run).mock.calls[0];
    expect(request.testcases.map((test) => test.id)).toEqual(['sample-1', 'custom-1', 'custom-2']);
    await click('Tests (3)');
    await toggle('Case 1');
    await click('Remove Custom 1');
    await click('+ Add case');
    expect(text()).toContain('Input — Custom 2');
    const activeCase = () =>
      panel().querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    const addedCase = activeCase();
    await act(async () =>
      pending.resolve({
        ...runResult,
        tests: request.testcases.map((test) => ({
          ...runResult.tests[0],
          id: test.id,
          kind: test.kind,
          status: test.id === 'custom-2' ? 'accepted' : 'wrong_answer',
          stdout: `snapshot output from ${test.id}`,
        })),
      }),
    );
    // The removed failure is ineligible. The unchanged sample still belongs
    // to this Run even though it was unchecked for the next one.
    expect(activeCase()).toBe(button('Case 1'));
    expect(checkbox('Case 1').checked).toBe(false);
    expect(text()).toContain('snapshot output from sample-1');
    await act(async () => addedCase!.click());
    expect(activeCase()).toBe(addedCase);
    expect(text()).toContain('Not included in the last Run');
    expect(text()).not.toContain('Actual Output');
    await click('Console');
    expect(text()).toContain('snapshot output from custom-1');
    await shortcut();
    expect(submissionApi.run).toHaveBeenLastCalledWith(
      {
        ...request,
        testcases: [
          request.testcases[2],
          { id: 'custom-3', kind: 'custom', stdin: '', expected_output: null },
        ],
      },
      expect.any(AbortSignal),
    );
  });

  it('preserves the active case and shows no inline verdict after compilation failure', async () => {
    loadExamples(2);
    await mount();
    await click('Case 2');
    vi.mocked(submissionApi.run).mockResolvedValueOnce({
      ...runResult,
      status: 'compile_error',
      compile_output: 'compiler diagnostic',
      tests: [],
    });
    await click('Run');
    expect(text()).toContain('compiler diagnostic');
    await click('Tests (2)');
    expect(button('Case 2').getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('No result for this case in the last Run');
    expect(text()).not.toContain('Actual Output');
  });
});
