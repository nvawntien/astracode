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
  });

  const invalidateOperations = useCallback(() => {
    const operations = operationsRef.current;
    operations.generation += 1;
    operations.submissionId = null;
    operations.completed = false;
    operations.terminalHandled = false;
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

  const authenticated = Boolean(user);
  useLayoutEffect(() => {
    const operations = operationsRef.current;
    operations.mounted = true;
    return () => {
      // Invalidate at commit/unmount, before passive reset effects or late
      // promise continuations. Truthy user-object refreshes keep this scope.
      operations.mounted = false;
      invalidateOperations();
    };
  }, [slug, authenticated, invalidateOperations]);

  useEffect(() => {
    setActiveSubmissionId(null);
    setSubmitting(false);
    setCheckingResult(false);
    setSubmission(null);
    setLiveUpdateError('');
    setDetailFetchError('');
  }, [slug]);

  useEffect(() => {
    if (user) return;
    setActiveSubmissionId(null);
    setSubmitting(false);
    setCheckingResult(false);
  }, [user]);

  const applyStreamStatus = useCallback((event: SubmissionStreamEvent) => {
    setSubmission((current) => {
      if (!current || current.id !== event.submission_id) return current;
      return {
        ...current,
        status: event.status,
        updated_at: event.updated_at,
      };
    });
  }, []);

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
    async (id: number, terminalEvent?: SubmissionStreamEvent) => {
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

      if (terminalEvent) {
        setSubmission((current) => {
          if (!current || current.id !== terminalEvent.submission_id) return current;
          return {
            ...current,
            status: terminalEvent.status,
            updated_at: terminalEvent.updated_at,
          };
        });
      }

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
        setSubmission(latest);
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
      applyStreamStatus(event);
      void fetchTerminalSubmissionDetail(event.submission_id, event);
    },
    [applyStreamStatus, fetchTerminalSubmissionDetail],
  );

  const handleStreamError = useCallback((error: { message: string }) => {
    setLiveUpdateError(error.message);
    setSubmitting(false);
  }, []);

  const stream = useSubmissionStream({
    submissionId: activeSubmissionId,
    enabled: Boolean(activeSubmissionId && submission && isPendingStatus(submission.status)),
    onStatus: applyStreamStatus,
    onTerminal: handleStreamTerminal,
    onError: handleStreamError,
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
