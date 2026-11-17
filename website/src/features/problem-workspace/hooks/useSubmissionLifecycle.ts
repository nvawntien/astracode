'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const terminalDetailHandledRef = useRef(false);
  const terminalDetailAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      terminalDetailAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    terminalDetailAbortRef.current?.abort();
    terminalDetailHandledRef.current = false;
    setActiveSubmissionId(null);
    setSubmitting(false);
    setCheckingResult(false);
    setSubmission(null);
    setLiveUpdateError('');
    setDetailFetchError('');
  }, [slug]);

  useEffect(() => {
    if (user) return;
    terminalDetailAbortRef.current?.abort();
    terminalDetailHandledRef.current = false;
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
    (detail: Submission) => {
      setSubmission(detail);
      setSubmitting(false);
      setActiveSubmissionId(null);
      setLiveUpdateError('');
      setDetailFetchError('');
      onCompleted(detail);
    },
    [onCompleted],
  );

  const fetchTerminalSubmissionDetail = useCallback(
    async (id: number, terminalEvent?: SubmissionStreamEvent) => {
      if (terminalDetailHandledRef.current) return;
      terminalDetailHandledRef.current = true;
      terminalDetailAbortRef.current?.abort();
      const controller = new AbortController();
      terminalDetailAbortRef.current = controller;

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
        if (controller.signal.aborted) return;
        finishSubmissionFromDetail(detail);
      } catch (err) {
        if (controller.signal.aborted) return;
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
        if (terminalDetailAbortRef.current === controller) {
          terminalDetailAbortRef.current = null;
        }
      }
    },
    [finishSubmissionFromDetail],
  );

  const checkResultOnce = useCallback(async () => {
    if (!submission || checkingResult) return;
    setCheckingResult(true);
    setDetailFetchError('');
    try {
      const latest = await submissionApi.get(submission.id);
      setSubmission(latest);
      if (isTerminalSubmissionStatus(latest.status)) {
        finishSubmissionFromDetail(latest);
      } else {
        showToast(
          `Submission #${latest.id} is still ${verdictMeta(latest.status).label.toLowerCase()}.`,
          'success',
        );
      }
    } catch (err) {
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
      setCheckingResult(false);
    }
  }, [checkingResult, finishSubmissionFromDetail, showToast, submission]);

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
    if (!problem || submitting || isRunning()) return;
    if (!requireAuth('submit')) return;
    if (!online) {
      showToast('You appear to be offline', 'error');
      return;
    }
    if (!code.trim()) {
      showToast('Write some code before submitting', 'error');
      return;
    }

    setSubmitting(true);
    terminalDetailAbortRef.current?.abort();
    terminalDetailHandledRef.current = false;
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
