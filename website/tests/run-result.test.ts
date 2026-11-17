import { describe, expect, it } from 'vitest';
import {
  buildRunConsoleLines,
  collectRunDiagnostics,
  isRunFailure,
} from '../src/features/problem-workspace/runResult';
import type { CodeDiagnostic, RunResponse, RunTestCaseResult } from '../src/lib/types';

const diagnostic: CodeDiagnostic = {
  kind: 'compile',
  severity: 'error',
  message: 'broken',
  line: 3,
  column: 2,
};
const test: RunTestCaseResult = {
  id: 'sample-1',
  kind: 'sample',
  status: 'accepted',
  stdout: '',
  stderr: '',
  expected_output: '',
  execution_time_ms: 0,
  memory_used_kb: 0,
  diagnostics: [],
};

function response(overrides: Partial<RunResponse> = {}): RunResponse {
  return { status: 'completed', compile_output: '', diagnostics: [], tests: [], ...overrides };
}

describe('Run diagnostics and output', () => {
  it('deduplicates top-level and testcase diagnostics in order while dropping nonpositive lines', () => {
    const warning = { ...diagnostic, severity: 'warning', end_line: 8 };
    const runtime = { ...diagnostic, kind: 'runtime', testcase_id: 'sample-1' };
    const result = response({
      diagnostics: [diagnostic, warning, { ...diagnostic, line: 0 }],
      tests: [{ ...test, diagnostics: [diagnostic, runtime, { ...diagnostic, line: -1 }] }],
    });
    expect(collectRunDiagnostics(result)).toEqual([diagnostic, runtime]);
  });

  it('keeps distinct testcase, kind, position and message diagnostics', () => {
    const distinct = [
      diagnostic,
      { ...diagnostic, testcase_id: 'custom-1' },
      { ...diagnostic, kind: 'runtime' },
      { ...diagnostic, line: 4 },
      { ...diagnostic, column: 7 },
      { ...diagnostic, message: 'other' },
    ];
    expect(collectRunDiagnostics(response({ diagnostics: distinct }))).toEqual(distinct);
  });

  it('uses compile output or the existing fallback without mixing execution output', () => {
    expect(
      buildRunConsoleLines(
        response({
          status: 'compile_error',
          compile_output: 'compiler error\n',
          tests: [{ ...test, stdout: 'hidden' }],
        }),
      ),
    ).toEqual([{ text: 'compiler error\n', color: 'var(--warn)' }]);
    expect(buildRunConsoleLines(response({ status: 'compile_error' }))).toEqual([
      { text: 'Compilation failed', color: 'var(--warn)' },
    ]);
  });

  it('emits stdout then stderr per testcase without trimming or adding empty output lines', () => {
    expect(
      buildRunConsoleLines(
        response({
          tests: [
            { ...test, stdout: ' out\n', stderr: 'err\n' },
            { ...test, id: 'custom-2' },
            { ...test, id: 'custom-3', stderr: 'runtime failure' },
          ],
        }),
      ),
    ).toEqual([
      { text: '[sample-1] stdout\n out\n', color: 'var(--code-fg)' },
      { text: '[sample-1] stderr\nerr\n', color: 'var(--error)' },
      { text: '[custom-3] stderr\nruntime failure', color: 'var(--error)' },
    ]);
  });

  it('treats accepted and executed as successes while retaining every failure category', () => {
    for (const status of ['accepted', 'executed'] as const)
      expect(isRunFailure({ ...test, status })).toBe(false);
    for (const status of [
      'wrong_answer',
      'runtime_error',
      'time_limit_exceeded',
      'memory_limit_exceeded',
      'output_limit_exceeded',
      'system_error',
    ] as const)
      expect(isRunFailure({ ...test, status })).toBe(true);
  });
});
