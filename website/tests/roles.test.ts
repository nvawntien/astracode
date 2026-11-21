import { describe, expect, it } from 'vitest';
import { isContributionsWorkspaceUser, roleAtLeast } from '../src/components/admin/roles';
import type { Role } from '../src/lib/types';

describe('roleAtLeast', () => {
  it('requires a signed-in role', () => {
    expect(roleAtLeast(undefined, 'user')).toBe(false);
    expect(roleAtLeast(null, 'user')).toBe(false);
  });

  it('inherits lower capabilities without granting higher privileges', () => {
    expect(roleAtLeast('user', 'user')).toBe(true);
    expect(roleAtLeast('user', 'moderator')).toBe(false);
    expect(roleAtLeast('contributor' as Role, 'user')).toBe(false);
    expect(roleAtLeast('moderator', 'user')).toBe(true);
    expect(roleAtLeast('moderator', 'admin')).toBe(false);
    expect(roleAtLeast('admin', 'moderator')).toBe(true);
  });
});

describe('Contributions workspace membership', () => {
  it('admits the User role and routes staff through separate controls', () => {
    expect(isContributionsWorkspaceUser('user')).toBe(true);
    for (const role of ['moderator', 'admin', 'contributor' as Role, null, undefined] satisfies (
      Role | null | undefined
    )[]) {
      expect(isContributionsWorkspaceUser(role)).toBe(false);
    }
  });
});
