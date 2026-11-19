import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe('buildApiUrl', () => {
  it('encodes query values while preserving zero and false and omitting absent values', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', '');
    const { buildApiUrl } = await import('../src/lib/api');

    expect(
      buildApiUrl('/api/v1/problems', {
        search: 'a+b &c',
        page: 0,
        hidden: false,
        missing: undefined,
        unset: null,
        empty: '',
      }),
    ).toBe('/api/v1/problems?search=a%2Bb+%26c&page=0&hidden=false');
  });

  it('updates existing query keys without losing the fragment', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', '');
    const { buildApiUrl } = await import('../src/lib/api');

    expect(
      buildApiUrl('/api/v1/problems?difficulty=easy#examples', { difficulty: 'hard', page: 2 }),
    ).toBe('/api/v1/problems?difficulty=hard&page=2#examples');
  });

  it('uses the configured origin and preserves encoded path segments', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test/');
    const { buildApiUrl } = await import('../src/lib/api');

    expect(buildApiUrl('/api/v1/users/alice%20smith/profile')).toBe(
      'https://api.example.test/api/v1/users/alice%20smith/profile',
    );
  });

  it('defaults to a relative same-origin URL when no base is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', undefined);
    const { buildApiUrl } = await import('../src/lib/api');

    expect(buildApiUrl('/api/v1/me')).toBe('/api/v1/me');
  });
});
