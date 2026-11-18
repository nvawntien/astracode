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
import { ApiError, problemApi, submissionApi } from '../src/lib/api';
import { fetchProgress, invalidateProgress, useProgress } from '../src/lib/progress';
import type {
  ListSubmissionsResponse,
  Me,
  Problem,
  Submission,
  SubmissionDetail,
  SubmissionListItem,
} from '../src/lib/types';
import { TestEventSource } from './helpers/event-source';
import { deferred, renderReact } from './helpers/react-dom';

// Progress utilities, Workspace, ProblemPanel and submission/SSE hooks stay real.
const observed = vi.hoisted(() => ({
  user: null as Me | null,
  slug: 'progress-problem',
  progressStatus: 'ACCEPTED' as SubmissionListItem['status'],
  push: vi.fn(),
  toast: vi.fn(),
  editor: null as ComponentProps<typeof CodeEditor> | null,
  commits: [] as string[],
  reload: null as (() => void) | null,
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
    return createElement('textarea', { value: props.value, readOnly: true });
  },
}));

const accountA: Me = {
  id: 'progress-account-a',
  username: 'progress-a',
  full_name: 'Progress A',
  email: 'a@example.test',
  role: 'user',
  rating: 0,
  is_active: true,
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
};
const accountB = { ...accountA, id: 'progress-account-b', username: 'progress-b' };
const problem: Problem = {
  id: 1,
  slug: 'progress-problem',
  title: 'Progress problem',
  description: 'Public statement',
  input_format: '',
  output_format: '',
  difficulty: 'easy',
  time_limit: 1,
  memory_limit: 128,
  created_at: accountA.created_at,
  examples: [{ input: '1', expected_output: '2' }],
};

function detail(status: Submission['status'] = 'ACCEPTED'): Submission {
  return {
    id: 41,
    problem_id: 1,
    problem_title: problem.title,
    user_id: accountA.id,
    username: accountA.username,
    language: 'CPP',
    source_code: '// draft\n',
    status,
    execution_time_ms: 1,
    memory_used_kb: 1024,
    passed_testcases: 1,
    total_testcases: 1,
    compile_output: null,
    error_message: null,
    created_at: accountA.created_at,
    updated_at: accountA.updated_at,
  };
}
const currentDetail: SubmissionDetail = { ...detail(), attempt_id: 'progress-attempt' };
function history(items: SubmissionListItem[] = []): ListSubmissionsResponse {
  return { items, pagination: { page: 1, limit: 100, total: items.length, total_pages: 1 } };
}
const request = (accountId: string) => fetchProgress(accountId);
const invalidate = (accountId: string) => invalidateProgress(accountId);
let view: Awaited<ReturnType<typeof renderReact>> | undefined;

function status() {
  return (
    document.querySelector('#workspace-problem-pane [role="img"]')?.getAttribute('aria-label') ?? ''
  );
}
function Fixture() {
  useLayoutEffect(() => {
    observed.commits.push(status());
  });
  return createElement(WorkspacePage);
}
function CatalogProgress() {
  const { progress, loading, reload } = useProgress(observed.user?.id ?? null);
  observed.reload = reload;
  return createElement(
    'output',
    null,
    `${loading ? 'loading' : 'ready'}:${[...progress.solvedIds].join(',')}`,
  );
}
function element(strict = false, catalog = false) {
  const child = createElement(catalog ? CatalogProgress : Fixture);
  return strict ? createElement(StrictMode, null, child) : child;
}
async function mount(strict = false, catalog = false) {
  view = await renderReact(element(strict, catalog));
}
async function account(user: Me | null, strict = false, catalog = false) {
  observed.user = user;
  await view!.rerender(element(strict, catalog));
}
async function click(label: string) {
  const button = [...view!.container.querySelectorAll('button')].find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
function progressCalls() {
  return vi.mocked(submissionApi.listMine).mock.calls.filter(([params]) => params?.limit === 100);
}
function terminal() {
  TestEventSource.instances.at(-1)!.emit('submission.completed', {
    submission_id: 41,
    attempt_id: 'progress-attempt',
    status: 'ACCEPTED',
    updated_at: accountA.updated_at,
  });
}

beforeEach(async () => {
  invalidate(accountA.id);
  invalidate(accountB.id);
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
  localStorage.setItem('astra-draft:1:CPP', '// draft\n');
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
  observed.user = accountA;
  observed.slug = problem.slug;
  observed.progressStatus = 'ACCEPTED';
  observed.commits = [];
  observed.editor = null;
  vi.spyOn(problemApi, 'bySlug').mockImplementation(async (slug) => ({
    ...problem,
    slug,
    id: slug === problem.slug ? 1 : 2,
  }));
  vi.spyOn(submissionApi, 'listMine').mockImplementation(async ({ limit } = {}) =>
    history(
      limit === 100 && observed.user?.id === accountA.id ? [detail(observed.progressStatus)] : [],
    ),
  );
  vi.spyOn(submissionApi, 'create').mockResolvedValue(detail('PENDING'));
  vi.spyOn(submissionApi, 'get').mockResolvedValue(currentDetail);
  vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue({
    ticket: 'fixture-ticket',
    expires_at: accountA.updated_at,
  });
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(async () => {
  try {
    await view?.unmount();
    invalidate(accountA.id);
    invalidate(accountB.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('real Workspace progress ownership', () => {
  it.each(['ACCEPTED', 'WRONG_ANSWER'] as const)(
    'never flashes A %s flags in B committed workspace',
    async (initialStatus) => {
      observed.progressStatus = initialStatus;
      await mount();
      expect(status()).toBe(initialStatus === 'ACCEPTED' ? 'Solved' : 'Attempted');
      const editor = view!.container.querySelector('textarea');
      const pendingB = deferred<ListSubmissionsResponse>();
      vi.mocked(submissionApi.listMine).mockReturnValue(pendingB.promise);
      await account(accountB);
      expect(observed.commits.at(-1)).toBe('Not attempted');
      expect(status()).toBe('Not attempted');
      expect(view!.container.querySelector('textarea')).toBe(editor);
      expect(observed.editor?.value).toBe('// draft\n');
      await act(async () => pendingB.resolve(history()));
      expect(status()).toBe('Not attempted');
      expect(progressCalls()).toHaveLength(2);
    },
  );

  it('clears displayed progress on logout and independently loads B after login', async () => {
    await mount();
    expect(status()).toBe('Solved');
    await account(null);
    expect(observed.commits.at(-1)).toBe('Not attempted');
    expect(status()).toBe('Not attempted');
    expect(progressCalls()).toHaveLength(1);
    await account(accountB);
    expect(status()).toBe('Not attempted');
    expect(progressCalls()).toHaveLength(2);
  });

  it('preserves progress and cache on same-ID object refreshes and unrelated rerenders', async () => {
    await mount();
    const cached = request(accountA.id);
    await account({ ...accountA, full_name: 'Refreshed name' });
    expect(observed.commits.at(-1)).toBe('Solved');
    expect(request(accountA.id)).toBe(cached);
    await click('Collapse panel');
    expect(progressCalls()).toHaveLength(1);
  });

  it('preserves a pending progress request through a same-ID refresh', async () => {
    const pending = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValue(pending.promise);
    await mount();
    const signal = progressCalls()[0][1]!;
    await account({ ...accountA });
    expect(signal.aborted).toBe(false);
    expect(progressCalls()).toHaveLength(1);
    await act(async () => pending.resolve(history([detail()])));
    expect(status()).toBe('Solved');
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores obsolete A progress %s after B finishes',
    async (outcome) => {
      const previous = deferred<ListSubmissionsResponse>();
      vi.mocked(submissionApi.listMine)
        .mockReturnValueOnce(previous.promise)
        .mockResolvedValue(history());
      await mount();
      await account(accountB);
      expect(progressCalls()).toHaveLength(2);
      const current = request(accountB.id);
      await act(async () => {
        if (outcome === 'resolve') previous.resolve(history([detail()]));
        else previous.reject(new ApiError('obsolete A progress failure', 503, 50300));
      });
      expect(status()).toBe('Not attempted');
      expect(request(accountB.id)).toBe(current);
    },
  );

  it('does not restore late progress after logout or unmount', async () => {
    const pending = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValue(pending.promise);
    await mount();
    await account(null);
    await act(async () => pending.resolve(history([detail()])));
    expect(status()).toBe('Not attempted');
    await view!.unmount();
    expect(view!.container.textContent).toBe('');
  });

  it('ignores a pending progress response after the workspace unmounts', async () => {
    const pending = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValue(pending.promise);
    await mount();
    await view!.unmount();
    await act(async () => pending.resolve(history([detail()])));
    expect(view!.container.textContent).toBe('');
    expect(observed.toast).not.toHaveBeenCalled();
  });

  it('shows the new problem flags without a stale previous-problem response', async () => {
    const pending = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValue(pending.promise);
    await mount();
    observed.slug = 'other-progress-problem';
    await view!.rerender(element());
    await act(async () => pending.resolve(history([detail()])));
    expect(status()).toBe('Not attempted');
    expect(progressCalls()).toHaveLength(1);
  });

  it('restores independent progress on A to B to A transitions', async () => {
    await mount();
    await account(accountB);
    expect(status()).toBe('Not attempted');
    await account(accountA);
    expect(status()).toBe('Solved');
    expect(progressCalls()).toHaveLength(3);
  });

  it('deduplicates StrictMode loading while preserving account isolation', async () => {
    await mount(true);
    expect(status()).toBe('Solved');
    expect(progressCalls()).toHaveLength(1);
    await account(accountB, true);
    expect(observed.commits.at(-1)).toBe('Not attempted');
    expect(status()).toBe('Not attempted');
    expect(progressCalls()).toHaveLength(2);
  });
});

describe('real shared useProgress consumer used by the catalog', () => {
  it('gates displayed progress on identity and clears it on logout', async () => {
    await mount(false, true);
    expect(view!.container.textContent).toBe('ready:1');
    await account(accountB, false, true);
    expect(view!.container.textContent).toBe('ready:');
    await account(null, false, true);
    expect(view!.container.textContent).toBe('ready:');
  });

  it('retains valid same-ID progress and supports scoped reload', async () => {
    await mount(false, true);
    await account({ ...accountA }, false, true);
    expect(progressCalls()).toHaveLength(1);
    vi.mocked(submissionApi.listMine).mockResolvedValue(history());
    await act(async () => observed.reload!());
    expect(view!.container.textContent).toBe('ready:');
    expect(progressCalls()).toHaveLength(2);
  });

  it('ignores a reload callback captured by a previous account', async () => {
    await mount(false, true);
    const oldReload = observed.reload!;
    await account(accountB, false, true);
    const current = request(accountB.id);
    await act(async () => oldReload());
    expect(request(accountB.id)).toBe(current);
    expect(progressCalls()).toHaveLength(2);
    expect(view!.container.textContent).toBe('ready:');
  });

  it('ignores stale rejection/finally while B remains loading and retries after failure', async () => {
    const a = deferred<ListSubmissionsResponse>();
    const b = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await mount(false, true);
    await account(accountB, false, true);
    expect(progressCalls()).toHaveLength(2);
    await act(async () => a.reject(new Error('obsolete A error')));
    expect(view!.container.textContent).toBe('loading:');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => b.reject(new Error('current B error')));
    expect(view!.container.textContent).toBe('ready:');
    expect(warning).toHaveBeenCalledTimes(1);
    vi.mocked(submissionApi.listMine).mockResolvedValue(history());
    await act(async () => observed.reload!());
    expect(view!.container.textContent).toBe('ready:');
    expect(progressCalls()).toHaveLength(3);
  });
});

describe('submission completion with the real progress cache', () => {
  it('keeps completion refresh authoritative over a late initial progress response', async () => {
    const previous = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine).mockReturnValueOnce(previous.promise);
    await mount();
    await click('Submit');
    await act(async () => terminal());
    expect(status()).toBe('Solved');
    await act(async () => previous.resolve(history([detail('WRONG_ANSWER')])));
    expect(status()).toBe('Solved');
    expect(progressCalls()).toHaveLength(2);
    expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Accepted', 'success');
  });

  it.each(['manual first', 'terminal first'])(
    'refreshes current progress once: %s',
    async (order) => {
      observed.progressStatus = 'WRONG_ANSWER';
      await mount();
      expect(status()).toBe('Attempted');
      await click('Submissions');
      const oldCache = request(accountA.id);
      await click('Submit');
      const terminalDetail = deferred<Submission>();
      const manualDetail = deferred<Submission>();
      vi.mocked(submissionApi.get)
        .mockReturnValueOnce(manualDetail.promise)
        .mockReturnValueOnce(terminalDetail.promise);
      await act(async () =>
        TestEventSource.instances.at(-1)!.raw('submission.updated', '{invalid'),
      );
      await click('Check result');
      await click('Reconnect');
      await act(async () => {
        terminal();
        terminal();
      });
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      observed.progressStatus = 'ACCEPTED';
      await act(async () => {
        (order === 'manual first' ? manualDetail : terminalDetail).resolve(currentDetail);
      });
      await act(async () => {
        (order === 'manual first' ? terminalDetail : manualDetail).resolve(currentDetail);
      });
      expect(request(accountA.id)).not.toBe(oldCache);
      expect(progressCalls()).toHaveLength(2);
      expect(
        vi.mocked(submissionApi.listMine).mock.calls.filter(([params]) => params?.limit === 10),
      ).toHaveLength(2);
      expect(observed.toast).toHaveBeenCalledExactlyOnceWith('Accepted', 'success');
      await click('Description');
      expect(status()).toBe('Solved');
    },
  );

  it('does not let obsolete A completion invalidate or refresh B progress', async () => {
    const terminalDetail = deferred<Submission>();
    await mount();
    await click('Submit');
    vi.mocked(submissionApi.get).mockReturnValue(terminalDetail.promise);
    await act(async () => terminal());
    await account(accountB);
    expect(progressCalls()).toHaveLength(2);
    const b = request(accountB.id);
    await act(async () => terminalDetail.resolve(currentDetail));
    expect(request(accountB.id)).toBe(b);
    expect(status()).toBe('Not attempted');
    expect(progressCalls()).toHaveLength(2);
    expect(observed.toast).not.toHaveBeenCalledWith('Accepted', 'success');
  });
});
