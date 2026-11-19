'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { ToastKind } from '../../../components/ToastProvider';
import { ApiError, NetworkError, submissionApi } from '../../../lib/api';
import type { CodeDiagnostic, LanguageCode, Problem } from '../../../lib/types';
import { buildRunConsoleLines, collectRunDiagnostics } from '../runResult';
import { MAX_RUN_TESTCASES } from '../testcases';
import type { RunCases, RunOutcome, TestCase } from '../types';

interface RunCodeOptions {
  slug: string;
  accountId: string | null;
  problem: Pick<Problem, 'id'> | null;
  language: LanguageCode;
  code: string;
  getRunCases: () => readonly TestCase[];
  submitting: boolean;
  checkingResult: boolean;
  online: boolean;
  requireAuth: (action: string) => boolean;
  showToast: (message: string, kind?: ToastKind) => void;
  onStart: () => void;
  onResult: (outcome: RunOutcome, diagnostics: CodeDiagnostic[]) => void;
  onInvalidSelection: () => void;
  onUnavailable: () => void;
}

interface RunSnapshot {
  owner: string;
  pendingCases: RunCases | null;
  lastRun: RunOutcome | null;
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
  getRunCases,
  submitting,
  checkingResult,
  online,
  requireAuth,
  showToast,
  onStart,
  onResult,
  onInvalidSelection,
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
  const pendingCases = owned?.pendingCases ?? null;
  const running = pendingCases !== null;

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

    const selected = getRunCases();
    if (selected.length === 0 || selected.length > MAX_RUN_TESTCASES) {
      onInvalidSelection();
      return;
    }
    // Copy the submitted values before callbacks and independent collection edits.
    const cases = selected.map((test) => ({
      id: test.id,
      kind: test.kind,
      stdin: test.input,
      expected_output: test.expected,
    }));

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
                pendingCases: null,
                lastRun: null,
                consoleLines: [],
              };
        return { ...base, ...patch };
      });
    };
    write({ pendingCases: cases });
    onStart();

    try {
      if (!ownsRequest()) return;
      const result = await submissionApi.run(
        {
          problem_id: problem.id,
          language,
          source_code: code,
          testcases: cases,
        },
        request.controller.signal,
      );
      if (!ownsRequest()) return;
      const outcome = { cases, result };
      write({ lastRun: outcome });
      const diagnostics = collectRunDiagnostics(result);
      onResult(outcome, diagnostics);
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
        write({ pendingCases: null });
      }
    }
  };

  // Submit clears only the Run result; it must not reset the existing console.
  const clearRunResult = () => {
    const scope = scopeRef.current;
    if (!scope?.active || scope.owner !== owner) return;
    setSnapshot((current) => {
      if (!scope.active || scopeRef.current !== scope) return current;
      return current?.owner === owner ? { ...current, lastRun: null } : current;
    });
  };
  return {
    running,
    pendingCases,
    lastRun: owned?.lastRun ?? null,
    consoleLines: owned?.consoleLines ?? [],
    run,
    clearRunResult,
  };
}
