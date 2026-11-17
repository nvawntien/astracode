import { isTerminalSubmissionStatus } from '../../lib/format';
import type { SubmissionStatus, SubmissionStreamEvent } from '../../lib/types';

export interface SubmissionStatusSnapshot {
  attemptId: string | null;
  status: SubmissionStatus;
  updatedAt: string;
}

// The stream validates attempt identity before this policy runs. A different
// attempt from a fresh connection snapshot starts an independent progression.
export function nextSubmissionStatus(
  current: SubmissionStatusSnapshot | null,
  event: SubmissionStreamEvent,
): SubmissionStatusSnapshot | null {
  const incomingTime = Date.parse(event.updated_at);
  const sameAttempt =
    current && (current.attemptId === null || current.attemptId === event.attempt_id);

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
    attemptId: event.attempt_id,
    status: event.status,
    updatedAt: Number.isFinite(incomingTime)
      ? event.updated_at
      : (current?.updatedAt ?? event.updated_at),
  };
}
