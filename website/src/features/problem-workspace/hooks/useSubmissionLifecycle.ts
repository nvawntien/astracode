'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ToastKind } from '../../../components/ToastProvider';
import { ApiError, NetworkError, submissionApi } from '../../../lib/api';
import { isPendingStatus, isTerminalSubmissionStatus, verdictMeta } from '../../../lib/format';
import { useSubmissionStream } from '../../../lib/submission-stream';
import type {
  LanguageCode,
  Me,
  Problem,
  Submission,
  SubmissionStreamEvent,
} from '../../../lib/types';
import { nextSubmissionStatus, type SubmissionStatusSnapshot } from '../submissionStatus';

interface SubmissionLifecycleOptions {
  slug: string;
  user: Pick<Me, 'id' | 'username'> | null;
  problem: Pick<Problem, 'id'> | null;
  language: LanguageCode;
  code: string;
  online: boolean;
  // Run consumes submitting, so read its render snapshot only when Submit is invoked.
  isRunning: () => boolean;
  requireAuth: (action: string) => boolean;
  showToast: (message: string, kind?: ToastKind) => void;
  onSubmitStart: () => void;
  onCompleted: (detail: Submission) => void;
}

interface SubmissionOperations {
  generation: number;
  mounted: boolean;
  submissionId: number | null;
  completed: boolean;
  terminalHandled: boolean;
  terminalRequest: AbortController | null;
  manualRequest: AbortController | null;
  statusOrder: SubmissionStatusSnapshot | null;
}

function abortDetailRequests(operations: SubmissionOperations) {
  const { terminalRequest, manualRequest } = operations;
  operations.terminalRequest = null;
  operations.manualRequest = null;
  terminalRequest?.abort();
  manualRequest?.abort();
}

export function useSubmissionLifecycle({
  slug,
  user,
  problem,
  language,
  code,
  online,
  isRunning,
  requireAuth,
  showToast,
  onSubmitStart,
  onCompleted,
}: SubmissionLifecycleOptions) {
  const [submitting, setSubmitting] = useState(false);
  const [checkingResult, setCheckingResult] = useState(false);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [activeSubmissionId, setActiveSubmissionId] = useState<number | null>(null);
  const [liveUpdateError, setLiveUpdateError] = useState('');
  const [detailFetchError, setDetailFetchError] = useState('');
  const operationsRef = useRef<SubmissionOperations>({
    generation: 0,
    mounted: false,
    submissionId: null,
    completed: false,
    terminalHandled: false,
    terminalRequest: null,
    manualRequest: null,
    statusOrder: null,
  });

  const invalidateOperations = useCallback(() => {
    const operations = operationsRef.current;
    operations.generation += 1;
    operations.submissionId = null;
    operations.completed = false;
    operations.terminalHandled = false;
    operations.statusOrder = null;
    // Cancellation saves work. Generation/request identity protects state even
    // when the transport ignores abort and its promise still resolves/rejects.
    abortDetailRequests(operations);
    return operations.generation;
  }, []);

  const isCurrent = useCallback((generation: number, submissionId?: number) => {
    const operations = operationsRef.current;
    return (
      operations.mounted &&
      operations.generation === generation &&
      (submissionId === undefined || operations.submissionId === submissionId)
    );
  }, []);

  const accountId = user?.id ?? null;
  useLayoutEffect(() => {
    const operations = operationsRef.current;
    operations.mounted = true;
    return () => {
      // Invalidate at commit/unmount, before passive reset effects or late
      // promise continuations. Same-account object refreshes keep this scope.
      operations.mounted = false;
      invalidateOperations();
    };
  }, [slug, accountId, invalidateOperations]);

  useEffect(() => {
    setActiveSubmissionId(null);
    setSubmitting(false);
    setCheckingResult(false);
    setSubmission(null);
    setLiveUpdateError('');
    setDetailFetchError('');
  }, [slug]);

  useLayoutEffect(() => {
    setActiveSubmissionId(null);
    setSubmitting(false);
    setCheckingResult(false);
    // Retain the existing logout view, but clear it before an authenticated
    // account (including a login after logout) can display another account's data.
    if (accountId === null) return;
    setSubmission(null);
    setLiveUpdateError('');
    setDetailFetchError('');
  }, [accountId]);

  const applyStreamStatus = useCallback(
    (event: SubmissionStreamEvent) => {
      const operations = operationsRef.current;
      const generation = operations.generation;
      if (!isCurrent(generation, event.submission_id) || operations.completed) return false;
      const next = nextSubmissionStatus(operations.statusOrder, event);
      if (!next) {
        // Even a duplicate initial snapshot can establish the attempt identity.
        if (operations.statusOrder?.attemptId === null) {
          operations.statusOrder.attemptId = event.attempt_id;
        }
        return false;
      }
      operations.statusOrder = next;
      setSubmission((current) => {
        if (
          !isCurrent(generation, event.submission_id) ||
          operationsRef.current.completed ||
          !current ||
          current.id !== event.submission_id
        )
          return current;
        if (current.status === next.status && current.updated_at === next.updatedAt) return current;
        return { ...current, status: next.status, updated_at: next.updatedAt };
      });
      return true;
    },
    [isCurrent],
  );

  const finishSubmissionFromDetail = useCallback(
    (detail: Submission, generation: number) => {
      const operations = operationsRef.current;
      if (!isCurrent(generation, detail.id) || operations.completed) return;
      // This latch belongs to one generation and its bound submission ID.
      // Set it before callbacks so concurrent GETs cannot finish twice.
      operations.completed = true;
      abortDetailRequests(operations);
      setSubmission(detail);
      setSubmitting(false);
      setCheckingResult(false);
      setActiveSubmissionId(null);
      setLiveUpdateError('');
      setDetailFetchError('');
      onCompleted(detail);
    },
    [isCurrent, onCompleted],
  );

  const fetchTerminalSubmissionDetail = useCallback(
    async (id: number) => {
      const operations = operationsRef.current;
      const generation = operations.generation;
      if (!isCurrent(generation, id) || operations.completed || operations.terminalHandled) return;
      operations.terminalHandled = true;
      operations.terminalRequest?.abort();
      const controller = new AbortController();
      operations.terminalRequest = controller;
      const ownsRequest = () =>
        isCurrent(generation, id) &&
        operationsRef.current.terminalRequest === controller &&
        !controller.signal.aborted &&
        !operationsRef.current.completed;

      try {
        const detail = await submissionApi.get(id, controller.signal);
        if (!ownsRequest()) return;
        finishSubmissionFromDetail(detail, generation);
      } catch (err) {
        if (!ownsRequest()) return;
        setSubmitting(false);
        setActiveSubmissionId(null);
        setDetailFetchError(
          err instanceof NetworkError
            ? 'Verdict received, but submission details could not be loaded. Check your connection and try again.'
            : err instanceof ApiError
              ? err.message || 'Verdict received, but submission detail could not be loaded.'
              : 'Verdict received, but submission detail could not be loaded.',
        );
      } finally {
        if (ownsRequest()) {
          operationsRef.current.terminalRequest = null;
        }
      }
    },
    [finishSubmissionFromDetail, isCurrent],
  );

  const checkResultOnce = useCallback(async () => {
    if (!submission || checkingResult) return;
    const operations = operationsRef.current;
    const generation = operations.generation;
    const id = submission.id;
    if (!isCurrent(generation, id) || operations.completed) return;
    operations.manualRequest?.abort();
    const controller = new AbortController();
    operations.manualRequest = controller;
    const ownsRequest = () =>
      isCurrent(generation, id) &&
      operationsRef.current.manualRequest === controller &&
      !controller.signal.aborted &&
      !operationsRef.current.completed;
    setCheckingResult(true);
    setDetailFetchError('');
    try {
      const latest = await submissionApi.get(id, controller.signal);
      if (!ownsRequest()) return;
      if (isTerminalSubmissionStatus(latest.status)) {
        finishSubmissionFromDetail(latest, generation);
      } else {
        // Reconcile against the synchronous latest order, not the submission
        // captured when GET began. HTTP supplies no attempt ID, so it cannot
        // establish a rejudge; terminal detail above retains its authority.
        const next = nextSubmissionStatus(operations.statusOrder, {
          status: latest.status,
          updated_at: latest.updated_at,
        });
        if (!next) return;
        operations.statusOrder = next;
        setSubmission({ ...latest, status: next.status, updated_at: next.updatedAt });
        showToast(
          `Submission #${latest.id} is still ${verdictMeta(latest.status).label.toLowerCase()}.`,
          'success',
        );
      }
    } catch (err) {
      if (!ownsRequest()) return;
      if (err instanceof NetworkError) {
        setDetailFetchError(
          'AstraCode is temporarily unreachable. Check your connection and try again.',
        );
      } else if (err instanceof ApiError) {
        setDetailFetchError(err.message || 'Could not read the submission.');
      } else {
        setDetailFetchError('Could not read the submission.');
      }
    } finally {
      if (ownsRequest()) {
        operationsRef.current.manualRequest = null;
        setCheckingResult(false);
      }
    }
  }, [checkingResult, finishSubmissionFromDetail, isCurrent, showToast, submission]);

  const handleStreamTerminal = useCallback(
    (event: SubmissionStreamEvent) => {
      void fetchTerminalSubmissionDetail(event.submission_id);
    },
    [fetchTerminalSubmissionDetail],
  );

  const handleStreamError = useCallback((error: { message: string }) => {
    setLiveUpdateError(error.message);
    setSubmitting(false);
  }, []);

  const handleStreamConnected = useCallback(
    (id: number) => {
      const operations = operationsRef.current;
      if (
        id !== activeSubmissionId ||
        !isCurrent(operations.generation, id) ||
        operations.completed
      )
        return;
      setLiveUpdateError('');
    },
    [activeSubmissionId, isCurrent],
  );

  const stream = useSubmissionStream({
    submissionId: activeSubmissionId,
    enabled: Boolean(activeSubmissionId && submission && isPendingStatus(submission.status)),
    onStatus: applyStreamStatus,
    onTerminal: handleStreamTerminal,
    onError: handleStreamError,
    onConnected: handleStreamConnected,
  });

  const submit = async () => {
    if (!problem || submitting || checkingResult || isRunning()) return;
    if (!requireAuth('submit')) return;
    if (!online) {
      showToast('You appear to be offline', 'error');
      return;
    }
    if (!code.trim()) {
      showToast('Write some code before submitting', 'error');
      return;
    }
    if (!operationsRef.current.mounted) return;

    setSubmitting(true);
    const generation = invalidateOperations();
    setCheckingResult(false);
    setActiveSubmissionId(null);
    setLiveUpdateError('');
    setDetailFetchError('');
    setSubmission(null);
    onSubmitStart();

    try {
      const created = await submissionApi.create({
        problem_id: problem.id,
        language,
        source_code: code,
      });
      if (!isCurrent(generation)) return;
      operationsRef.current.submissionId = created.id;
      operationsRef.current.statusOrder = {
        attemptId: null,
        status: created.status,
        updatedAt: created.created_at,
      };
      setSubmission({
        id: created.id,
        problem_id: created.problem_id,
        problem_title: created.problem_title,
        user_id: user?.id ?? '',
        username: user?.username ?? '',
        language: created.language,
        source_code: code,
        status: created.status,
        execution_time_ms: null,
        memory_used_kb: null,
        passed_testcases: null,
        total_testcases: null,
        compile_output: null,
        error_message: null,
        created_at: created.created_at,
        updated_at: created.created_at,
      });
      if (isTerminalSubmissionStatus(created.status)) {
        void fetchTerminalSubmissionDetail(created.id);
      } else {
        setActiveSubmissionId(created.id);
      }
    } catch (err) {
      if (!isCurrent(generation)) return;
      setSubmitting(false);
      if (err instanceof NetworkError) {
        showToast(
          'AstraCode is temporarily unreachable. Check your connection and try again.',
          'error',
        );
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Submission rejected', 'error');
      } else {
        showToast('Submission failed', 'error');
      }
    }
  };

  return {
    submitting,
    checkingResult,
    submission,
    liveUpdateError,
    detailFetchError,
    stream,
    submit,
    checkResultOnce,
  };
}
