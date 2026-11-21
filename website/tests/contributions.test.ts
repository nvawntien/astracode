// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminLayout from '../src/app/admin/layout';
import ContributionDetail from '../src/app/contributions/[id]/page';
import ContributionsLayout from '../src/app/contributions/layout';
import NewContribution from '../src/app/contributions/new/page';
import Contributions from '../src/app/contributions/page';
import type { Me, Role } from '../src/lib/types';
import { deferred, renderReact } from './helpers/react-dom';

const mocks = vi.hoisted(() => ({
  user: null as Me | null,
  pathname: '/contributions/42',
  router: { push: vi.fn(), replace: vi.fn() },
  showToast: vi.fn(),
  api: { create: vi.fn(), getOwn: vi.fn(), listOwn: vi.fn(), deleteOwn: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '42' }),
  usePathname: () => mocks.pathname,
  useRouter: () => mocks.router,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({ resolved: 'dark', toggle: vi.fn() }),
}));
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('@/components/admin/AdminProblemForm', () => ({
  AdminProblemForm: ({
    mode,
    onSubmit,
  }: {
    mode: string;
    onSubmit: (body: unknown) => Promise<void>;
  }) =>
    mode === 'create'
      ? createElement(
          'button',
          { onClick: () => void onSubmit({ title: 'Fixture' }) },
          'Save draft',
        )
      : createElement('p', null, 'Draft editor'),
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  contributionProblemApi: mocks.api,
}));

const timestamp = '2026-11-21T00:00:00Z';
const problem = {
  id: 42,
  title: 'Fixture problem',
  slug: 'fixture-problem',
  is_hidden: true,
  difficulty: 'easy',
  testcase: { has_testcase: false },
};

function account(role: Role): Me {
  return {
    id: 'fixture-owner',
    username: 'fixture-user',
    full_name: 'Fixture User',
    email: 'fixture@example.test',
    role,
    rating: 0,
    is_active: true,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

let view: Awaited<ReturnType<typeof renderReact>> | undefined;
function button(label: string) {
  const match = [...view!.container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(match, label).toBeDefined();
  return match!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  mocks.pathname = '/contributions/42';
  mocks.user = account('user');
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

it('offers Contributions navigation and draft and Published items for a User', async () => {
  mocks.api.listOwn.mockResolvedValue({
    items: [
      problem,
      { ...problem, id: 43, slug: 'published', title: 'Published fixture', is_hidden: false },
    ],
    total: 2,
    limit: 12,
  });
  view = await renderReact(createElement(ContributionsLayout, null, createElement(Contributions)));
  expect(view.container.querySelector('header a[href="/contributions"]')).toBeTruthy();
  expect(view.container.querySelector('a[href="/contributions/new"]')).toBeTruthy();
  expect(view.container.querySelector('a[href="/contributions/42"]')?.textContent).toBe(
    'Edit draft',
  );
  expect(view.container.querySelector('a[href="/problems/published"]')?.textContent).toBe(
    'View problem',
  );
  expect(view.container.querySelector('.ac-contribution-state.is-draft')?.textContent).toBe('Draft');
  expect(view.container.querySelector('.ac-contribution-state.is-published')?.textContent).toBe(
    'Published',
  );
  expect(view.container.querySelector('a[href="/contributions/43"]')?.textContent).toBe('Open');
});

it.each([
  [null, '/login?next=%2Fcontributions%2F42'],
  ['moderator', '/admin/problems'],
  ['admin', '/admin/problems'],
] as const)('redirects workspace entry for %s', async (role, destination) => {
  mocks.user = role ? account(role) : null;
  view = await renderReact(createElement(ContributionsLayout, null, 'Workspace content'));
  expect(mocks.router.replace).toHaveBeenCalledWith(destination);
  expect(view.container.textContent).not.toContain('Workspace content');
});

it('keeps a User out of the staff problem manager', async () => {
  mocks.pathname = '/admin/problems';
  view = await renderReact(createElement(AdminLayout, null, 'Staff problem controls'));
  expect(view.container.textContent).toContain('403 Forbidden');
  expect(view.container.textContent).not.toContain('Staff problem controls');
});

it('opens the detail view after creating a draft', async () => {
  mocks.api.create.mockResolvedValue(problem);
  view = await renderReact(createElement(NewContribution));
  await click('Save draft');
  expect(mocks.api.create).toHaveBeenCalledWith({ title: 'Fixture' });
  expect(mocks.showToast).toHaveBeenCalledWith('Problem draft created', 'success');
  expect(mocks.router.push).toHaveBeenCalledWith('/contributions/42');
});

it('renders a Published contribution without draft controls', async () => {
  mocks.api.getOwn.mockResolvedValue({ ...problem, is_hidden: false });
  view = await renderReact(createElement(ContributionDetail));
  expect(view.container.textContent).toContain('Published contribution');
  expect(view.container.textContent).toContain('fixture-problem · Published');
  expect(view.container.querySelector('a[href="/contributions"]')?.textContent).toBe(
    'Back to contributions',
  );
  expect(view.container.querySelector('a[href="/problems/fixture-problem"]')?.textContent).toBe(
    'View problem',
  );
  expect(view.container.textContent).not.toContain('Draft editor');
  expect(view.container.textContent).not.toContain('Delete draft');
  expect(view.container.querySelector('#testcase-manager-heading')).toBeNull();
});

it('confirms draft deletion, suppresses concurrent requests and reports failure and success', async () => {
  mocks.api.getOwn.mockResolvedValue(problem);
  const pending = deferred<void>();
  mocks.api.deleteOwn
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce(undefined);
  view = await renderReact(createElement(ContributionDetail));
  await click('Delete draft');
  expect(view.container.querySelector('[role="dialog"]')?.textContent).toContain(
    'Delete this draft?',
  );
  expect(mocks.api.deleteOwn).not.toHaveBeenCalled();

  const confirm = button('Delete');
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(mocks.api.deleteOwn).toHaveBeenCalledExactlyOnceWith(42);
  await act(async () => pending.reject(new Error('fixture error')));
  expect(mocks.showToast).toHaveBeenCalledWith('The draft could not be deleted.', 'error');
  expect(mocks.router.replace).not.toHaveBeenCalled();

  await click('Delete');
  expect(mocks.api.deleteOwn).toHaveBeenCalledTimes(2);
  expect(mocks.showToast).toHaveBeenCalledWith('Problem draft deleted', 'success');
  expect(mocks.router.replace).toHaveBeenCalledWith('/contributions');
});
