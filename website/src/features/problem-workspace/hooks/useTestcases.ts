'use client';

import { useEffect, useState } from 'react';
import type { ToastKind } from '../../../components/ToastProvider';
import type { Problem, RunResponse } from '../../../lib/types';
import { isRunFailure } from '../runResult';
import { initialTestcases } from '../testcases';
import type { TestCase } from '../types';

interface TestcasesOptions {
  problem: Pick<Problem, 'examples'> | null;
  showToast: (message: string, kind?: ToastKind) => void;
}

export function useTestcases({ problem, showToast }: TestcasesOptions) {
  const [tests, setTests] = useState<TestCase[]>([]);
  const [selectedTest, setSelectedTest] = useState(0);

  useEffect(() => {
    if (!problem) return;
    setTests(initialTestcases(problem.examples));
    setSelectedTest(0);
  }, [problem]);

  const updateTest = (index: number, patch: Partial<TestCase>) => {
    setTests((current) => current.map((test, i) => (i === index ? { ...test, ...patch } : test)));
  };

  const addTest = () => {
    if (tests.length >= 10) {
      showToast('Maximum of 10 test cases', 'error');
      return;
    }
    const customCount = tests.filter((test) => test.kind === 'custom').length + 1;
    setTests((current) => [
      ...current,
      {
        id: `custom-${Date.now()}`,
        kind: 'custom',
        name: `Custom ${customCount}`,
        input: '',
        expected: null,
        fromExample: false,
      },
    ]);
    setSelectedTest(tests.length);
  };

  const removeTest = (index: number) => {
    setTests((current) => current.filter((_, i) => i !== index));
    setSelectedTest((current) => Math.max(0, current > index ? current - 1 : current));
  };

  const addExample = (input: string, expected: string) => {
    // Preserve the existing example path, including its lack of a count guard.
    setTests((current) => {
      const next = [
        ...current,
        {
          id: `custom-${Date.now()}`,
          kind: 'custom' as const,
          name: `Custom ${current.filter((test) => test.kind === 'custom').length + 1}`,
          input,
          expected,
          fromExample: false,
        },
      ];
      setSelectedTest(next.length - 1);
      return next;
    });
  };

  const selectRunResult = (result: RunResponse) => {
    const firstFailed = result.tests.findIndex((test) => isRunFailure(test));
    if (firstFailed >= 0) setSelectedTest(firstFailed);
    else if (selectedTest >= tests.length) setSelectedTest(0);
  };

  return {
    tests,
    selectedTest,
    setSelectedTest,
    updateTest,
    addTest,
    removeTest,
    addExample,
    selectRunResult,
  };
}
