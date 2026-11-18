// @vitest-environment jsdom

import { act, createElement, StrictMode, useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspacePage from '../src/app/problems/[slug]/page';
import { ApiError, NetworkError, problemApi, submissionApi } from '../src/lib/api';
import { invalidateProgress } from '../src/lib/progress';
import { draftKey } from '../src/lib/templates';
import type { Me, Problem } from '../src/lib/types';
import { TestEventSource } from './helpers/event-source';
import { deferred, renderReact } from './helpers/react-dom';

const observed = vi.hoisted(() => ({
  slug: 'first-problem',
  user: null as Me | null,
  router: { push: vi.fn() },
  toast: vi.fn(),
  onCommit: null as (() => void) | null,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: observed.slug }),
  useRouter: () => observed.router,
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

const user: Me = {
  id: 'problem-load-account',
  username: 'fixture',
  full_name: 'Fixture name',
  email: 'fixture@example.test',
  role: 'user',
  rating: 0,
  is_active: true,
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
};
const a: Problem = {
  id: 11,
  slug: 'first-problem',
  title: 'First fixture title',
  description: 'Content exclusively for fixture A',
  input_format: '',
  output_format: '',
  difficulty: 'easy',
  time_limit: 1,
  memory_limit: 128,
  created_at: user.created_at,
  examples: [{ input: 'A fixture input', expected_output: 'A fixture output' }],
};
const b: Problem = {
  ...a,
  id: 22,
  slug: 'second-problem',
  title: 'Second fixture title',
  description: 'Content exclusively for fixture B',
  examples: [
    { input: ' B first input\n', expected_output: 'B first output\n' },
    { input: ' B second input', expected_output: 'B second output' },
  ],
};
const aDraft = '// draft scoped to A';
const bDraft = '// draft scoped to B';
const unavailable = 'AstraCode is temporarily unreachable. Check your connection and try again.';

type Request = ReturnType<typeof deferred<Problem>> & { slug: string; signal: AbortSignal };
let requests: Request[];
let commits: {
  slug: string;
  text: string;
  editor: string | undefined;
  sample: string | undefined;
  loading: boolean;
}[];
let view: Awaited<ReturnType<typeof renderReact>> | undefined;

function ObserveCommit() {
  // The parent layout effect sees the committed DOM before passive effects.
  useLayoutEffect(() => {
    commits.push({
      slug: observed.slug,
      text: document.body.textContent ?? '',
      editor: document.querySelector<HTMLTextAreaElement>('.ac-code-editor-input')?.value,
      sample: document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Test input for Case 1"]',
      )?.value,
      loading: Boolean(document.querySelector('[role="status"][aria-label="Loading problem"]')),
    });
    observed.onCommit?.();
  });
  return createElement(WorkspacePage);
}

function element(strict = false) {
  const content = createElement(ObserveCommit);
  return strict ? createElement(StrictMode, null, content) : content;
}
async function mount(strict = false) {
  view = await renderReact(element(strict));
}
async function navigate(slug: string, strict = false) {
  observed.slug = slug;
  await view!.rerender(element(strict));
}
function surface() {
  return view!.container;
}
function editor() {
  return surface().querySelector<HTMLTextAreaElement>('.ac-code-editor-input');
}
function sampleInput() {
  return surface().querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Test input for Case 1"]',
  )?.value;
}
function expectLoading() {
  expect(surface().querySelector('[role="status"][aria-label="Loading problem"]')).not.toBeNull();
  expect(surface().querySelector('#workspace-problem-pane')).toBeNull();
  expect(editor()).toBeNull();
}
async function resolve(request: Request, problem: Problem) {
  await act(async () => request.resolve(problem));
}
function shortcut(shiftKey: boolean) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      shiftKey,
      cancelable: true,
    }),
  );
}
async function click(label: string) {
  const button = [...surface().querySelectorAll('button')].find(
    (node) => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}
function expectB() {
  expect(surface().textContent).toContain(b.title);
  expect(surface().textContent).toContain(b.description);
  expect(surface().textContent).not.toContain(a.title);
  expect(surface().textContent).not.toContain(a.description);
  expect(editor()?.value).toBe(bDraft);
  expect(sampleInput()).toBe(b.examples![0].input);
  expect(surface().textContent).toContain('Tests (2)');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', TestEventSource);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  TestEventSource.instances = [];

  const dom = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
  vi.stubGlobal('localStorage', dom.localStorage);
  vi.stubGlobal('sessionStorage', dom.sessionStorage);
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('astra-lang', 'CPP');
  localStorage.setItem(draftKey(user.id, a.id, 'CPP'), aDraft);
  localStorage.setItem(draftKey(user.id, b.id, 'CPP'), bDraft);
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true, writable: true });

  observed.slug = a.slug;
  observed.user = user;
  observed.onCommit = null;
  requests = [];
  commits = [];

  vi.spyOn(problemApi, 'bySlug').mockImplementation((slug, signal) => {
    const request = { ...deferred<Problem>(), slug, signal: signal! };
    requests.push(request);
    // Deliberately ignore the signal so the test can deliver stale success/errors.
    return request.promise;
  });
  vi.spyOn(submissionApi, 'listMine').mockResolvedValue({
    items: [],
    pagination: { page: 1, limit: 100, total: 0, total_pages: 0 },
  });
  vi.spyOn(submissionApi, 'run').mockResolvedValue({
    status: 'completed',
    compile_output: '',
    diagnostics: [],
    tests: [],
  });
  vi.spyOn(submissionApi, 'create').mockImplementation(async (body) => ({
    id: 101,
    problem_id: body.problem_id,
    problem_title: b.title,
    language: body.language,
    status: 'PENDING',
    created_at: user.created_at,
  }));
  vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue({
    ticket: 'fixture-ticket',
    expires_at: user.updated_at,
  });
});

afterEach(async () => {
  try {
    await view?.unmount();
    invalidateProgress(user.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('problem loading across Workspace route changes', () => {
  it('keeps B title, samples, draft and Run/Submit IDs when a canceled A success arrives last', async () => {
    await mount();
    await navigate(b.slug);
    expect(requests.map(({ slug }) => slug)).toEqual([a.slug, b.slug]);
    expect(requests[0].signal.aborted).toBe(true);
    await resolve(requests[1], b);
    expectB();
    await resolve(requests[0], a);

    expectB();
    await click('Run');
    expect(submissionApi.run).toHaveBeenCalledExactlyOnceWith(
      {
        problem_id: b.id,
        language: 'CPP',
        source_code: bDraft,
        testcases: b.examples!.map((example, i) => ({
          id: `sample-${i + 1}`,
          kind: 'sample',
          stdin: example.input,
          expected_output: example.expected_output,
        })),
      },
      expect.any(AbortSignal),
    );
    await click('Submit');
    expect(submissionApi.create).toHaveBeenCalledExactlyOnceWith(
      { problem_id: b.id, language: 'CPP', source_code: bDraft },
      expect.any(Function),
    );
    expect(localStorage.getItem(draftKey(user.id, a.id, 'CPP'))).toBe(aDraft);
    expect(localStorage.getItem(draftKey(user.id, b.id, 'CPP'))).toBe(bDraft);
  });

  it.each(['while loading B', 'after loading B'] as const)(
    'ignores a stale A rejection %s',
    async (order) => {
      await mount();
      await navigate(b.slug);
      if (order === 'after loading B') await resolve(requests[1], b);
      await act(async () => requests[0].reject(new NetworkError()));
      expect(requests[0].signal.aborted).toBe(true);
      expect(surface().textContent).not.toContain(unavailable);
      expect(observed.toast).not.toHaveBeenCalled();
      if (order === 'while loading B') {
        expectLoading();
        await resolve(requests[1], b);
      }
      expectB();
    },
  );

  it('keeps B loading when canceled A resolves before the current request', async () => {
    await mount();
    await navigate(b.slug);
    await resolve(requests[0], a);
    expectLoading();
    expect(surface().textContent).not.toContain(a.title);
    await resolve(requests[1], b);
    expectB();
  });

  it('commits the B skeleton without A title, description, testcase or editor', async () => {
    await mount();
    await resolve(requests[0], a);
    expect(surface().textContent).toContain(a.title);
    expect(editor()?.value).toBe(aDraft);
    expect(sampleInput()).toBe(a.examples![0].input);

    await navigate(b.slug);
    const firstB = commits.find((commit) => commit.slug === b.slug);
    expect(firstB).toMatchObject({ loading: true, editor: undefined, sample: undefined });
    expect(firstB?.text).not.toContain(a.title);
    expect(firstB?.text).not.toContain(a.description);
    expectLoading();
    await resolve(requests[1], b);
    expectB();
  });

  it.each([
    { action: 'Run', shiftKey: false },
    { action: 'Submit', shiftKey: true },
  ])('blocks old $action shortcuts at the B commit and while B loads', async ({ shiftKey }) => {
    await mount();
    await resolve(requests[0], a);
    const hotkeyAtCommit = vi.fn(() => {
      observed.onCommit = null;
      shortcut(shiftKey);
    });
    observed.onCommit = hotkeyAtCommit;
    await navigate(b.slug);

    expect(hotkeyAtCommit).toHaveBeenCalledTimes(1);
    await act(async () => shortcut(shiftKey));
    const action = shiftKey ? submissionApi.create : submissionApi.run;
    expect(action).not.toHaveBeenCalled();
    await resolve(requests[1], b);
    expectB();
  });

  it('does not accept a successful A update queued in a batch with navigation to B', async () => {
    await mount();
    await act(async () => {
      requests[0].resolve(a);
      await Promise.resolve();
      await navigate(b.slug);
    });
    const firstB = commits.find((commit) => commit.slug === b.slug);
    expect(firstB?.loading).toBe(true);
    expect(firstB?.text).not.toContain(a.title);
    expectLoading();
    await resolve(requests[1], b);
    expectB();
  });

  it('rejects the first A response after A to B to A even though the slug matches again', async () => {
    const a2 = { ...a, title: 'Newest result on first-problem', description: 'New A response' };
    await mount();
    await navigate(b.slug);
    await navigate(a.slug);
    expect(requests.map(({ slug }) => slug)).toEqual([a.slug, b.slug, a.slug]);
    expect(requests.map(({ signal }) => signal.aborted)).toEqual([true, true, false]);
    await resolve(requests[2], a2);
    await resolve(requests[1], b);
    await resolve(requests[0], a);
    expect(surface().textContent).toContain(a2.title);
    expect(surface().textContent).not.toContain(a.title);
    expect(surface().textContent).not.toContain(b.title);
    expect(editor()?.value).toBe(aDraft);
  });

  it.each(['pending', 'ready'] as const)(
    'reloads a previously displayed problem without showing its prior snapshot when B is %s',
    async (state) => {
      await mount();
      await resolve(requests[0], a);
      await navigate(b.slug);
      if (state === 'ready') await resolve(requests[1], b);
      commits.length = 0;
      await navigate(a.slug);
      expect(requests.map(({ slug }) => slug)).toEqual([a.slug, b.slug, a.slug]);
      expect(commits[0]).toMatchObject({ slug: a.slug, loading: true, editor: undefined });
      expect(commits[0].text).not.toContain(a.title);
      expect(commits[0].text).not.toContain(b.title);
      await resolve(requests[2], a);
      expect(surface().textContent).toContain(a.title);
    },
  );

  it('does not allow a late prior success to replace the active route error', async () => {
    await mount();
    await navigate(b.slug);
    await act(async () => requests[1].reject(new NetworkError()));
    await resolve(requests[0], a);
    expect(surface().textContent).toContain(unavailable);
    expect(surface().textContent).not.toContain(a.title);
    expect(editor()).toBeNull();
  });

  it.each([
    {
      label: 'public 404',
      error: new ApiError('hidden fixture', 404, 40400),
      message: 'Problem not found',
    },
    { label: 'network failure', error: new NetworkError(), message: unavailable },
    {
      label: 'other API failure',
      error: new ApiError('private API details', 503, 50300),
      message: 'This problem could not be loaded.',
    },
  ])('keeps $label UX and succeeds on the next route', async ({ error, message }) => {
    await mount();
    await act(async () => requests[0].reject(error));
    expect(surface().textContent).toContain(message);
    expect(editor()).toBeNull();
    expect(surface().querySelector('a[href="/problems"]')).not.toBeNull();
    expect(observed.toast).not.toHaveBeenCalled();
    await navigate(b.slug);
    const firstB = commits.find((commit) => commit.slug === b.slug);
    expect(firstB?.loading).toBe(true);
    expect(firstB?.text).not.toContain(message);
    await resolve(requests[1], b);
    expectB();
  });

  it('keeps the same-slug request, edits and textarea on rerenders and same-ID auth refresh', async () => {
    await mount();
    observed.user = { ...user, full_name: 'Refreshed fixture name' };
    await view!.rerender(element());
    expect(requests).toHaveLength(1);
    expect(requests[0].signal.aborted).toBe(false);
    await resolve(requests[0], a);
    const input = editor()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '// unsaved fixture edit',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view!.rerender(element());
    expect(editor()).toBe(input);
    expect(editor()?.value).toBe('// unsaved fixture edit');
    expect(requests).toHaveLength(1);
  });

  it('cancels the first StrictMode request and ignores its same-slug success', async () => {
    await mount(true);
    expect(requests.map(({ slug }) => slug)).toEqual([a.slug, a.slug]);
    expect(requests[0].signal.aborted).toBe(true);
    await resolve(requests[1], a);
    await resolve(requests[0], { ...a, title: 'Obsolete StrictMode response' });
    expect(surface().textContent).toContain(a.title);
    expect(surface().textContent).not.toContain('Obsolete StrictMode response');
  });

  it('aborts on unmount and ignores the response after a separate Workspace mounts', async () => {
    await mount();
    const old = requests[0];
    await view!.unmount();
    expect(old.signal.aborted).toBe(true);
    observed.slug = b.slug;
    await mount();
    await resolve(requests[1], b);
    await resolve(old, a);
    expectB();
    expect(observed.toast).not.toHaveBeenCalled();
  });
});
