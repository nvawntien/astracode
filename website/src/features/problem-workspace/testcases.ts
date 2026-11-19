import type { ProblemExample } from '../../lib/types';
import type { TestCase } from './types';

export const MAX_RUN_TESTCASES = 10;

export function initialTestcases(examples: ProblemExample[] | undefined): TestCase[] {
  const fromExamples = (examples ?? []).map((example, index) => ({
    id: `sample-${index + 1}`,
    kind: 'sample' as const,
    name: `Case ${index + 1}`,
    input: example.input,
    expected: example.expected_output,
    fromExample: true,
  }));
  return fromExamples.length > 0
    ? fromExamples
    : [
        {
          id: 'custom-1',
          kind: 'custom',
          name: 'Custom 1',
          input: '',
          expected: null,
          fromExample: false,
        },
      ];
}
