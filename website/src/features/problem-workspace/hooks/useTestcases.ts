'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { ToastKind } from '../../../components/ToastProvider';
import type { Problem, RunResponse } from '../../../lib/types';
import { isRunFailure } from '../runResult';
import { initialTestcases } from '../testcases';
import type { TestCase, TestCasePatch } from '../types';

const MAX_TESTCASES = 10;

interface TestcasesOptions {
  problem: Pick<Problem, 'examples'> | null;
  showToast: (message: string, kind?: ToastKind) => void;
}

interface TestcaseCollection {
  problem: TestcasesOptions['problem'];
  tests: TestCase[];
  selectedId: string | null;
  nextCustomId: number;
}

function createCollection(
  problem: TestcasesOptions['problem'],
  nextCustomId: number,
): TestcaseCollection {
  const tests = problem ? initialTestcases(problem.examples) : [];
  return { problem, tests, selectedId: tests[0]?.id ?? null, nextCustomId };
}

export function useTestcases({ problem, showToast }: TestcasesOptions) {
  const [collection, setCollection] = useState(() => createCollection(problem, 1));
  const current = useRef(collection);

  useLayoutEffect(() => {
    if (current.current.problem === problem) return;
    current.current = createCollection(problem, current.current.nextCustomId);
    setCollection(current.current);
  }, [problem]);

  const activeCollection = () =>
    problem && current.current.problem === problem ? current.current : null;

  // Actions use the latest collection within a batch. This also lets Add
  // Example report acceptance before the page switches tabs or mobile views.
  const commit = (next: TestcaseCollection) => {
    current.current = next;
    setCollection(next);
  };

  const selectTest = (id: string) => {
    const active = activeCollection();
    if (!active || active.selectedId === id || !active.tests.some((test) => test.id === id)) return;
    commit({ ...active, selectedId: id });
  };

  const updateTest = (id: string, patch: TestCasePatch) => {
    const active = activeCollection();
    if (!active || !active.tests.some((test) => test.id === id && !test.fromExample)) return;
    const tests = active.tests.map((test) => (test.id === id ? { ...test, ...patch } : test));
    commit({ ...active, tests });
  };

  const appendTest = (input: string, expected: string | null) => {
    const active = activeCollection();
    if (!active) return false;
    if (active.tests.length >= MAX_TESTCASES) {
      showToast(`Maximum of ${MAX_TESTCASES} test cases`, 'error');
      return false;
    }

    let nextCustomId = active.nextCustomId;
    let id = `custom-${nextCustomId++}`;
    while (active.tests.some((test) => test.id === id)) {
      id = `custom-${nextCustomId++}`;
    }
    const customCount = active.tests.filter((test) => test.kind === 'custom').length;
    const test: TestCase = {
      id,
      kind: 'custom',
      name: `Custom ${customCount + 1}`,
      input,
      expected,
      fromExample: false,
    };
    commit({ ...active, tests: [...active.tests, test], selectedId: id, nextCustomId });
    return true;
  };

  const addTest = () => appendTest('', null);
  const addExample = (input: string, expected: string) => appendTest(input, expected);

  const removeTest = (id: string) => {
    const active = activeCollection();
    if (!active || active.tests.length <= 1) return;
    const index = active.tests.findIndex((test) => test.id === id);
    if (index < 0 || active.tests[index].fromExample) return;

    const tests = active.tests.filter((test) => test.id !== id);
    const selectedId =
      active.selectedId === id ? tests[Math.min(index, tests.length - 1)].id : active.selectedId;
    commit({ ...active, tests, selectedId });
  };

  const selectRunResult = (result: RunResponse) => {
    const active = activeCollection();
    if (!active) return;
    const firstFailed = result.tests.find(
      (test) =>
        isRunFailure(test) && active.tests.some((currentTest) => currentTest.id === test.id),
    );
    if (firstFailed) selectTest(firstFailed.id);
  };

  return {
    tests: collection.tests,
    selectedTest: collection.tests.findIndex((test) => test.id === collection.selectedId),
    selectTest,
    updateTest,
    addTest,
    removeTest,
    addExample,
    selectRunResult,
  };
}
