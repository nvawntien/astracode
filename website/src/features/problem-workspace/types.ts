import type { RunResponse, RunTestCaseInput } from '@/lib/types';

export interface TestCase {
  id: string;
  kind: 'sample' | 'custom';
  name: string;
  input: string;
  expected: string | null;
  /** Examples come from the problem and cannot be removed. */
  fromExample: boolean;
}

export type TestCasePatch = Partial<Pick<TestCase, 'input' | 'expected'>>;

export type RunCases = readonly Readonly<RunTestCaseInput>[];

export interface RunOutcome {
  cases: RunCases;
  result: RunResponse;
}
