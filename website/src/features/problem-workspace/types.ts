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
