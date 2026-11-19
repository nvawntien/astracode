// @vitest-environment jsdom

import { act, createElement, Profiler, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LoginPage from '../src/app/login/page';
import WorkspacePage from '../src/app/problems/[slug]/page';
import { AuthProvider, useAuth } from '../src/components/AuthProvider';
import { draftKey } from '../src/lib/templates';
import type { Me, Problem } from '../src/lib/types';
import { TestEventSource } from './helpers/event-source';
import { deferred, renderReact } from './helpers/react-dom';

const slug = 'auth-ownership';
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => ({ slug: 'auth-ownership' }),
  useSearchParams: () => new URLSearchParams({ next: '/problems/auth-ownership' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({ resolved: 'dark', toggle: () => {} }),
}));
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ showToast: () => {} }) }));

const a: Me = {
  id: 'owner-a',
  username: 'owner-a',
  full_name: 'Fixture A',
  email: 'a@example.test',
  role: 'user',
  rating: 0,
  is_active: true,
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
};
const b: Me = { ...a, id: 'owner-b', username: 'owner-b', full_name: 'Fixture B' };
const problem: Problem = {
  id: 11,
  slug,
  title: 'Auth ownership fixture',
  description: 'Fixture statement',
  input_format: '',
  output_format: '',
  difficulty: 'easy',
  time_limit: 1,
  memory_limit: 128,
  created_at: a.created_at,
  examples: [{ input: 'one', expected_output: 'two' }],
};
const aSource = '// distinct private draft for account A';
const bSource = '// distinct source owned by account B';
const editor = () => document.querySelector<HTMLTextAreaElement>('.ac-code-editor-input');
let auth: ReturnType<typeof useAuth>;
let view: Awaited<ReturnType<typeof renderReact>> | undefined;
let commits: { owner: string | undefined; editor: string | undefined; overlay: string }[];

function ObserveWorkspace() {
  const { user } = useAuth();
  return createElement(
    Profiler,
    {
      id: 'workspace',
      onRender: () =>
        commits.push({
          owner: user?.id,
          editor: editor()?.value,
          overlay: document.querySelector('[data-code-editor-scroll]')?.textContent ?? '',
        }),
    },
    createElement(WorkspacePage),
  );
}

function Route() {
  auth = useAuth();
  const [workspace, setWorkspace] = useState(false);
  router.replace.mockImplementation(() => setWorkspace(true));
  return createElement(workspace ? ObserveWorkspace : LoginPage);
}

async function click(label: string) {
  const button = [...view!.container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

beforeEach(() => {
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { window } = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom;
  vi.stubGlobal('localStorage', window.localStorage);
  vi.stubGlobal('sessionStorage', window.sessionStorage);
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  localStorage.clear();
  localStorage.setItem('astra-lang', 'CPP');
  localStorage.setItem(draftKey(a.id, problem.id, 'CPP'), aSource);
  localStorage.setItem(draftKey(b.id, problem.id, 'CPP'), bSource);
  commits = [];
  TestEventSource.instances = [];
});

afterEach(async () => {
  await view?.unmount();
  view = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['success', 'network error'] as const)(
  'keeps B and B source after obsolete startup A %s with the real login and Workspace',
  async (outcome) => {
    const oldMe = deferred<Response>();
    let session = a;
    const posts: { path: string; account: string; problem_id: number; source_code: string }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path === '/api/v1/me') return session === a ? oldMe.promise : Response.json({ data: b });
      if (path === '/api/v1/auth/login') {
        session = b;
        return Response.json({ code: 20000 });
      }
      if (path === '/api/v1/problems/' + slug) return Response.json({ data: problem });
      if (path === '/api/v1/me/submissions') {
        return Response.json({
          data: { items: [], pagination: { page: 1, limit: 100, total: 0, total_pages: 0 } },
        });
      }
      if (path === '/api/v1/submissions/101/events/ticket') {
        return Response.json({ data: { ticket: 'fixture-ticket', expires_at: a.updated_at } });
      }
      if (path === '/api/v1/submissions/run' || path === '/api/v1/submissions') {
        const { problem_id, source_code } = JSON.parse(String(init.body));
        posts.push({ path, account: session.id, problem_id, source_code });
        return Response.json({
          data: path.endsWith('/run')
            ? { status: 'completed', tests: [], diagnostics: [], compile_output: '' }
            : {
                id: 101,
                problem_id: problem.id,
                problem_title: problem.title,
                language: 'CPP',
                status: 'PENDING',
                created_at: a.created_at,
              },
        });
      }
      throw new Error('Unexpected fixture request: ' + path);
    });
    vi.stubGlobal('fetch', fetch);
    view = await renderReact(createElement(AuthProvider, null, createElement(Route)));
    expect(auth.loading).toBe(true);
    expect(fetch.mock.calls[0][0]).toContain('/api/v1/me');

    const form = view.container.querySelector('form')!;
    const enter = (control: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        control,
        value,
      );
      control.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      enter(form.querySelector('input:not([type="password"])')!, b.username);
      enter(form.querySelector('input[type="password"]')!, 'synthetic-test-password');
    });
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(router.replace).toHaveBeenCalledWith('/problems/' + slug);
    expect(auth.user?.id).toBe(b.id);
    expect(editor()?.value).not.toBe(aSource);

    await act(async () => {
      if (outcome === 'success') oldMe.resolve(Response.json({ data: a }));
      else oldMe.reject(new Error('obsolete network failure'));
    });
    await click('Run');
    await click('Submit');

    expect({
      account: auth.user?.id,
      loading: auth.loading,
      source: editor()?.value,
      privateSourceCommitted: commits.some(
        ({ editor, overlay }) => editor?.includes(aSource) || overlay.includes(aSource),
      ),
      posts,
    }).toEqual({
      account: b.id,
      loading: false,
      source: bSource,
      privateSourceCommitted: false,
      posts: ['/api/v1/submissions/run', '/api/v1/submissions'].map((path) => ({
        path,
        account: b.id,
        problem_id: problem.id,
        source_code: bSource,
      })),
    });
    expect(commits.some(({ owner }) => owner === b.id)).toBe(true);
  },
);
