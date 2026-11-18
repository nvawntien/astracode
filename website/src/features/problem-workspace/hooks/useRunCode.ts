'use client';

import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ToastKind } from '../../../components/ToastProvider';
import { ApiError, NetworkError, submissionApi } from '../../../lib/api';
import type { CodeDiagnostic, LanguageCode, Problem, RunResponse } from '../../../lib/types';
import { buildRunConsoleLines, collectRunDiagnostics } from '../runResult';
import type { TestCase } from '../types';

interface RunCodeOptions {
  slug: string;
  accountId: string | null;
  problem: Pick<Problem, 'id'> | null;
  language: LanguageCode;
  code: string;
  tests: TestCase[];
  submitting: boolean;
  checkingResult: boolean;
  online: boolean;
  requireAuth: (action: string) => boolean;
  showToast: (message: string, kind?: ToastKind) => void;
  onStart: () => void;
  onResult: (result: RunResponse, diagnostics: CodeDiagnostic[]) => void;
  onUnavailable: () => void;
}

interface RunSnapshot {
  owner: string;
  running: boolean;
  runResult: RunResponse | null;
  consoleLines: { text: string; color: string }[];
}

interface RunScope {
  owner: string;
  active: boolean;
  request: { controller: AbortController; pending: boolean } | null;
}

export function useRunCode({
  slug,
  accountId,
  problem,
  language,
  code,
  tests,
  submitting,
  checkingResult,
  online,
  requireAuth,
  showToast,
  onStart,
  onResult,
  onUnavailable,
}: RunCodeOptions) {
  // Code/language edits keep the request's original snapshot valid. Only the
  // account/problem/mounted scope and individual request determine ownership.
  const owner = JSON.stringify([slug, problem?.id, accountId]);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const scopeRef = useRef<RunScope | null>(null);
  useLayoutEffect(() => {
    const scope: RunScope = { owner, active: true, request: null };
    scopeRef.current = scope;
    setSnapshot(null);
    return () => {
      scope.active = false;
      scope.request?.controller.abort();
    };
  }, [owner]);

  // Render-time ownership also hides completed output before scope cleanup.
  const owned = snapshot?.owner === owner ? snapshot : null;
  const running = owned?.running ?? false;

  const run = async () => {
    const scope = scopeRef.current;
    if (!scope?.active || scope.owner !== owner) return;
    if (!problem || scope.request?.pending || running || submitting || checkingResult) return;
    if (!requireAuth('run code')) return;
    if (!accountId) return;
    if (!online) {
      showToast('You appear to be offline', 'error');
      return;
    }

    const request = { controller: new AbortController(), pending: true };
    scope.request = request;
    const ownsRequest = () =>
      scope.active &&
      scopeRef.current === scope &&
      scope.request === request &&
      !request.controller.signal.aborted;
    const write = (patch: Partial<Omit<RunSnapshot, 'owner'>>) => {
      if (!ownsRequest()) return;
      setSnapshot((current) => {
        if (!ownsRequest()) return current;
        const base: RunSnapshot =
          current?.owner === owner
            ? current
            : {
                owner,
                running: false,
                runResult: null,
                consoleLines: [],
              };
        return { ...base, ...patch };
      });
    };
    write({ running: true });
    onStart();

    try {
      if (!ownsRequest()) return;
      const result = await submissionApi.run(
        {
          problem_id: problem.id,
          language,
          source_code: code,
          testcases: tests.map((test) => ({
            id: test.id,
            kind: test.kind,
            stdin: test.input,
            expected_output: test.expected,
          })),
        },
        request.controller.signal,
      );
      if (!ownsRequest()) return;
      write({ runResult: result });
      const diagnostics = collectRunDiagnostics(result);
      onResult(result, diagnostics);
      write({ consoleLines: buildRunConsoleLines(result) });
    } catch (err) {
      if (!ownsRequest()) return;
      if (err instanceof ApiError && err.isUnimplemented) {
        showToast('Custom runs are unavailable right now — use Submit', 'error');
        write({
          consoleLines: [
            {
              text: `POST ${process.env.NEXT_PUBLIC_RUN_ENDPOINT ?? '/api/v1/submissions/run'} → ${err.httpStatus}`,
              color: 'var(--text3)',
            },
            {
              text: 'Custom tests are unavailable right now. Submit runs the official test suite.',
              color: 'var(--warn)',
            },
          ],
        });
        if (ownsRequest()) onUnavailable();
      } else if (err instanceof NetworkError) {
        showToast(
          'AstraCode is temporarily unreachable. Check your connection and try again.',
          'error',
        );
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Run failed', 'error');
      }
    } finally {
      if (ownsRequest()) {
        // Keep identity after finishing: queued React updates still belong to
        // this request, but a subsequent request must supersede them.
        request.pending = false;
        write({ running: false });
      }
    }
  };

  // Submit clears only the Run result; it must not reset the existing console.
  const setRunResult: Dispatch<SetStateAction<RunResponse | null>> = (next) => {
    const scope = scopeRef.current;
    if (!scope?.active || scope.owner !== owner) return;
    setSnapshot((current) => {
      if (!scope.active || scopeRef.current !== scope) return current;
      const base: RunSnapshot =
        current?.owner === owner
          ? current
          : {
              owner,
              running: false,
              runResult: null,
              consoleLines: [],
            };
      return { ...base, runResult: typeof next === 'function' ? next(base.runResult) : next };
    });
  };
  return {
    running,
    runResult: owned?.runResult ?? null,
    consoleLines: owned?.consoleLines ?? [],
    run,
    setRunResult,
  };
}
