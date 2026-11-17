import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestcases as testcaseState } from '../src/features/problem-workspace/hooks/useTestcases';
import { initialTestcases } from '../src/features/problem-workspace/testcases';
import type { TestCase } from '../src/features/problem-workspace/types';
import type { RunResponse, RunTestCaseStatus } from '../src/lib/types';

type Effect = () => void;
const react = vi.hoisted(() => ({
  useState: vi.fn(),
  useEffect: vi.fn<(effect: Effect, dependencies: unknown[]) => void>(),
}));
vi.mock('react', () => react);

// Execute real actions/updaters and captured initialization effects in Node.
// Rerenders below are explicit snapshots, not a React lifecycle simulation.
function fixture(initialTests: TestCase[] = [], initialSelection = 0) {
  let tests = initialTests;
  let selected = initialSelection;
  let initialize: Effect = () => {};
  const showToast = vi.fn();
  const setTests = (next: TestCase[] | ((current: TestCase[]) => TestCase[])) => {
    tests = typeof next === 'function' ? next(tests) : next;
  };
  const setSelected = (next: number | ((current: number) => number)) => {
    selected = typeof next === 'function' ? next(selected) : next;
  };
  return {
    showToast,
    read: () => ({ tests, selected }),
    initialize: () => initialize(),
    render(problem: Parameters<typeof testcaseState>[0]['problem'] = null) {
      react.useState
        .mockReturnValueOnce([tests, setTests])
        .mockReturnValueOnce([selected, setSelected]);
      react.useEffect.mockImplementation((effect) => {
        initialize = effect;
      });
      return testcaseState({ problem, showToast });
    },
  };
}

function results(...statuses: RunTestCaseStatus[]): RunResponse {
  return {
    status: 'completed',
    compile_output: '',
    diagnostics: [],
    tests: statuses.map((status, index) => ({
      id: `sample-${index + 1}`,
      kind: 'sample',
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

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

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

  it('initializes on the problem object and resets selection when a new problem arrives', () => {
    const f = fixture();
    f.render();
    f.initialize();
    expect(f.read()).toEqual({ tests: [], selected: 0 });
    const first = { examples: [{ input: 'first', expected_output: 'answer' }] };
    f.render(first);
    expect(react.useEffect.mock.calls.at(-1)?.[1]).toEqual([first]);
    f.initialize();
    expect(f.read().tests).toEqual(initialTestcases(first.examples));
    const state = f.render(first);
    state.addExample('custom', 'output');
    expect(f.read().selected).toBe(1);
    const second = { examples: [] };
    f.render(second);
    f.initialize();
    expect(f.read()).toEqual({ tests: initialTestcases([]), selected: 0 });
  });

  it('adds a timestamped custom case, counts only custom names and selects the appended index', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    const samples = initialTestcases([{ input: 'sample', expected_output: 'out' }]);
    const f = fixture(samples);
    f.render().addTest();
    expect(f.read()).toEqual({
      tests: [
        ...samples,
        {
          id: 'custom-123456',
          kind: 'custom',
          name: 'Custom 1',
          input: '',
          expected: null,
          fromExample: false,
        },
      ],
      selected: 1,
    });
    expect(f.showToast).not.toHaveBeenCalled();
  });

  it('rejects Add case at ten without modifying collection or selection', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      ...initialTestcases([])[0],
      id: `custom-${i}`,
    }));
    const f = fixture(ten, 5);
    f.render().addTest();
    expect(f.read()).toEqual({ tests: ten, selected: 5 });
    expect(f.showToast).toHaveBeenCalledExactlyOnceWith('Maximum of 10 test cases', 'error');
  });

  it('updates custom fields without coercing empty strings, nulls or surrounding whitespace', () => {
    const f = fixture(initialTestcases([]));
    f.render().updateTest(0, { input: '  input\n', expected: '' });
    expect(f.read().tests[0]).toMatchObject({ input: '  input\n', expected: '' });
    f.render().updateTest(0, { expected: null });
    expect(f.read().tests[0].expected).toBeNull();
  });

  it('preserves the previous selection formula, including an out-of-range selected last case', () => {
    const tests = Array.from({ length: 3 }, (_, i) => ({
      ...initialTestcases([])[0],
      id: `custom-${i}`,
    }));
    for (const [selected, removed, expected] of [
      [2, 0, 1],
      [0, 2, 0],
      [0, 0, 0],
      [2, 2, 2],
    ]) {
      const f = fixture(tests, selected);
      f.render().removeTest(removed);
      expect(f.read()).toEqual({
        tests: tests.filter((_, i) => i !== removed),
        selected: expected,
      });
    }
  });

  it('adds examples as editable custom cases with raw expected output and selects the new case', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(10).mockReturnValueOnce(11);
    const samples = initialTestcases([{ input: 'sample', expected_output: 'answer' }]);
    const f = fixture(samples);
    const state = f.render();
    state.addExample('  example\n', '');
    state.addExample('next', 'next output');
    expect(f.read().tests.slice(1)).toEqual([
      {
        id: 'custom-10',
        kind: 'custom',
        name: 'Custom 1',
        input: '  example\n',
        expected: '',
        fromExample: false,
      },
      {
        id: 'custom-11',
        kind: 'custom',
        name: 'Custom 2',
        input: 'next',
        expected: 'next output',
        fromExample: false,
      },
    ]);
    expect(f.read().selected).toBe(2);
  });

  it('characterizes the existing example-insertion path that bypasses the Add case limit', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      ...initialTestcases([])[0],
      id: `custom-${i}`,
    }));
    const f = fixture(ten);
    f.render().addExample('example', 'answer');
    expect(f.read().tests).toHaveLength(11);
    expect(f.read().selected).toBe(10);
  });

  it('selects the first failing result, preserves a valid passing selection, and repairs an invalid one', () => {
    const tests = [...initialTestcases([]), { ...initialTestcases([])[0], id: 'custom-2' }];
    const f = fixture(tests, 0);
    f.render().selectRunResult(results('accepted', 'runtime_error'));
    expect(f.read().selected).toBe(1);
    f.render().selectRunResult(results('accepted', 'executed'));
    expect(f.read().selected).toBe(1);
    f.render().setSelectedTest(9);
    f.render().selectRunResult(results('accepted', 'executed'));
    expect(f.read().selected).toBe(0);
    f.render().selectRunResult(results('wrong_answer', 'runtime_error'));
    expect(f.read().selected).toBe(0);
  });
});
