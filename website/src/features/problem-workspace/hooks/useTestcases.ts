'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { ToastKind } from '../../../components/ToastProvider';
import type { Problem } from '../../../lib/types';
import { isRunFailure, matchesRunCase } from '../runResult';
import { initialTestcases, MAX_RUN_TESTCASES } from '../testcases';
import type { RunOutcome, TestCase, TestCasePatch } from '../types';

interface TestcasesOptions {
  problem: Pick<Problem, 'examples'> | null;
  showToast: (message: string, kind?: ToastKind) => void;
}

interface TestcaseCollection {
  problem: TestcasesOptions['problem'];
  tests: TestCase[];
  selectedId: string | null;
  includedIds: ReadonlySet<string>;
  nextCustomId: number;
}

function createCollection(
  problem: TestcasesOptions['problem'],
  nextCustomId: number,
): TestcaseCollection {
  const tests = problem ? initialTestcases(problem.examples) : [];
  const includedIds = new Set(
    tests.length <= MAX_RUN_TESTCASES ? tests.map((test) => test.id) : [],
  );
  return { problem, tests, selectedId: tests[0]?.id ?? null, includedIds, nextCustomId };
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

  const setRunIncluded = (id: string, included: boolean) => {
    const active = activeCollection();
    if (!active || active.includedIds.has(id) === included) return;
    if (
      included &&
      (active.includedIds.size >= MAX_RUN_TESTCASES || !active.tests.some((test) => test.id === id))
    )
      return;

    const includedIds = new Set(active.includedIds);
    if (included) includedIds.add(id);
    else includedIds.delete(id);
    commit({ ...active, includedIds });
  };

  // Read the latest collection even when an edit and Run share a React batch.
  const getRunCases = () => {
    const active = activeCollection();
    return active ? active.tests.filter((test) => active.includedIds.has(test.id)) : [];
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
    if (active.tests.length >= MAX_RUN_TESTCASES) {
      showToast(`Maximum of ${MAX_RUN_TESTCASES} test cases`, 'error');
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
    commit({
      ...active,
      tests: [...active.tests, test],
      includedIds: new Set([...active.includedIds, id]),
      selectedId: id,
      nextCustomId,
    });
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
    const includedIds = new Set(active.includedIds);
    includedIds.delete(id);
    commit({ ...active, tests, selectedId, includedIds });
  };

  const selectRunResult = ({ cases, result }: RunOutcome) => {
    const active = activeCollection();
    if (!active) return;
    const firstFailed = cases.find(
      (submitted) =>
        active.includedIds.has(submitted.id) &&
        result.tests.some(
          (test) => test.id === submitted.id && test.kind === submitted.kind && isRunFailure(test),
        ) &&
        active.tests.some((test) => matchesRunCase(test, submitted)),
    );
    if (firstFailed) selectTest(firstFailed.id);
  };

  return {
    tests: collection.tests,
    selectedTest: collection.tests.findIndex((test) => test.id === collection.selectedId),
    includedIds: collection.includedIds,
    setRunIncluded,
    getRunCases,
    selectTest,
    updateTest,
    addTest,
    removeTest,
    addExample,
    selectRunResult,
  };
}
