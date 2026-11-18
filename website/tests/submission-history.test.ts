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
import { CODE_TEMPLATES, draftKey } from '../src/lib/templates';
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
  authLoading: false,
  realEditor: false,
  onCommit: null as (() => void) | null,
  push: vi.fn(),
  toast: vi.fn(),
  editor: null as ComponentProps<typeof CodeEditor> | null,
  commits: [] as {
    accountId: string | null;
    history: string;
    dialog: string;
    source: string;
    overlay: string;
  }[],
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
  useAuth: () => ({ user: observed.user, loading: observed.authLoading }),
}));
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ showToast: observed.toast }) }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/CodeEditor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/CodeEditor')>();
  return {
    CodeEditor: (props: ComponentProps<typeof CodeEditor>) => {
      observed.editor = props;
      if (observed.realEditor) return createElement(actual.CodeEditor, props);
      return createElement('textarea', {
        'aria-label': 'History fixture editor',
        value: props.value,
        readOnly: true,
      });
    },
  };
});
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
      source: document.querySelector<HTMLTextAreaElement>('.ac-code-editor-input')?.value ?? '',
      overlay: document.querySelector('[data-code-editor-scroll]')?.textContent ?? '',
      history: document.querySelector('#workspace-problem-pane')?.textContent ?? '',
      dialog: document.querySelector('[aria-label="Replace editor code"]')?.textContent ?? '',
    });
    observed.onCommit?.();
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
  localStorage.setItem(draftKey(accountA.id, 1, 'CPP'), draft);
  observed.user = accountA;
  observed.realEditor = false;
  observed.onCommit = null;
  observed.authLoading = false;
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
    expect(view!.container.querySelector('textarea')).not.toBe(editor);
    expect(observed.editor?.value).toBe(CODE_TEMPLATES.CPP);
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
    expect(observed.editor?.value).toBe(CODE_TEMPLATES.CPP);
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
      expect(localStorage.getItem(draftKey(accountA.id, 1, 'CPP'))).toBe(draft);
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
      expect(observed.editor?.value).toBe(CODE_TEMPLATES.CPP);
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
    expect(submissionApi.create).toHaveBeenCalledExactlyOnceWith(
      {
        problem_id: 1,
        language: 'CPP',
        source_code: draft,
      },
      expect.any(Function),
    );
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

describe('editor source privacy in the real Workspace and CodeEditor', () => {
  const typed = '// typed only by account A';
  const bDraft = '// account B scoped code';
  const legacyKey = 'astra-draft:1:CPP';
  const ownerKey = (account: Me) => draftKey(account.id, 1, 'CPP');
  const runResult = {
    status: 'completed' as const,
    compile_output: '',
    diagnostics: [],
    tests: [],
  };

  function editorInput() {
    const input = view!.container.querySelector<HTMLTextAreaElement>('.ac-code-editor-input');
    expect(input).not.toBeNull();
    return input!;
  }

  function enterCode(code: string) {
    const input = editorInput();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, code);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function expectNoEditorSource(source: string) {
    expect(editorInput().value).not.toContain(source);
    expect(view!.container.querySelector('[data-code-editor-scroll]')?.textContent).not.toContain(
      source.trim(),
    );
    expect(observed.commits.length).toBeGreaterThan(0);
    expect(observed.commits.every((commit) => !commit.source.includes(source))).toBe(true);
    expect(observed.commits.every((commit) => !commit.overlay.includes(source.trim()))).toBe(true);
  }

  async function restoreCurrentSource(id: number) {
    await openDetail(id);
    await click('Use this code', historyPane());
    const dialog = view!.container.querySelector('[aria-label="Replace editor code"]')!;
    expect(dialog).not.toBeNull();
    await click('Use this code', dialog);
  }

  beforeEach(() => {
    localStorage.setItem(legacyKey, draft);
    observed.realEditor = true;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.spyOn(submissionApi, 'run').mockResolvedValue(runResult);
  });

  it.each(['direct', 'logout'] as const)(
    'keeps restored source and the committed textarea isolated on a %s switch and B remount',
    async (mode) => {
      localStorage.setItem(ownerKey(accountB), bDraft);
      await mount(true);
      await restoreCurrentSource(101);
      expect(editorInput().value).toBe(privateSourceA);
      await act(async () => vi.advanceTimersByTimeAsync(600));
      const aInput = editorInput();
      observed.commits.length = 0;

      if (mode === 'logout') {
        await changeAccount(null, true);
        expectNoEditorSource(privateSourceA);
        expect(editorInput().value).toBe(CODE_TEMPLATES.CPP);
      }
      await changeAccount(accountB, true);
      expectNoEditorSource(privateSourceA);
      expect(editorInput().value).toBe(bDraft);
      expect(editorInput()).not.toBe(aInput);
      expect(localStorage.getItem(ownerKey(accountA))).toBe(privateSourceA);
      expect(localStorage.getItem(legacyKey)).toBe(draft);

      await view!.unmount();
      await mount(true);
      expectNoEditorSource(privateSourceA);
      expect(editorInput().value).toBe(bDraft);
      await changeAccount(accountA, true);
      expect(editorInput().value).toBe(privateSourceA);
    },
  );

  it('keeps typed code private in the first B commit and in both Run and Submit payloads', async () => {
    localStorage.setItem(ownerKey(accountB), bDraft);
    TestEventSource.instances = [];
    vi.stubGlobal('EventSource', TestEventSource);
    vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue({
      ticket: 'fixture-ticket',
      expires_at: accountA.updated_at,
    });

    await mount();
    await act(async () => enterCode(typed));
    // jsdom queues a zero-delay storage event one fake tick after the 600 ms write.
    await act(async () => vi.advanceTimersByTimeAsync(601));
    const aInput = editorInput();
    await changeAccount({ ...accountA });
    expect(editorInput()).toBe(aInput);
    expect(editorInput().value).toBe(typed);
    await click('Run');
    await click('Submit');

    observed.commits.length = 0;
    const transitionHotkeys = vi.fn(() => {
      observed.onCommit = null;
      for (const shiftKey of [false, true]) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey }),
        );
      }
    });
    observed.onCommit = transitionHotkeys;
    await changeAccount(accountB);
    expect(transitionHotkeys).toHaveBeenCalledTimes(1);
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    expect(submissionApi.create).toHaveBeenCalledTimes(1);
    expectNoEditorSource(typed);
    await click('Run');
    await click('Submit');
    const runSources = vi.mocked(submissionApi.run).mock.calls.map(([body]) => body.source_code);
    const submitSources = vi
      .mocked(submissionApi.create)
      .mock.calls.map(([body]) => body.source_code);
    expect({ runSources, submitSources }).toEqual({
      runSources: [typed, bDraft],
      submitSources: [typed, bDraft],
    });
  });

  it.each([
    { transition: 'A to B', action: 'Submit', nextOwner: accountB, postCount: 1 },
    { transition: 'same-ID refresh', action: 'Submit', nextOwner: { ...accountA }, postCount: 2 },
    { transition: 'A to B', action: 'Run', nextOwner: accountB, postCount: 1 },
  ])(
    'guards $action replay of the source after a 401 refresh in flight and $transition',
    async ({ action, nextOwner, postCount }) => {
      const refresh = deferred<Response>();
      const postedSources: string[] = [];
      const fetchStub = vi.fn(async (input: string, options: RequestInit) => {
        if (input.endsWith('/auth/refresh-token')) return refresh.promise;
        expect(input.endsWith(action === 'Submit' ? '/submissions' : '/submissions/run')).toBe(
          true,
        );
        postedSources.push(JSON.parse(String(options.body)).source_code);
        return postedSources.length === 1
          ? new Response('', { status: 401 })
          : Response.json({ data: action === 'Submit' ? detail(101) : runResult });
      });
      vi.mocked(action === 'Submit' ? submissionApi.create : submissionApi.run).mockRestore();
      vi.stubGlobal('fetch', fetchStub);
      await mount();
      await act(async () => enterCode(typed));
      await click(action);
      expect(fetchStub).toHaveBeenCalledTimes(2);
      await changeAccount(nextOwner);
      await act(async () => refresh.resolve(new Response('', { status: 200 })));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(postedSources).toEqual(Array(postCount).fill(typed));
    },
  );

  it('does not cross-write a pending autosave and restores B own private code normally', async () => {
    localStorage.removeItem(ownerKey(accountA));
    await mount(true);
    await act(async () => {
      enterCode('// edit in same batch');
      enterCode(typed);
    });
    await act(async () => vi.advanceTimersByTimeAsync(599));
    await changeAccount(accountB, true);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(editorInput().value).toBe(CODE_TEMPLATES.CPP);
    expect(localStorage.getItem(ownerKey(accountB))).toBeNull();
    expect(localStorage.getItem(ownerKey(accountA))).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBe(draft);

    await restoreCurrentSource(201);
    expect(editorInput().value).toBe(privateSourceB);
    expect(localStorage.getItem(ownerKey(accountB))).toBe(privateSourceB);
    expect(localStorage.getItem(ownerKey(accountA))).toBeNull();
  });

  it.each([accountA, null])(
    'does not load legacy or editable guest source during auth hydration',
    async (nextUser) => {
      observed.user = null;
      observed.authLoading = true;
      const aDraft = '// persisted A source';
      localStorage.setItem(ownerKey(accountA), aDraft);
      await mount();
      expect(editorInput().readOnly).toBe(true);
      expect(editorInput().value).toBe(CODE_TEMPLATES.CPP);
      await act(async () => vi.advanceTimersByTimeAsync(600));
      expect(localStorage.getItem(legacyKey)).toBe(draft);

      observed.authLoading = false;
      await changeAccount(nextUser);
      expect(editorInput().readOnly).toBe(false);
      expect(editorInput().value).toBe(nextUser ? aDraft : CODE_TEMPLATES.CPP);
      if (!nextUser) {
        await act(async () => enterCode('// anonymous code'));
        expect(editorInput().value).toBe('// anonymous code');
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        await changeAccount(accountA);
        expect(editorInput().value).toBe(aDraft);
        await changeAccount(null);
        expect(editorInput().value).toBe(CODE_TEMPLATES.CPP);
      }
      expect(localStorage.getItem(legacyKey)).toBe(draft);
    },
  );
});
