// @vitest-environment jsdom

import { act, createElement, StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StandalonePage from '../src/app/submissions/[id]/page';
import SubmissionsPage from '../src/app/submissions/page';
import { ApiError, NetworkError, submissionApi } from '../src/lib/api';
import type { ListSubmissionsResponse, Me, SubmissionDetail } from '../src/lib/types';
import { deferred, renderReact } from './helpers/react-dom';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), id: '41' }));
const auth = vi.hoisted(() => ({ user: null as Me | null, loading: false }));
vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  useParams: () => ({ id: navigation.id }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement('a', { ...props, href }, children),
}));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('@/components/Header', () => ({ Header: () => null }));

const a: Me = {
  id: 'account-a',
  username: 'account-a',
  full_name: 'Fixture A',
  email: 'a@example.test',
  rating: 0,
  role: 'user',
  is_active: true,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};
const b: Me = { ...a, id: 'account-b', username: 'account-b', email: 'b@example.test' };
const notFound = new ApiError('not found', 404, 40400);
const privateTitle = 'A private submission fixture';
const privateSource = '// synthetic private source A';
const bSource = '// authorized current owner source';
const aDetail: SubmissionDetail = {
  id: 41,
  attempt_id: 'fixture-attempt',
  problem_id: 1,
  problem_title: privateTitle,
  user_id: a.id,
  username: a.username,
  language: 'CPP',
  status: 'WRONG_ANSWER',
  source_code: privateSource,
  execution_time_ms: 10,
  memory_used_kb: 200,
  passed_testcases: 1,
  total_testcases: 2,
  compile_output: null,
  error_message: null,
  created_at: a.created_at,
  updated_at: a.updated_at,
};
const bDetail: SubmissionDetail = {
  ...aDetail,
  id: 52,
  problem_title: 'B authorized submission fixture',
  user_id: b.id,
  username: b.username,
  status: 'ACCEPTED',
  source_code: bSource,
};
function list(
  row: SubmissionDetail | null = aDetail,
  page = 1,
  totalPages = 1,
): ListSubmissionsResponse {
  if (!row) return { items: [], pagination: { page, limit: 20, total: 0, total_pages: 0 } };
  return {
    items: [
      {
        id: row.id,
        problem_id: row.problem_id,
        problem_title: row.problem_title,
        language: row.language,
        status: row.status,
        execution_time_ms: row.execution_time_ms,
        memory_used_kb: row.memory_used_kb,
        passed_testcases: row.passed_testcases,
        total_testcases: row.total_testcases,
        created_at: row.created_at,
      },
    ],
    pagination: { page, limit: 20, total: totalPages * 20, total_pages: totalPages },
  };
}

let view: Awaited<ReturnType<typeof renderReact>> | undefined;
let commits: { owner: string | null; html: string }[];
type Route = 'detail' | 'list';

function ObserveCommit({ route }: { route: Route }) {
  // An ancestor layout effect observes the DOM that committed before passive
  // effects. Check HTML as well as visible text so hidden source also fails.
  useLayoutEffect(() => {
    commits.push({ owner: auth.user?.id ?? null, html: document.body.innerHTML });
  });
  return createElement(route === 'detail' ? StandalonePage : SubmissionsPage);
}

function element(route: Route, strict = false) {
  const observer = createElement(ObserveCommit, { route });
  return strict ? createElement(StrictMode, null, observer) : observer;
}
async function mount(route: Route, strict = false) {
  view = await renderReact(element(route, strict));
}
async function switchAccount(route: Route, user: Me | null, strict = false) {
  auth.user = user;
  await view!.rerender(element(route, strict));
}
function text() {
  return view!.container.textContent ?? '';
}
function expectAbsentInCommits(owner: Me | null, ...sentinels: string[]) {
  const seen = commits.filter((commit) => commit.owner === (owner?.id ?? null));
  expect(seen.length).toBeGreaterThan(0);
  for (const { html } of seen) {
    for (const sentinel of sentinels) expect(html).not.toContain(sentinel);
  }
}
function button(name: string) {
  const found = [...view!.container.querySelectorAll('button')].find(
    (node) => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === name,
  );
  expect(found, `button ${name}`).toBeDefined();
  return found!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function filter(label: string, value: string) {
  const select = view!.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function activeSignal(mock: typeof submissionApi.get | typeof submissionApi.listMine) {
  return vi.mocked(mock).mock.lastCall?.[1] as AbortSignal;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });
  navigation.id = '41';
  navigation.replace.mockReset();
  auth.user = a;
  auth.loading = false;
  commits = [];
  vi.spyOn(submissionApi, 'get').mockResolvedValue(aDetail);
  vi.spyOn(submissionApi, 'listMine').mockResolvedValue(list());
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

describe('standalone submission privacy', () => {
  it('removes A source and metadata at the first B commit and reauthorizes the same URL', async () => {
    vi.mocked(submissionApi.get).mockImplementation(async () => {
      if (auth.user?.id === a.id) return aDetail;
      throw notFound;
    });
    await mount('detail');
    expect(view!.container.querySelector('pre')?.textContent).toBe(privateSource);
    expect(text()).toContain('Wrong Answer');
    const oldSignal = activeSignal(submissionApi.get);
    await switchAccount('detail', b);

    expectAbsentInCommits(b, privateSource, encodeURIComponent(privateTitle), 'Wrong Answer');
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    expect(submissionApi.get).toHaveBeenLastCalledWith(41, expect.any(AbortSignal));
    expect(oldSignal.aborted).toBe(true);
    expect(text()).toContain('Submission #41 was not found or is not available to this account.');
    expect(view!.container.querySelector('pre')).toBeNull();
  });

  it.each(['success', 'error'] as const)(
    'ignores late A detail %s when B is allowed to see the same submission',
    async (outcome) => {
      const obsolete = deferred<SubmissionDetail>();
      const current = deferred<SubmissionDetail>();
      vi.mocked(submissionApi.get)
        .mockReturnValueOnce(obsolete.promise)
        .mockReturnValueOnce(current.promise);
      await mount('detail');
      const oldSignal = activeSignal(submissionApi.get);
      const moderator = { ...b, role: 'moderator' as const };
      await switchAccount('detail', moderator);
      expect(oldSignal.aborted).toBe(true);
      expect(submissionApi.get).toHaveBeenCalledTimes(2);
      await act(async () => current.resolve({ ...aDetail, source_code: bSource }));
      await act(async () => {
        if (outcome === 'success') obsolete.resolve(aDetail);
        else obsolete.reject(new ApiError('obsolete private A error', 403, 40300));
      });
      expect(view!.container.querySelector('pre')?.textContent).toBe(bSource);
      expect(text()).not.toContain('obsolete private A error');
      expect(
        view!.container.querySelector('a[href^="/problems?search="]')?.getAttribute('href'),
      ).toContain(encodeURIComponent(privateTitle));
    },
  );

  it('clears protected UI on logout and scopes login and A return independently', async () => {
    vi.mocked(submissionApi.get)
      .mockResolvedValueOnce(aDetail)
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce(aDetail);
    await mount('detail');
    await switchAccount('detail', null);
    expect(text()).toBe('');
    expectAbsentInCommits(null, privateSource, 'Wrong Answer');
    expect(navigation.replace).toHaveBeenCalledWith('/login?next=%2Fsubmissions%2F41');
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    await switchAccount('detail', b);
    expectAbsentInCommits(b, privateSource);
    expect(text()).toContain('was not found');
    await switchAccount('detail', a);
    expect(view!.container.querySelector('pre')?.textContent).toBe(privateSource);
    expect(submissionApi.get).toHaveBeenCalledTimes(3);
  });

  it('preserves a pending detail and its loaded node through a same-ID user refresh', async () => {
    const current = deferred<SubmissionDetail>();
    vi.mocked(submissionApi.get).mockReturnValueOnce(current.promise);
    await mount('detail');
    const signal = activeSignal(submissionApi.get);
    await switchAccount('detail', { ...a, full_name: 'Refreshed display name' });
    expect(signal.aborted).toBe(false);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    await act(async () => current.resolve(aDetail));
    const source = view!.container.querySelector('pre');
    await switchAccount('detail', { ...a });
    expect(text()).toContain(privateSource);
    expect(view!.container.querySelector('pre')).toBe(source);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
  });

  it('discards the old detail on direct route-ID change and keeps the new direct link request', async () => {
    const next = deferred<SubmissionDetail>();
    vi.mocked(submissionApi.get).mockResolvedValueOnce(aDetail).mockReturnValueOnce(next.promise);
    await mount('detail');
    commits.length = 0;
    navigation.id = '52';
    await view!.rerender(element('detail'));
    expectAbsentInCommits(a, privateSource, encodeURIComponent(privateTitle));
    expect(submissionApi.get).toHaveBeenLastCalledWith(52, expect.any(AbortSignal));
    expect(view!.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => next.resolve(bDetail));
    expect(text()).toContain(bSource);
  });

  it('reauthorizes on a same-ID Moderator to User role change', async () => {
    const privileged = { ...b, role: 'moderator' as const };
    auth.user = privileged;
    vi.mocked(submissionApi.get).mockResolvedValueOnce(aDetail).mockRejectedValueOnce(notFound);
    await mount('detail');
    expect(text()).toContain(privateSource);
    commits.length = 0;
    await switchAccount('detail', b);
    expectAbsentInCommits(b, privateSource);
    expect(text()).toContain('was not found');
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
  });

  it('waits for auth hydration, then keeps existing network error and retry behavior', async () => {
    auth.loading = true;
    vi.mocked(submissionApi.get)
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(aDetail);
    await mount('detail');
    expect(text()).toBe('');
    expect(submissionApi.get).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
    auth.loading = false;
    await switchAccount('detail', a);
    expect(text()).toContain('Check your connection and try again.');
    await click('Retry');
    expect(text()).toContain(privateSource);
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
  });

  it('removes a private error from the previous owner before starting B authorization', async () => {
    const current = deferred<SubmissionDetail>();
    vi.mocked(submissionApi.get)
      .mockRejectedValueOnce(new ApiError('private A error data', 403, 40300))
      .mockReturnValueOnce(current.promise);
    await mount('detail');
    expect(text()).toContain('private A error data');
    await switchAccount('detail', b);
    expectAbsentInCommits(b, 'private A error data');
    expect(text()).not.toContain('private A error data');
    expect(view!.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => current.reject(notFound));
    expect(text()).toContain('was not found');
    expect(text()).not.toContain('private A error data');
  });

  it('preserves a current-owner forbidden response without source', async () => {
    vi.mocked(submissionApi.get).mockRejectedValueOnce(
      new ApiError('This request is forbidden', 403, 40300),
    );
    await mount('detail');
    expect(text()).toContain('This request is forbidden');
    expect(view!.container.querySelector('pre')).toBeNull();
  });
});

describe('global submission list and inline detail privacy', () => {
  it('removes loaded A rows and expanded source at the first B commit and starts a clean query', async () => {
    const next = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockResolvedValueOnce(list(aDetail, 1, 7))
      .mockResolvedValueOnce(list(aDetail, 1, 7))
      .mockResolvedValueOnce(list(aDetail, 2, 7))
      .mockReturnValueOnce(next.promise);
    await mount('list');
    await filter('Filter by status', 'WRONG_ANSWER');
    await click('Next →');
    await click('Preview submission 41');
    expect(text()).toContain(privateTitle);
    expect(text()).toContain(privateSource);
    expect(text()).toContain('Page 2 of 7');
    await switchAccount('list', b);
    expectAbsentInCommits(b, privateTitle, privateSource, 'Page 2 of 7', 'Hide submission 41');
    expect(submissionApi.listMine).toHaveBeenLastCalledWith(
      { page: 1, limit: 20, status: '', language: '' },
      expect.any(AbortSignal),
    );
    expect(view!.container.querySelector('pre')).toBeNull();
    await act(async () => next.resolve(list(bDetail)));
    expect(text()).toContain(bDetail.problem_title);
    expect(button('Preview submission 52').getAttribute('aria-expanded')).toBe('false');
    vi.mocked(submissionApi.get).mockResolvedValueOnce(bDetail);
    await click('Preview submission 52');
    expect(view!.container.querySelector('pre')?.textContent).toBe(bSource);
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
  });

  it.each(['while B is loading', 'after B resolves'] as const)(
    'ignores an obsolete A list success %s',
    async (order) => {
      const obsolete = deferred<ListSubmissionsResponse>();
      const current = deferred<ListSubmissionsResponse>();
      vi.mocked(submissionApi.listMine)
        .mockReturnValueOnce(obsolete.promise)
        .mockReturnValueOnce(current.promise);
      await mount('list');
      const oldSignal = activeSignal(submissionApi.listMine);
      await switchAccount('list', b);
      expect(oldSignal.aborted).toBe(true);
      const resolveB = () => act(async () => current.resolve(list(bDetail)));
      if (order === 'after B resolves') await resolveB();
      await act(async () => obsolete.resolve(list(aDetail, 1, 91)));
      expect(text()).not.toContain(privateTitle);
      expect(text()).not.toContain('1820 submissions');
      if (order === 'while B is loading') {
        expect(text()).toContain('loading…');
        await resolveB();
      }
      expect(text()).toContain(bDetail.problem_title);
      expect(text()).toContain('Page 1 of 1');
    },
  );

  it('ignores a late A list rejection and finally while B remains loading', async () => {
    const obsolete = deferred<ListSubmissionsResponse>();
    const current = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockReturnValueOnce(obsolete.promise)
      .mockReturnValueOnce(current.promise);
    await mount('list');
    await switchAccount('list', b);
    await act(async () => obsolete.reject(new ApiError('private A rejection', 403, 40300)));
    expect(text()).toContain('loading…');
    expect(text()).not.toContain('private A rejection');
    await act(async () => current.resolve(list(null)));
    expect(text()).toContain('No submissions yet');
  });

  it.each(['success', 'error'] as const)(
    'drops an obsolete inline detail %s after account switch',
    async (outcome) => {
      const obsolete = deferred<SubmissionDetail>();
      vi.mocked(submissionApi.get)
        .mockReturnValueOnce(obsolete.promise)
        .mockResolvedValueOnce(bDetail);
      vi.mocked(submissionApi.listMine)
        .mockResolvedValueOnce(list())
        .mockResolvedValueOnce(list(bDetail));
      await mount('list');
      await click('Preview submission 41');
      const oldSignal = activeSignal(submissionApi.get);
      await switchAccount('list', b);
      expectAbsentInCommits(b, privateTitle, 'Loading submission 41', 'Hide submission 41');
      expect(oldSignal.aborted).toBe(true);
      await click('Preview submission 52');
      await act(async () => {
        if (outcome === 'success') obsolete.resolve(aDetail);
        else obsolete.reject(new ApiError('obsolete inline A error', 403, 40300));
      });
      expect(view!.container.querySelector('pre')?.textContent).toBe(bSource);
      expect(text()).not.toContain('obsolete inline A error');
    },
  );

  it('preserves the same-owner query and inline node through user-object refresh', async () => {
    await mount('list');
    await click('Preview submission 41');
    const source = view!.container.querySelector('pre');
    await switchAccount('list', { ...a, full_name: 'Updated name' });
    expect(submissionApi.listMine).toHaveBeenCalledTimes(1);
    expect(submissionApi.get).toHaveBeenCalledTimes(1);
    expect(view!.container.querySelector('pre')).toBe(source);
    expect(button('Hide submission 41').getAttribute('aria-expanded')).toBe('true');
    await click('Hide submission 41');
    expect(view!.container.querySelector('pre')).toBeNull();
    await click('Preview submission 41');
    expect(submissionApi.get).toHaveBeenCalledTimes(2);
    expect(text()).toContain(privateSource);
  });

  it('removes protected list UI during auth hydration and logout and loads B independently', async () => {
    auth.loading = true;
    vi.mocked(submissionApi.listMine)
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(list(bDetail));
    await mount('list');
    expect(text()).toBe('');
    expect(submissionApi.listMine).not.toHaveBeenCalled();
    auth.loading = false;
    await switchAccount('list', a);
    await click('Preview submission 41');
    await switchAccount('list', null);
    expect(text()).toBe('');
    expect(navigation.replace).toHaveBeenCalledWith('/login?next=/submissions');
    expect(submissionApi.listMine).toHaveBeenCalledTimes(1);
    await switchAccount('list', b);
    expectAbsentInCommits(b, privateTitle, privateSource);
    expect(text()).toContain(bDetail.problem_title);
  });

  it('starts a clean first page and selection when the original list owner returns', async () => {
    vi.mocked(submissionApi.listMine)
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(list(bDetail))
      .mockResolvedValueOnce(list());
    await mount('list');
    await click('Preview submission 41');
    await switchAccount('list', b);
    expect(text()).toContain(bDetail.problem_title);
    commits.length = 0;
    await switchAccount('list', a);
    expectAbsentInCommits(a, bDetail.problem_title, bSource);
    expect(text()).toContain(privateTitle);
    expect(text()).not.toContain(privateSource);
    expect(button('Preview submission 41').getAttribute('aria-expanded')).toBe('false');
    expect(submissionApi.listMine).toHaveBeenCalledTimes(3);
    expect(submissionApi.listMine).toHaveBeenLastCalledWith(
      { page: 1, limit: 20, status: '', language: '' },
      expect.any(AbortSignal),
    );
  });

  it('keeps user filters, pagination, error reload and empty state working across query changes', async () => {
    const obsolete = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockResolvedValueOnce(list(aDetail, 1, 3))
      .mockReturnValueOnce(obsolete.promise)
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(list(null))
      .mockResolvedValueOnce(list(aDetail, 1, 3));
    await mount('list');
    await click('Next →');
    const oldSignal = activeSignal(submissionApi.listMine);
    await filter('Filter by status', 'ACCEPTED');
    expect(oldSignal.aborted).toBe(true);
    expect(text()).toContain("Couldn't load submissions");
    await act(async () => obsolete.resolve(list(aDetail, 2, 25)));
    expect(text()).toContain("Couldn't load submissions");
    expect(text()).not.toContain(privateTitle);
    await click('Retry');
    expect(text()).toContain('No submissions match these filters');
    await filter('Filter by language', 'CPP');
    expect(text()).toContain(privateTitle);
    expect(text()).toContain('Page 1 of 3');
    expect(vi.mocked(submissionApi.listMine).mock.calls.map(([query]) => query)).toEqual([
      { page: 1, limit: 20, status: '', language: '' },
      { page: 2, limit: 20, status: '', language: '' },
      { page: 1, limit: 20, status: 'ACCEPTED', language: '' },
      { page: 1, limit: 20, status: 'ACCEPTED', language: '' },
      { page: 1, limit: 20, status: 'ACCEPTED', language: 'CPP' },
    ]);
  });

  it('cancels prior-owner pending-list polling and preserves current-owner polling', async () => {
    vi.mocked(submissionApi.listMine)
      .mockResolvedValueOnce(list({ ...aDetail, status: 'PENDING' }))
      .mockResolvedValueOnce(list({ ...bDetail, status: 'PENDING' }))
      .mockResolvedValueOnce(list(bDetail));
    await mount('list');
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await switchAccount('list', b);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(submissionApi.listMine).toHaveBeenCalledTimes(3);
    expect(text()).toContain('Accepted');
    expect(text()).not.toContain(privateTitle);
  });

  it('invalidates requests on StrictMode replay and unmount', async () => {
    const replay = deferred<ListSubmissionsResponse>();
    vi.mocked(submissionApi.listMine)
      .mockReturnValueOnce(replay.promise)
      .mockResolvedValueOnce(list());
    await mount('list', true);
    expect(submissionApi.listMine).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submissionApi.listMine).mock.calls[0][1]?.aborted).toBe(true);
    const inline = deferred<SubmissionDetail>();
    vi.mocked(submissionApi.get).mockReturnValue(inline.promise);
    await click('Preview submission 41');
    const signal = activeSignal(submissionApi.get);
    await view!.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      replay.resolve(list(aDetail, 1, 9));
      inline.resolve(aDetail);
    });
    expect(document.body.textContent).not.toContain(privateSource);
  });
});

describe('401 replay through the actual protected API client', () => {
  it.each(['detail', 'list'] as const)(
    'does not replay A %s GET after account B commits during refresh',
    async (route) => {
      const refresh = deferred<Response>();
      const requests: { path: string; owner: string | null; signal: AbortSignal | null }[] = [];
      const getPath = route === 'detail' ? '/api/v1/submissions/41' : '/api/v1/me/submissions';
      vi.mocked(submissionApi.get).mockRestore();
      vi.mocked(submissionApi.listMine).mockRestore();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, options: RequestInit) => {
          const path = new URL(url, 'http://localhost').pathname;
          requests.push({ path, owner: auth.user?.id ?? null, signal: options.signal ?? null });
          if (path.endsWith('/auth/refresh-token')) return refresh.promise;
          expect(path).toBe(getPath);
          if (auth.user?.id === a.id) return new Response('', { status: 401 });
          return Response.json({
            data: route === 'detail' ? { ...bDetail, id: 41 } : list(bDetail),
          });
        }),
      );

      await mount(route);
      expect(requests.map(({ path }) => path)).toEqual([getPath, '/api/v1/auth/refresh-token']);
      await switchAccount(route, { ...b, role: 'admin' });
      await act(async () => refresh.resolve(new Response('', { status: 200 })));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(requests[2].signal).not.toBe(requests[0].signal);
      expect(requests[0].signal?.aborted).toBe(true);
      expect(requests.map(({ path, owner }) => [path, owner])).toEqual([
        [getPath, a.id],
        ['/api/v1/auth/refresh-token', a.id],
        [getPath, b.id],
      ]);
      expect(text()).toContain(route === 'detail' ? bSource : bDetail.problem_title);
      expectAbsentInCommits(b, privateSource, privateTitle);
    },
  );

  it('still refreshes and retries a current-owner detail GET exactly once', async () => {
    vi.mocked(submissionApi.get).mockRestore();
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(Response.json({ data: aDetail }));
    vi.stubGlobal('fetch', fetchStub);
    await mount('detail');
    expect(text()).toContain(privateSource);
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(fetchStub.mock.calls.map(([, opts]) => opts.credentials)).toEqual([
      'include',
      'include',
      'include',
    ]);
  });
});
