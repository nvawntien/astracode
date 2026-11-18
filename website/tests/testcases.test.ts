// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestcasePanel } from '../src/features/problem-workspace/components/TestcasePanel';
import { useTestcases } from '../src/features/problem-workspace/hooks/useTestcases';
import { initialTestcases } from '../src/features/problem-workspace/testcases';
import type { RunResponse, RunTestCaseStatus } from '../src/lib/types';
import { renderReact } from './helpers/react-dom';

type Problem = Parameters<typeof useTestcases>[0]['problem'];
let latest: ReturnType<typeof useTestcases>;
let view: Awaited<ReturnType<typeof renderReact>> | undefined;
const emptyProblem = { examples: [] };
const sampleProblem = { examples: [{ input: '1\n', expected_output: ' 2\n' }] };
const showToast = vi.fn();

function Probe({ problem }: { problem: Problem }) {
  latest = useTestcases({ problem, showToast });
  return createElement(TestcasePanel, {
    tests: latest.tests,
    selected: latest.selectedTest,
    results: new Map(),
    running: false,
    onSelect: latest.selectTest,
    onAdd: latest.addTest,
    onRemove: latest.removeTest,
    onUpdate: latest.updateTest,
  });
}

function element(problem: Problem, strict = false) {
  const child = createElement(Probe, { problem });
  return strict ? createElement(StrictMode, null, child) : child;
}

async function mount(problem: Problem = emptyProblem, strict = false) {
  view = await renderReact(element(problem, strict));
}
function button(label: string) {
  const match = [...view!.container.querySelectorAll('button')].find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label,
  );
  expect(match, label).toBeDefined();
  return match!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function add(count: number) {
  for (let i = 0; i < count; i++) await click('+ Add case');
}
function selectedId() {
  return latest.tests[latest.selectedTest]?.id;
}
function assertSelection(index: number) {
  expect(latest.selectedTest).toBe(index);
  expect(view!.container.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
  expect(view!.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
    latest.tests[index].input,
  );
}

function results(...statuses: RunTestCaseStatus[]): RunResponse {
  return {
    status: 'completed',
    compile_output: '',
    diagnostics: [],
    tests: statuses.map((status, index) => ({
      id: latest.tests[index].id,
      kind: latest.tests[index].kind,
      status,
      stdout: '',
      stderr: '',
      expected_output: '',
      execution_time_ms: 0,
      memory_used_kb: 0,
      diagnostics: [],
    })),
  };
}

beforeEach(() => {
  showToast.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  try {
    await view?.unmount();
  } finally {
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('testcase initialization and actions', () => {
  it('maps examples to samples in order without trimming their input or expected output', () => {
    const examples = [
      { input: '1\n', expected_output: ' 2\n' },
      { input: '', expected_output: '' },
    ];
    expect(initialTestcases(examples)).toEqual([
      {
        id: 'sample-1',
        kind: 'sample',
        name: 'Case 1',
        input: '1\n',
        expected: ' 2\n',
        fromExample: true,
      },
      {
        id: 'sample-2',
        kind: 'sample',
        name: 'Case 2',
        input: '',
        expected: '',
        fromExample: true,
      },
    ]);
    expect(examples).toEqual([
      { input: '1\n', expected_output: ' 2\n' },
      { input: '', expected_output: '' },
    ]);
  });

  it('creates the existing single-custom fallback for absent or empty examples', () => {
    const fallback = [
      {
        id: 'custom-1',
        kind: 'custom',
        name: 'Custom 1',
        input: '',
        expected: null,
        fromExample: false,
      },
    ];
    expect(initialTestcases(undefined)).toEqual(fallback);
    expect(initialTestcases([])).toEqual(fallback);
  });

  it('initializes on the problem object, preserves rerenders and resets on problem change', async () => {
    await mount(null, true);
    expect(latest.tests).toEqual([]);
    expect(latest.selectedTest).toBe(-1);
    expect(view!.container.querySelector('textarea')).toBeNull();
    await view!.rerender(element(sampleProblem, true));
    expect(latest.tests).toEqual(initialTestcases(sampleProblem.examples));
    assertSelection(0);
    await act(async () => latest.addExample('custom', 'output'));
    assertSelection(1);
    const previous = latest.tests;
    await view!.rerender(element(sampleProblem, true));
    expect(latest.tests).toBe(previous);
    assertSelection(1);
    await view!.rerender(element(emptyProblem, true));
    expect(latest.tests).toEqual(initialTestcases([]));
    assertSelection(0);
    await view!.unmount();
    await mount(sampleProblem);
    expect(latest.tests).toEqual(initialTestcases(sampleProblem.examples));
    assertSelection(0);
  });

  it('counts only custom names, preserves defaults and selects the appended case', async () => {
    await mount(sampleProblem);
    await add(1);
    expect(latest.tests[0]).toEqual(initialTestcases(sampleProblem.examples)[0]);
    expect(latest.tests[1]).toEqual({
      id: expect.stringMatching(/^custom-/),
      kind: 'custom',
      name: 'Custom 1',
      input: '',
      expected: null,
      fromExample: false,
    });
    assertSelection(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('rejects Add case and Add Example at ten total entries without modifying selection', async () => {
    await mount(sampleProblem);
    await add(9);
    await click('Case 1');
    const full = latest.tests;
    await click('+ Add case');
    await act(async () => latest.addExample('example', 'answer'));
    expect(latest.tests).toBe(full);
    expect(latest.tests).toHaveLength(10);
    assertSelection(0);
    expect(showToast.mock.calls).toEqual([
      ['Maximum of 10 test cases', 'error'],
      ['Maximum of 10 test cases', 'error'],
    ]);
  });

  it('updates custom fields without coercing empty strings, nulls or surrounding whitespace', async () => {
    await mount();
    const id = selectedId();
    await act(async () =>
      latest.updateTest(latest.tests[0].id, { input: '  input\n', expected: '' }),
    );
    expect(latest.tests[0]).toMatchObject({ id, input: '  input\n', expected: '' });
    await act(async () => latest.updateTest(latest.tests[0].id, { expected: null }));
    expect(latest.tests[0]).toMatchObject({ id, expected: null });
    assertSelection(0);
  });

  it.each([
    [2, 0, 1],
    [0, 2, 0],
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 1],
  ])('selects the correct neighbor after deleting case %i/%i', async (selected, removed, next) => {
    await mount();
    await add(2);
    const remaining = latest.tests.filter((_, i) => i !== removed);
    await click(`Custom ${selected + 1}`);
    await click(`Remove Custom ${removed + 1}`);
    expect(latest.tests).toEqual(remaining);
    expect(selectedId()).toBe(remaining[next].id);
    assertSelection(next);
  });

  it('keeps final fallback and original samples non-removable and samples read-only', async () => {
    await mount();
    expect(view!.container.querySelector('[aria-label="Remove Custom 1"]')).toBeNull();
    assertSelection(0);
    await view!.rerender(element(sampleProblem));
    expect(view!.container.querySelector('[aria-label="Remove Case 1"]')).toBeNull();
    expect(view!.container.querySelector('textarea')?.readOnly).toBe(true);
    assertSelection(0);
  });

  it('adds examples as editable custom cases with raw expected output and selects the new case', async () => {
    await mount(sampleProblem);
    await act(async () => {
      latest.addExample('  example\n', '');
      latest.addExample('next', 'next output');
    });
    expect(latest.tests.slice(1)).toEqual([
      {
        id: expect.stringMatching(/^custom-/),
        kind: 'custom',
        name: 'Custom 1',
        input: '  example\n',
        expected: '',
        fromExample: false,
      },
      {
        id: expect.stringMatching(/^custom-/),
        kind: 'custom',
        name: 'Custom 2',
        input: 'next',
        expected: 'next output',
        fromExample: false,
      },
    ]);
    assertSelection(2);
  });

  it('preserves oversized sample initialization and rejects further insertion', async () => {
    const samples = {
      examples: Array.from({ length: 11 }, (_, i) => ({ input: String(i), expected_output: '' })),
    };
    await mount(samples);
    await click('+ Add case');
    await act(async () => latest.addExample('extra', 'answer'));
    expect(latest.tests).toEqual(initialTestcases(samples.examples));
    assertSelection(0);
    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it('selects the first failing result and preserves a valid passing selection', async () => {
    await mount();
    await add(1);
    await click('Custom 1');
    await act(async () => latest.selectTest('removed-id'));
    assertSelection(0);
    await act(async () => latest.selectRunResult(results('accepted', 'runtime_error')));
    assertSelection(1);
    await act(async () => latest.selectRunResult(results('accepted', 'executed')));
    assertSelection(1);
    await act(async () => latest.selectRunResult(results('wrong_answer', 'runtime_error')));
    assertSelection(0);
  });

  it('targets a surviving failing ID after the request order has changed', async () => {
    let timestamp = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => timestamp++);
    await mount();
    await add(3);
    const response = results('accepted', 'wrong_answer', 'accepted', 'runtime_error');
    await click('Remove Custom 2');
    await click('Custom 1');
    await act(async () => latest.selectRunResult(response));
    expect(selectedId()).toBe(response.tests[3].id);
    assertSelection(2);
  });
});

describe('testcase identity within a React batch', () => {
  it.each([false, true])(
    'exhausts capacity once across mixed additions (StrictMode=%s)',
    async (strict) => {
      await mount(emptyProblem, strict);
      await add(7);
      await act(async () => {
        latest.addTest();
        latest.addExample('last example', 'answer');
        latest.addTest();
        latest.addExample('over limit', 'answer');
      });
      expect(latest.tests).toHaveLength(10);
      expect(latest.tests.slice(-2).map(({ input, name }) => [input, name])).toEqual([
        ['', 'Custom 9'],
        ['last example', 'Custom 10'],
      ]);
      assertSelection(9);
      expect(showToast.mock.calls).toEqual([
        ['Maximum of 10 test cases', 'error'],
        ['Maximum of 10 test cases', 'error'],
      ]);
    },
  );

  it('avoids seeded and same-clock ID collisions across sequential and batch additions, edits and deletion', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1);
    await mount(emptyProblem, true);
    const seeded = latest.tests[0];
    await add(2);
    await act(async () => {
      latest.addTest();
      latest.addExample('same millisecond', 'answer');
    });
    const originalIds = latest.tests.map(({ id }) => id);
    expect(new Set(originalIds).size).toBe(5);
    expect(latest.tests[0]).toBe(seeded);
    assertSelection(4);
    const kept = button('Custom 3');
    await click('Custom 3');
    await act(async () => latest.updateTest(latest.tests[2].id, { input: 'edited' }));
    expect(latest.tests.map(({ id }) => id)).toEqual(originalIds);
    await click('Remove Custom 2');
    expect(button('Custom 3')).toBe(kept);
    expect(selectedId()).toBe(originalIds[2]);
    await add(1);
    expect(originalIds).not.toContain(selectedId());
    expect(latest.tests.slice(0, -1).map(({ id }) => id)).toEqual(
      originalIds.filter((_, i) => i !== 1),
    );
    assertSelection(4);
  });

  it('uses testcase identity for two deletes and an intervening selection before rerender', async () => {
    await mount();
    await add(3);
    const original = latest.tests;
    const removeFirst = button('Remove Custom 1');
    const chooseThird = button('Custom 3');
    const removeThird = button('Remove Custom 3');
    await act(async () => {
      removeFirst.click();
      chooseThird.click();
      removeThird.click();
    });
    expect(latest.tests).toEqual([original[1], original[3]]);
    expect(selectedId()).toBe(original[3].id);
    assertSelection(1);
  });
});
