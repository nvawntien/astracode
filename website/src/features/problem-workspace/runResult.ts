import type { RunTestCaseResult } from '@/lib/types';

export function isRunFailure(test: RunTestCaseResult): boolean {
  return !['accepted', 'executed'].includes(test.status);
}

export function formatRunStatus(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
