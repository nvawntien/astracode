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
import type { CodeEditor } from '../src/components/CodeEditor';
import { ApiError, NetworkError, problemApi, submissionApi } from '../src/lib/api';
import { fetchProgress } from '../src/lib/progress';
import type {
  ListSubmissionsResponse,
  Me,
  Problem,
  Submission,
  SubmissionListItem,
} from '../src/lib/types';
import { TestEventSource } from './helpers/event-source';
import { deferred, renderReact } from './helpers/react-dom';

// Keep the route, ProblemPanel, history, detail, polling and feature hooks real.
// Authentication, network I/O and unrelated page chrome/editor internals are boundaries.
const observed = vi.hoisted(() => ({
  user: null as Me | null,
  slug: 'history-problem',
  push: vi.fn(),
  toast: vi.fn(),
  editor: null as ComponentProps<typeof CodeEditor> | null,
  commits: [] as { accountId: string | null; history: string; dialog: string }[],
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
      'aria-label': 'History fixture editor',
      value: props.value,
      readOnly: true,
    });
  },
}));
vi.mock('@/lib/progress', () => ({ fetchProgress: vi.fn(), invalidateProgress: vi.fn() }));

const accountA: Me = {
  id: 'account-a',
  username: 'account-a',
  full_name: 'Account A',
  email: 'a@example.test',
  role: 'user',
  rating: 0,
  is_active: true,
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
};
const accountB: Me = {
  ...accountA,
  id: 'account-b',
  username: 'account-b',
  email: 'b@example.test',
};
const problem: Problem = {
  id: 1,
  slug: 'history-problem',
  title: 'History problem',
  description: 'Public statement',
  input_format: '',
  output_format: '',
  difficulty: 'easy',
  time_limit: 1,
  memory_limit: 128,
  created_at: accountA.created_at,
  examples: [{ input: '1', expected_output: '2' }],
};
const draft = '// existing local draft\n';
const privateSourceA = '// private account A source\n';
const privateSourceB = '// private account B source\n';

function detail(id = 101, overrides: Partial<Submission> = {}): Submission {
  const owner = id >= 200 ? accountB : accountA;
  return {
    id,
    problem_id: 1,
    problem_title: problem.title,
    user_id: owner.id,
    username: owner.username,
    language: 'CPP',
    source_code: owner === accountA ? privateSourceA : privateSourceB,
    status: 'ACCEPTED',
    execution_time_ms: 12,
    memory_used_kb: 2048,
    passed_testcases: 3,
    total_testcases: 3,
    compile_output: null,
    error_message: null,
    created_at: accountA.created_at,
    updated_at: accountA.updated_at,
    ...overrides,
  };
}
function history(
  items: SubmissionListItem[] = [detail()],
  page = 1,
  totalPages = 1,
): ListSubmissionsResponse {
  return {
    // The real history endpoint has no source code or user identity fields.
    items: items.map((item) => ({
      id: item.id,
      problem_id: item.problem_id,
      problem_title: item.problem_title,
      language: item.language,
      status: item.status,
      execution_time_ms: item.execution_time_ms,
      memory_used_kb: item.memory_used_kb,
      passed_testcases: item.passed_testcases,
      total_testcases: item.total_testcases,
      created_at: item.created_at,
    })),
    pagination: { page, limit: 10, total: totalPages * 10, total_pages: totalPages },
  };
}
let view: Awaited<ReturnType<typeof renderReact>> | undefined;

function CommitObserver() {
  // Parent layout effects inspect the committed DOM before passive reset effects.
  useLayoutEffect(() => {
    observed.commits.push({
      accountId: observed.user?.id ?? null,
      history: document.querySelector('#workspace-problem-pane')?.textContent ?? '',
      dialog: document.querySelector('[aria-label="Replace editor code"]')?.textContent ?? '',
    });
  });
  return createElement(WorkspacePage);
}
function element(strict = false) {
  const fixture = createElement(CommitObserver);
  return strict ? createElement(StrictMode, null, fixture) : fixture;
}
function historyPane() {
  return view!.container.querySelector<HTMLElement>('#workspace-problem-pane')!;
}
function button(name: string, root: ParentNode = view!.container) {
  const result = [...root.querySelectorAll('button')].find(
    (node) => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === name,
  );
  expect(result, `button ${name}`).toBeDefined();
  return result!;
}
async function click(name: string, root?: ParentNode) {
  await act(async () => button(name, root).click());
}
async function openDetail(id = 101) {
  const row = [...historyPane().querySelectorAll('button')].find((node) =>
    node.textContent?.includes(`#${id}`),
  );
  expect(row, `history row #${id}`).toBeDefined();
  await act(async () => row!.click());
}
async function mount(strict = false) {
  view = await renderReact(element(strict));
  await click('Submissions');
}
async function changeAccount(user: Me | null, strict = false) {
  observed.user = user;
  await view!.rerender(element(strict));
}
function expectNoAccountAHistory() {
  expect(historyPane().textContent).not.toContain('#101');
  expect(historyPane().textContent).not.toContain(privateSourceA);
  expect(historyPane().querySelector('[aria-label="Submission detail"]')).toBeNull();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const domWindow = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
  vi.stubGlobal('localStorage', domWindow.localStorage);
  vi.stubGlobal('sessionStorage', domWindow.sessionStorage);
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('astra-lang', 'CPP');
  localStorage.setItem('astra-draft:1:CPP', draft);
  observed.user = accountA;
  observed.slug = problem.slug;
  observed.editor = null;
  observed.commits = [];
  vi.spyOn(problemApi, 'bySlug').mockImplementation(async (slug) => ({
    ...problem,
    slug,
    id: slug === problem.slug ? 1 : 2,
  }));
  vi.spyOn(submissionApi, 'listMine').mockImplementation(async () =>
    history([detail(observed.user?.id === accountB.id ? 201 : 101)]),
  );
  vi.spyOn(submissionApi, 'get').mockImplementation(async (id) => detail(id));
  vi.spyOn(submissionApi, 'create').mockResolvedValue(detail(103));
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

describe('real workspace submission history account isolation', () => {
  it('removes A history/source before passive effects when switching directly to B', async () => {
    await mount();
    await openDetail();
    expect(historyPane().textContent).toContain(privateSourceA);
    const editor = view!.container.querySelector('textarea');
    const oldRestore = button('Use this code', historyPane());
    const nextHistory = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValue(nextHistory.promise);
    await changeAccount(accountB);
    expect(observed.commits.at(-1)?.history).not.toContain(privateSourceA);
    expect(observed.commits.at(-1)?.history).not.toContain('#101');
    expectNoAccountAHistory();
    expect(view!.container.querySelector('textarea')).toBe(editor);
    expect(observed.editor?.value).toBe(draft);
    await act(async () => oldRestore.click());
    expect(view!.container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => nextHistory.resolve(history([detail(201)])));
    expect(historyPane().textContent).toContain('#201');
    await openDetail(201);
    expect(historyPane().textContent).toContain(privateSourceB);
    expect(historyPane().textContent).not.toContain(privateSourceA);
  });

  it('clears private history and detail on logout without fetching anonymous history', async () => {
    await mount();
    await openDetail();
    await changeAccount(null);
    expectNoAccountAHistory();
    expect(observed.commits.at(-1)?.history).not.toContain(privateSourceA);
    expect(historyPane().textContent).toContain('Sign in to see your submissions');
    expect(submissionApi.listMine).toHaveBeenCalledTimes(1);
    expect(observed.editor?.value).toBe(draft);
  });

  it('loads B independently after A logs out and B logs in', async () => {
    await mount();
    await openDetail();
    await changeAccount(null);
    await changeAccount(accountB);
    expectNoAccountAHistory();
    expect(historyPane().textContent).toContain('#201');
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
  });

  it('preserves loaded detail and selection on a same-ID user object refresh', async () => {
    await mount();
    await openDetail();
    const source = historyPane().querySelector('pre');
    await changeAccount({ ...accountA, full_name: 'Refreshed display name' });
    expect(historyPane().textContent).toContain(privateSourceA);
    expect(historyPane().querySelector('pre')).toBe(source);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(1);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
  });

  it('retains a valid pending history request across a same-ID refresh', async () => {
    const request = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValue(request.promise);
    await mount();
    const signal = vi.mocked(submissionApi.listMine).mock.calls[0][1]!;
    await changeAccount({ ...accountA });
    expect(signal.aborted).toBe(false);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(history()));
    expect(historyPane().textContent).toContain('#101');
  });

  it('retains a valid pending detail request across a same-ID refresh', async () => {
    const request = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValue(request.promise);
    await mount();
    await openDetail();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    await changeAccount({ ...accountA });
    expect(signal.aborted).toBe(false);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(detail()));
    expect(historyPane().textContent).toContain(privateSourceA);
  });

  it('starts fresh collections and selections on repeated A to B to A transitions', async () => {
    await mount();
    await openDetail();
    await changeAccount(accountB);
    expectNoAccountAHistory();
    await openDetail(201);
    expect(historyPane().textContent).toContain(privateSourceB);
    vi.mocked(submissionApi.listMine).mockResolvedValue(history([detail(102)]));
    await changeAccount(accountA);
    expect(historyPane().textContent).toContain('#102');
    expect(historyPane().textContent).not.toContain('#201');
    expect(historyPane().querySelector('[aria-label="Submission detail"]')).toBeNull();
    expect(submissionApi.listMine).toHaveBeenCalledTimes(3);
  });

  it('resets pagination to page one for a different account', async () => {
    vi.mocked(submissionApi.listMine).mockImplementation(async (params) =>
      history([detail(params?.page === 2 ? 102 : 101)], params?.page, 2),
    );
    await mount();
    await click('Next');
    await openDetail(102);
    expect(historyPane().textContent).toContain('Page 2 / 2');
    vi.mocked(submissionApi.listMine).mockResolvedValue(history([detail(201)]));
    await changeAccount(accountB);
    expect(submissionApi.listMine).toHaveBeenLastCalledWith(
      { problem_id: 1, page: 1, limit: 10 },
      expect.any(AbortSignal),
    );
    expect(historyPane().textContent).toContain('Page 1 / 1');
    expect(historyPane().querySelector('[aria-label="Submission detail"]')).toBeNull();
  });
});

describe('history and detail request ownership', () => {
  it('ignores A history success after B starts loading even if transport ignores abort', async () => {
    const previous = deferred<ListSubmissionsResponse>();
    const current = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    await mount();
    const signal = vi.mocked(submissionApi.listMine).mock.calls[0][1]!;
    await changeAccount(accountB);
    expect(signal.aborted).toBe(true);
    await act(async () => previous.resolve(history()));
    expectNoAccountAHistory();
    expect(historyPane().textContent).not.toContain('Page 1');
    await act(async () => current.resolve(history([detail(201)])));
    expect(historyPane().textContent).toContain('#201');
  });

  it('does not let an obsolete history rejection overwrite B history error', async () => {
    const previous = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockReturnValueOnce(previous.promise)
      .mockRejectedValueOnce(new ApiError('B history error', 503, 50300));
    await mount();
    await changeAccount(accountB);
    expect(historyPane().textContent).toContain('B history error');
    await act(async () => previous.reject(new ApiError('A obsolete history error', 500, 50000)));
    expect(historyPane().textContent).toContain('B history error');
    expect(historyPane().textContent).not.toContain('A obsolete history error');
  });

  it('cannot repopulate private history when A history resolves after logout', async () => {
    const previous = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValue(previous.promise);
    await mount();
    await changeAccount(null);
    await act(async () => previous.resolve(history()));
    expectNoAccountAHistory();
    expect(historyPane().textContent).toContain('Sign in to see your submissions');
    expect(submissionApi.get).not.toHaveBeenCalled();
  });

  it('ignores obsolete detail success/finally while B detail is still loading', async () => {
    const previous = deferred<Submission>();
    const current = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    await mount();
    await openDetail();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    await changeAccount(accountB);
    await openDetail(201);
    expect(signal.aborted).toBe(true);
    const pendingMarkup = historyPane().querySelector(
      '[aria-label="Submission detail"]',
    )!.innerHTML;
    await act(async () => previous.resolve(detail(101, { status: 'PENDING' })));
    expect(historyPane().querySelector('[aria-label="Submission detail"]')!.innerHTML).toBe(
      pendingMarkup,
    );
    expect(historyPane().textContent).not.toContain(privateSourceA);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(detail(201)));
    expect(historyPane().textContent).toContain(privateSourceB);
  });

  it('does not let an obsolete detail rejection overwrite B recovery state', async () => {
    const previous = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(previous.promise)
      .mockRejectedValueOnce(new ApiError('B detail error', 503, 50300));
    await mount();
    await openDetail();
    await changeAccount(accountB);
    await openDetail(201);
    await act(async () => previous.reject(new NetworkError()));
    expect(historyPane().querySelector('[role="alert"]')?.textContent).toContain('B detail error');
    expect(historyPane().textContent).not.toContain(privateSourceA);
  });

  it('ignores an obsolete AbortError after B detail succeeds', async () => {
    const previous = deferred<Submission>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(previous.promise);
    await mount();
    await openDetail();
    await changeAccount(accountB);
    await openDetail(201);
    await act(async () => previous.reject(new DOMException('Aborted', 'AbortError')));
    expect(historyPane().textContent).toContain(privateSourceB);
    expect(historyPane().querySelector('[role="alert"]')).toBeNull();
  });

  it('cancels a scheduled pending-detail poll when the account changes', async () => {
    vi.mocked(submissionApi.get).mockResolvedValue(detail(101, { status: 'PENDING' }));
    await mount();
    await openDetail();
    const signal = vi.mocked(submissionApi.get).mock.calls[0][1]!;
    await changeAccount(accountB);
    expect(signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    expectNoAccountAHistory();
  });

  it('ignores an in-flight old poll and does not schedule another after account change', async () => {
    const poll = deferred<Submission>();
    vi.mocked(submissionApi.get)
      .mockResolvedValueOnce(detail(101, { status: 'PENDING' }))
      .mockReturnValueOnce(poll.promise);
    await mount();
    await openDetail();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    await changeAccount(accountB);
    await act(async () => poll.resolve(detail(101, { status: 'PENDING' })));
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    expectNoAccountAHistory();
    expect(historyPane().textContent).toContain('#201');
  });

  it.each(['history', 'detail'] as const)(
    'invalidates pending %s requests on unmount',
    async (kind) => {
      const oldHistory = deferred<ListSubmissionsResponse>();
      const oldDetail = deferred<Submission>();
      if (kind === 'history') vi.mocked(submissionApi.listMine).mockReturnValue(oldHistory.promise);
      else vi.mocked(submissionApi.get).mockReturnValue(oldDetail.promise);
      await mount();
      if (kind === 'detail') await openDetail();
      const signal =
        kind === 'history'
          ? vi.mocked(submissionApi.listMine).mock.calls[0][1]!
          : vi.mocked(submissionApi.get).mock.calls[0][1]!;
      await view!.unmount();
      expect(signal.aborted).toBe(true);
      await act(async () => {
        oldHistory.resolve(history());
        oldDetail.resolve(detail(101, { status: 'PENDING' }));
      });
      expect(view!.container.textContent).toBe('');
      expect(localStorage.getItem('astra-draft:1:CPP')).toBe(draft);
    },
  );

  it('ignores obsolete history effects during StrictMode replay and account switching', async () => {
    const requests: ReturnType<typeof deferred<ListSubmissionsResponse>>[] = [];
    vi.mocked(submissionApi.listMine).mockImplementation(() => {
      const request = deferred<ListSubmissionsResponse>();
      requests.push(request);
      return request.promise;
    });
    await mount(true);
    const oldRequests = [...requests];
    const oldSignals = vi.mocked(submissionApi.listMine).mock.calls.map((call) => call[1]!);
    expect(oldRequests.length).toBeGreaterThanOrEqual(2);
    await changeAccount(accountB, true);
    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => {
      for (const request of oldRequests) request.resolve(history());
      requests.at(-1)!.resolve(history([detail(201)]));
    });
    expectNoAccountAHistory();
    expect(historyPane().textContent).toContain('#201');
    expect(historyPane().textContent?.match(/#201/g)).toHaveLength(1);
  });

  it('ignores history success from the replayed StrictMode effect within the same owner', async () => {
    const requests: ReturnType<typeof deferred<ListSubmissionsResponse>>[] = [];
    vi.mocked(submissionApi.listMine).mockImplementation(() => {
      const request = deferred<ListSubmissionsResponse>();
      requests.push(request);
      return request.promise;
    });
    await mount(true);
    expect(requests).toHaveLength(2);
    expect(vi.mocked(submissionApi.listMine).mock.calls[0][1]!.aborted).toBe(true);
    await act(async () => requests[1].resolve(history([detail(102)])));
    await act(async () => requests[0].resolve(history([detail(101)])));
    expect(historyPane().textContent).toContain('#102');
    expect(historyPane().textContent).not.toContain('#101');
  });

  it('ignores detail success/finally from a replayed StrictMode effect within the same owner', async () => {
    const requests: ReturnType<typeof deferred<Submission>>[] = [];
    vi.mocked(submissionApi.get).mockImplementation(() => {
      const request = deferred<Submission>();
      requests.push(request);
      return request.promise;
    });
    await mount(true);
    await openDetail();
    expect(requests).toHaveLength(2);
    expect(vi.mocked(submissionApi.get).mock.calls[0][1]!.aborted).toBe(true);
    await act(async () => requests[1].resolve(detail(101, { source_code: '// current detail' })));
    await act(async () => requests[0].resolve(detail(101, { status: 'PENDING' })));
    expect(historyPane().textContent).toContain('// current detail');
    expect(historyPane().textContent).not.toContain(privateSourceA);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
  });
});

describe('current-account history/detail behavior', () => {
  it('preserves ordering, pagination and exact existing history queries', async () => {
    vi.mocked(submissionApi.listMine).mockImplementation(async (params) =>
      history(params?.page === 2 ? [detail(103)] : [detail(102), detail(101)], params?.page, 2),
    );
    await mount();
    expect(historyPane().textContent!.indexOf('#102')).toBeLessThan(
      historyPane().textContent!.indexOf('#101'),
    );
    expect(button('Previous').disabled).toBe(true);
    await click('Next');
    expect(historyPane().textContent).toContain('#103');
    expect(historyPane().textContent).toContain('Page 2 / 2');
    expect(button('Next').disabled).toBe(true);
    await click('Previous');
    expect(historyPane().textContent).toContain('#102');
    expect(vi.mocked(submissionApi.listMine).mock.calls.map(([params]) => params)).toEqual([
      { problem_id: 1, page: 1, limit: 10 },
      { problem_id: 1, page: 2, limit: 10 },
      { problem_id: 1, page: 1, limit: 10 },
    ]);
  });

  it('preserves normal source preview, restore confirmation, cancel and restore actions', async () => {
    await mount();
    await openDetail();
    expect(historyPane().textContent).toContain('Accepted');
    expect(historyPane().querySelector('pre')?.textContent).toBe(privateSourceA);
    await click('Use this code', historyPane());
    let dialog = view!.container.querySelector('[aria-label="Replace editor code"]')!;
    expect(dialog.textContent).toContain('submission #101');
    expect(observed.editor?.value).toBe(draft);
    await click('Cancel', dialog);
    expect(observed.editor?.value).toBe(draft);
    await click('Use this code', historyPane());
    dialog = view!.container.querySelector('[aria-label="Replace editor code"]')!;
    await click('Use this code', dialog);
    expect(observed.editor?.value).toBe(privateSourceA);
    expect(view!.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([accountB, null])(
    'invalidates a pending restore confirmation on identity change to $id',
    async (nextAccount) => {
      await mount();
      await openDetail();
      await click('Use this code', historyPane());
      const oldDialog = view!.container.querySelector('[aria-label="Replace editor code"]')!;
      const oldConfirm = button('Use this code', oldDialog);
      await changeAccount(nextAccount);
      expect(observed.commits.at(-1)?.dialog).toBe('');
      expect(view!.container.querySelector('[aria-label="Replace editor code"]')).toBeNull();
      await act(async () => oldConfirm.click());
      expect(observed.editor?.value).toBe(draft);
      await changeAccount(accountA);
      expect(view!.container.querySelector('[aria-label="Replace editor code"]')).toBeNull();
    },
  );

  it('keeps restore confirmation usable on a same-ID refresh', async () => {
    await mount();
    await openDetail();
    await click('Use this code', historyPane());
    await changeAccount({ ...accountA });
    const dialog = view!.container.querySelector('[aria-label="Replace editor code"]')!;
    expect(dialog).not.toBeNull();
    await click('Use this code', dialog);
    expect(observed.editor?.value).toBe(privateSourceA);
  });

  it('refreshes current-account history and clears selection after official completion', async () => {
    TestEventSource.instances = [];
    vi.stubGlobal('EventSource', TestEventSource);
    vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue({
      ticket: 'fixture-ticket',
      expires_at: accountA.updated_at,
    });
    vi.mocked(submissionApi.create).mockResolvedValueOnce({
      id: 103,
      problem_id: 1,
      problem_title: problem.title,
      language: 'CPP',
      status: 'PENDING',
      created_at: accountA.created_at,
    });
    vi.mocked(submissionApi.listMine).mockImplementation(async (params) =>
      history([detail(params?.page === 2 ? 102 : 101)], params?.page, 2),
    );
    await mount();
    await click('Next');
    await openDetail(102);
    vi.mocked(submissionApi.get).mockResolvedValueOnce({
      ...detail(103),
      attempt_id: 'history-attempt',
    });
    await click('Submit');
    await act(async () =>
      TestEventSource.instances[0].emit('submission.completed', {
        submission_id: 103,
        attempt_id: 'history-attempt',
        status: 'ACCEPTED',
        updated_at: accountA.updated_at,
      }),
    );
    expect(historyPane().textContent).toContain('Page 1 / 2');
    expect(historyPane().querySelector('[aria-label="Submission detail"]')).toBeNull();
    expect(submissionApi.create).toHaveBeenCalledExactlyOnceWith({
      problem_id: 1,
      language: 'CPP',
      source_code: draft,
    });
    expect(submissionApi.listMine).toHaveBeenLastCalledWith(
      { problem_id: 1, page: 1, limit: 10 },
      expect.any(AbortSignal),
    );
  });

  it('keeps normal pending-detail polling and stops on terminal detail', async () => {
    vi.mocked(submissionApi.get)
      .mockResolvedValueOnce(detail(101, { status: 'PENDING' }))
      .mockResolvedValueOnce(detail());
    await mount();
    await openDetail();
    expect(historyPane().textContent).toContain('Queued');
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(historyPane().textContent).not.toContain('Queued');
    expect(historyPane().textContent).toContain('Accepted');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    expect(historyPane().textContent).toContain(privateSourceA);
  });

  it('does not apply a previous selection response to the newly selected submission', async () => {
    const previous = deferred<Submission>();
    vi.mocked(submissionApi.listMine).mockResolvedValue(history([detail(101), detail(102)]));
    vi.mocked(submissionApi.get)
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(detail(102, { source_code: '// selected source 102' }));
    await mount();
    await openDetail(101);
    await openDetail(102);
    await act(async () => previous.resolve(detail()));
    expect(historyPane().textContent).toContain('Submission #102');
    expect(historyPane().textContent).toContain('// selected source 102');
    expect(historyPane().textContent).not.toContain(privateSourceA);
  });

  it('keeps history and detail retry/empty states functional for the current account', async () => {
    vi.mocked(submissionApi.listMine)
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(history());
    vi.mocked(submissionApi.get)
      .mockRejectedValueOnce(new ApiError('Current detail error', 503, 50300))
      .mockResolvedValueOnce(detail());
    await mount();
    expect(historyPane().textContent).toContain("Couldn't load your submissions");
    await click('Retry', historyPane());
    await openDetail();
    expect(historyPane().querySelector('[role="alert"]')?.textContent).toContain(
      'Current detail error',
    );
    await click('Retry', historyPane());
    expect(historyPane().textContent).toContain(privateSourceA);
    vi.mocked(submissionApi.listMine).mockResolvedValue(history([]));
    await changeAccount(accountB);
    expect(historyPane().textContent).toContain('No submissions on this problem yet');
  });

  it('resets history/detail on problem changes and ignores a late previous-problem request', async () => {
    const previous = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(history([detail(102, { problem_id: 2 })]));
    await mount();
    const signal = vi.mocked(submissionApi.listMine).mock.calls[0][1]!;
    observed.slug = 'other-problem';
    await view!.rerender(element());
    expect(signal.aborted).toBe(true);
    await act(async () => previous.resolve(history()));
    expect(historyPane().textContent).toContain('#102');
    expect(historyPane().textContent).not.toContain('#101');
    expect(submissionApi.listMine).toHaveBeenLastCalledWith(
      { problem_id: 2, page: 1, limit: 10 },
      expect.any(AbortSignal),
    );
  });
});
