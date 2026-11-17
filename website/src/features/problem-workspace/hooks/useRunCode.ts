'use client';

import { useState } from 'react';
import type { ToastKind } from '../../../components/ToastProvider';
import { ApiError, NetworkError, submissionApi } from '../../../lib/api';
import type { CodeDiagnostic, LanguageCode, Problem, RunResponse } from '../../../lib/types';
import { buildRunConsoleLines, collectRunDiagnostics } from '../runResult';
import type { TestCase } from '../types';

interface RunCodeOptions {
  problem: Pick<Problem, 'id'> | null;
  language: LanguageCode;
  code: string;
  tests: TestCase[];
  submitting: boolean;
  online: boolean;
  requireAuth: (action: string) => boolean;
  showToast: (message: string, kind?: ToastKind) => void;
  onStart: () => void;
  onResult: (result: RunResponse, diagnostics: CodeDiagnostic[]) => void;
  onUnavailable: () => void;
}

export function useRunCode({
  problem,
  language,
  code,
  tests,
  submitting,
  online,
  requireAuth,
  showToast,
  onStart,
  onResult,
  onUnavailable,
}: RunCodeOptions) {
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResponse | null>(null);
  const [consoleLines, setConsoleLines] = useState<{ text: string; color: string }[]>([]);

  const run = async () => {
    if (!problem || running || submitting) return;
    if (!requireAuth('run code')) return;
    if (!online) {
      showToast('You appear to be offline', 'error');
      return;
    }

    setRunning(true);
    onStart();

    try {
      const result = await submissionApi.run({
        problem_id: problem.id,
        language,
        source_code: code,
        testcases: tests.map((test) => ({
          id: test.id,
          kind: test.kind,
          stdin: test.input,
          expected_output: test.expected,
        })),
      });
      setRunResult(result);
      const diagnostics = collectRunDiagnostics(result);
      onResult(result, diagnostics);
      setConsoleLines(buildRunConsoleLines(result));
    } catch (err) {
      if (err instanceof ApiError && err.isUnimplemented) {
        showToast('Custom runs are unavailable right now — use Submit', 'error');
        setConsoleLines([
          {
            text: `POST ${process.env.NEXT_PUBLIC_RUN_ENDPOINT ?? '/api/v1/submissions/run'} → ${err.httpStatus}`,
            color: 'var(--text3)',
          },
          {
            text: 'Custom tests are unavailable right now. Submit runs the official test suite.',
            color: 'var(--warn)',
          },
        ]);
        onUnavailable();
      } else if (err instanceof NetworkError) {
        showToast(
          'AstraCode is temporarily unreachable. Check your connection and try again.',
          'error',
        );
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Run failed', 'error');
      }
    } finally {
      setRunning(false);
    }
  };

  // Submit clears only the Run result; it must not reset the existing console.
  return { running, runResult, consoleLines, run, setRunResult };
}
