import { isTerminalSubmissionStatus } from '../../lib/format';
import type { SubmissionStatus } from '../../lib/types';

export interface SubmissionStatusSnapshot {
  attemptId: string | null;
  status: SubmissionStatus;
  updatedAt: string;
}

interface SubmissionStatusUpdate {
  status: SubmissionStatus;
  updated_at: string;
  attempt_id?: string;
}

// The lifecycle validates attempt ownership before reconciliation. Only SSE
// may switch a pinned attempt. An initial owned HTTP read may establish one.
export function nextSubmissionStatus(
  current: SubmissionStatusSnapshot | null,
  event: SubmissionStatusUpdate,
): SubmissionStatusSnapshot | null {
  const incomingTime = Date.parse(event.updated_at);
  const sameAttempt =
    current &&
    (event.attempt_id === undefined ||
      current.attemptId === null ||
      current.attemptId === event.attempt_id);

  if (sameAttempt) {
    if (isTerminalSubmissionStatus(current.status)) return null;
    if (current.status === event.status) {
      const currentTime = Date.parse(current.updatedAt);
      if (
        !Number.isFinite(incomingTime) ||
        (Number.isFinite(currentTime) && incomingTime <= currentTime)
      )
        return null;
    } else {
      // Domain transitions, not a numeric verdict ranking: a same-attempt
      // terminal result is immutable; JUDGING can only advance to terminal.
      if (current.status === 'JUDGING' && event.status === 'PENDING') return null;
    }
  }

  // Wall-clock timestamps are not a sequence. Equal/skewed/invalid timestamps
  // must not suppress a valid phase advance (especially its first terminal).
  return {
    attemptId: event.attempt_id ?? current?.attemptId ?? null,
    status: event.status,
    updatedAt: Number.isFinite(incomingTime)
      ? event.updated_at
      : (current?.updatedAt ?? event.updated_at),
  };
}
