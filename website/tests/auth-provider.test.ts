// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../src/components/AuthProvider';
import { ApiError, submissionApi } from '../src/lib/api';
import type { Me } from '../src/lib/types';
import { deferred, renderReact } from './helpers/react-dom';

const a = { id: 'a', username: 'a', role: 'user' } as Me;
const b = { id: 'b', username: 'b', role: 'user' } as Me;
const credentials = { identifier: 'b', password: 'synthetic-test-password' };
type Call = ReturnType<typeof deferred<Response>> & {
  path: string;
  signal: AbortSignal | null | undefined;
};
let calls: Call[];
let auth: ReturnType<typeof useAuth>;
let view: Awaited<ReturnType<typeof renderReact>> | undefined;

function Consumer() {
  auth = useAuth();
  return null;
}

async function mount(strict = false) {
  const provider = createElement(AuthProvider, null, createElement(Consumer));
  view = await renderReact(strict ? createElement(StrictMode, null, provider) : provider);
}

function requests(path: string) {
  return calls.filter((call) => call.path === '/api/v1/' + path);
}

async function reply(call: Call, body: unknown = null, status = 200) {
  await act(async () => call.resolve(Response.json({ data: body }, { status })));
}

async function start<T>(operation: () => Promise<T>) {
  let done!: Promise<T>;
  await act(async () => {
    done = operation();
    void done.catch(() => {});
  });
  return { done };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const call = {
        ...deferred<Response>(),
        path: new URL(url, 'http://localhost').pathname,
        signal: init.signal,
      };
      calls.push(call);
      // Deliberately let callers resolve even an aborted request.
      return call.promise;
    }),
  );
});

afterEach(async () => {
  await view?.unmount();
  view = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['bootstrap', 'refresh'] as const)(
  'does not resurrect A after logout during %s',
  async (path) => {
    await mount();
    if (path === 'refresh') {
      await reply(requests('me')[0], a);
      await start(auth.refresh);
    }
    const old = requests('me').at(-1)!;
    const logout = await start(auth.logout);
    await reply(requests('auth/logout')[0]);
    await logout.done;
    await reply(old, a);
    expect({ user: auth.user, loading: auth.loading, aborted: old.signal?.aborted }).toEqual({
      user: null,
      loading: false,
      aborted: true,
    });
  },
);

it('keeps the latest same-session refresh and ignores stale success and failure', async () => {
  await mount();
  await reply(requests('me')[0], a);
  const old = await start(auth.refresh);
  const middle = await start(auth.refresh);
  const current = await start(auth.refresh);
  const updated = { ...a, full_name: 'current identity' };
  const reads = requests('me');
  await reply(reads[3], updated);
  await act(async () => reads[2].reject(new Error('network down')));
  await reply(reads[1], a);
  expect(auth.user).toEqual(updated);
  await expect(old.done).resolves.toBeNull();
  await expect(middle.done).resolves.toBeNull();
  await expect(current.done).resolves.toEqual(updated);
  expect(auth.loading).toBe(false);
});

it('keeps B loading and unpublished until B identity resolves despite late A failure', async () => {
  await mount();
  const login = await start(() => auth.login(credentials));
  await reply(requests('auth/login')[0]);
  expect(requests('me')).toHaveLength(2);
  await act(async () => requests('me')[0].reject(new Error('obsolete error')));
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: null, loading: true });
  await reply(requests('me')[1], b);
  await expect(login.done).resolves.toEqual(b);
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: b, loading: false });
});

it('rejects invalid credentials and re-reads the still-current session', async () => {
  await mount();
  await reply(requests('me')[0], a);
  const old = await start(auth.refresh);
  const login = await start(() => auth.login(credentials));
  await reply(requests('auth/login')[0], null, 401);
  expect(requests('me')).toHaveLength(3);
  const freshA = { ...a, full_name: 'fresh A' };
  await reply(requests('me')[2], freshA);
  await expect(login.done).rejects.toMatchObject({ httpStatus: 401 });
  await reply(requests('me')[1], { ...a, full_name: 'obsolete A' });
  await expect(old.done).resolves.toBeNull();
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: freshA, loading: false });
});

it('drops the old identity when credentials succeeded but the authoritative profile failed', async () => {
  await mount();
  await reply(requests('me')[0], a);
  const login = await start(() => auth.login(credentials));
  await reply(requests('auth/login')[0]);
  await reply(requests('me')[1], null, 503);
  await expect(login.done).rejects.toMatchObject({ httpStatus: 503 });
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: null, loading: false });
});

it('serializes a pending logout before login B and ignores old profile callbacks', async () => {
  await mount();
  await reply(requests('me')[0], a);
  const staleSetUser = auth.setUser;
  const old = await start(auth.refresh);
  const logout = await start(auth.logout);
  const login = await start(() => auth.login(credentials));
  expect(requests('auth/login')).toHaveLength(0);
  await reply(requests('auth/logout')[0]);
  await logout.done;
  expect(auth.loading).toBe(true);
  await reply(requests('auth/login')[0]);
  await reply(requests('me').at(-1)!, b);
  await expect(login.done).resolves.toEqual(b);
  await reply(requests('me')[1], a);
  await expect(old.done).resolves.toBeNull();
  await act(async () => staleSetUser(a));
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: b, loading: false });
});

it('ignores the first StrictMode effect and invalidates pending reads on unmount', async () => {
  await mount(true);
  expect(requests('me')).toHaveLength(2);
  const [old, current] = requests('me');
  await reply(current, b);
  await reply(old, a);
  expect(old.signal?.aborted).toBe(true);
  expect(auth.user).toEqual(b);
  const refresh = await start(auth.refresh);
  const pending = requests('me')[2];
  await view!.unmount();
  expect(pending.signal?.aborted).toBe(true);
  await reply(pending, a);
  await expect(refresh.done).resolves.toBeNull();
});

it('keeps current identity refresh and a single protected replay working', async () => {
  await mount();
  await reply(requests('me')[0], null, 401);
  await reply(requests('auth/refresh-token')[0]);
  expect(requests('me')).toHaveLength(2);
  await reply(requests('me')[1], a);
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: a, loading: false });
});

it('drains an older cookie refresh before login and never replays its protected POST', async () => {
  await mount();
  await reply(requests('me')[0], a);
  const submitting = await start(() =>
    submissionApi.create({
      problem_id: 11,
      language: 'CPP',
      source_code: '// A-only source',
    }),
  );
  await reply(requests('submissions')[0], null, 401);
  expect(requests('auth/refresh-token')).toHaveLength(1);
  const login = await start(() => auth.login(credentials));
  const overlappedCookieWriters = requests('auth/login').length > 0;
  await reply(requests('auth/refresh-token')[0]);
  await reply(requests('auth/login')[0]);
  await reply(requests('me')[1], b);

  expect(overlappedCookieWriters).toBe(false);
  expect(requests('submissions')).toHaveLength(1);
  await expect(submitting.done).rejects.toBeInstanceOf(ApiError);
  await expect(login.done).resolves.toEqual(b);
});

it('keeps login A, logout, and a later login B authoritative in order', async () => {
  await mount();
  await reply(requests('me')[0]);
  const loginA = await start(() => auth.login({ ...credentials, identifier: 'a' }));
  await reply(requests('auth/login')[0]);
  await reply(requests('me')[1], a);
  await expect(loginA.done).resolves.toEqual(a);

  const logout = await start(auth.logout);
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: null, loading: true });
  await reply(requests('auth/logout')[0], null, 503);
  await expect(logout.done).rejects.toMatchObject({ httpStatus: 503 });
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: null, loading: false });

  const loginB = await start(() => auth.login(credentials));
  await reply(requests('auth/login')[1]);
  await reply(requests('me')[2], b);
  await expect(loginB.done).resolves.toEqual(b);
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: b, loading: false });
});

it('allows a current profile update and clears identity on a current failed profile read', async () => {
  await mount();
  await reply(requests('me')[0], a);
  const updated = { ...a, full_name: 'updated profile' };
  await act(async () => auth.setUser(updated));
  expect(auth.user).toEqual(updated);
  const refresh = await start(auth.refresh);
  await act(async () => requests('me')[1].reject(new Error('current network failure')));
  await expect(refresh.done).resolves.toBeNull();
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: null, loading: false });
});

it('does not start token refresh for a 401 from the preceding session', async () => {
  await mount();
  await reply(requests('me')[0], a);
  const submitting = await start(() =>
    submissionApi.create({
      problem_id: 11,
      language: 'CPP',
      source_code: '// A-only source',
    }),
  );
  const login = await start(() => auth.login(credentials));
  await reply(requests('auth/login')[0]);
  await reply(requests('me')[1], b);
  await expect(login.done).resolves.toEqual(b);
  await reply(requests('submissions')[0], null, 401);
  await expect(submitting.done).rejects.toBeInstanceOf(ApiError);
  expect(requests('submissions')).toHaveLength(1);
  expect(requests('auth/refresh-token')).toHaveLength(0);
});

it('keeps a queued profile update from publishing through a logout in the same React batch', async () => {
  await mount();
  await reply(requests('me')[0], a);
  const refresh = await start(auth.refresh);
  let logout!: Promise<void>;
  await act(async () => {
    requests('me')[1].resolve(Response.json({ data: { ...a, full_name: 'new A profile' } }));
    await refresh.done;
    logout = auth.logout();
  });
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: null, loading: true });
  await reply(requests('auth/logout')[0]);
  await logout;
  expect({ user: auth.user, loading: auth.loading }).toEqual({ user: null, loading: false });
});
