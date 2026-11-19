import { describe, expect, it } from 'vitest';
import { isContributorWorkspaceUser, roleAtLeast } from '../src/components/admin/roles';
import type { Role } from '../src/lib/types';

describe('roleAtLeast', () => {
  it('requires a signed-in role', () => {
    expect(roleAtLeast(undefined, 'user')).toBe(false);
    expect(roleAtLeast(null, 'user')).toBe(false);
  });

  it('inherits lower capabilities without granting higher privileges', () => {
    expect(roleAtLeast('user', 'contributor')).toBe(false);
    expect(roleAtLeast('contributor', 'contributor')).toBe(true);
    expect(roleAtLeast('contributor', 'moderator')).toBe(false);
    expect(roleAtLeast('moderator', 'contributor')).toBe(true);
    expect(roleAtLeast('moderator', 'admin')).toBe(false);
    expect(roleAtLeast('admin', 'moderator')).toBe(true);
  });
});

describe('contributor workspace membership', () => {
  it('is specific to contributors even when other roles inherit their capabilities', () => {
    expect(isContributorWorkspaceUser('contributor')).toBe(true);
    for (const role of ['user', 'moderator', 'admin', null, undefined] satisfies (
      Role | null | undefined
    )[]) {
      expect(isContributorWorkspaceUser(role)).toBe(false);
    }
  });
});
