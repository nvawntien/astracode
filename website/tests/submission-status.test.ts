import { describe, expect, it } from 'vitest';
import {
  nextSubmissionStatus,
  type SubmissionStatusSnapshot,
} from '../src/features/problem-workspace/submissionStatus';
import type { SubmissionStatus, SubmissionStreamEvent } from '../src/lib/types';

const time = '2026-11-17T01:00:00Z';
const later = '2026-11-17T02:00:00Z';
const earlier = '2026-11-17T00:59:00Z';
const current: SubmissionStatusSnapshot = Object.freeze({
  attemptId: 'attempt-a',
  status: 'JUDGING',
  updatedAt: time,
});
function event(status: SubmissionStatus, updated_at = time): SubmissionStreamEvent {
  return { submission_id: 41, attempt_id: 'attempt-a', status, updated_at };
}

describe('submission status partial order', () => {
  it.each([earlier, time, later, '', 'invalid-time'])(
    'rejects JUDGING to PENDING regardless of wall-clock value %s',
    (timestamp) => expect(nextSubmissionStatus(current, event('PENDING', timestamp))).toBeNull(),
  );

  it.each([earlier, time, later, '', 'invalid-time'])(
    'preserves the first terminal advance even with timestamp %s',
    (timestamp) => {
      expect(nextSubmissionStatus(current, event('ACCEPTED', timestamp))).toEqual({
        attemptId: 'attempt-a',
        status: 'ACCEPTED',
        updatedAt: timestamp === '' || timestamp === 'invalid-time' ? time : timestamp,
      });
    },
  );

  it('permits direct PENDING to every defined terminal verdict without ranking verdicts', () => {
    const statuses: SubmissionStatus[] = [
      'ACCEPTED',
      'WRONG_ANSWER',
      'TIME_LIMIT_EXCEEDED',
      'MEMORY_LIMIT_EXCEEDED',
      'OUTPUT_LIMIT_EXCEEDED',
      'RUNTIME_ERROR',
      'COMPILATION_ERROR',
      'SYSTEM_ERROR',
    ];
    for (const status of statuses) {
      expect(nextSubmissionStatus({ ...current, status: 'PENDING' }, event(status))?.status).toBe(
        status,
      );
    }
  });

  it('keeps a same-attempt terminal immutable, including newer duplicate timestamps', () => {
    for (const status of ['PENDING', 'JUDGING', 'ACCEPTED', 'WRONG_ANSWER'] as const) {
      expect(
        nextSubmissionStatus({ ...current, status: 'ACCEPTED' }, event(status, later)),
      ).toBeNull();
    }
  });

  it('ignores duplicate, older, equal-instant, invalid and sub-millisecond same-status metadata', () => {
    for (const timestamp of [time, earlier, '2026-11-17T01:00:00+00:00', 'invalid-time']) {
      expect(nextSubmissionStatus(current, event('JUDGING', timestamp))).toBeNull();
    }
    expect(
      nextSubmissionStatus(
        { ...current, updatedAt: '2026-11-17T01:00:00.123456Z' },
        event('JUDGING', '2026-11-17T01:00:00.123457Z'),
      ),
    ).toBeNull();
  });

  it('accepts newer same-status metadata and repairs invalid metadata without mutating its input', () => {
    expect(nextSubmissionStatus(current, event('JUDGING', later))?.updatedAt).toBe(later);
    expect(
      nextSubmissionStatus({ ...current, updatedAt: 'invalid-time' }, event('JUDGING'))?.updatedAt,
    ).toBe(time);
    expect(current.updatedAt).toBe(time);
  });

  it('starts an independent progression for an already transport-validated new attempt', () => {
    expect(
      nextSubmissionStatus(
        { ...current, status: 'ACCEPTED' },
        {
          ...event('PENDING', earlier),
          attempt_id: 'attempt-b',
        },
      ),
    ).toEqual({ attemptId: 'attempt-b', status: 'PENDING', updatedAt: earlier });
  });
});

describe('HTTP status snapshots without attempt identity', () => {
  it('cannot infer a new attempt from HTTP PENDING and a newer clock value', () => {
    expect(nextSubmissionStatus(current, { status: 'PENDING', updated_at: later })).toBeNull();
  });

  it('accepts initial HTTP progression while leaving an unknown attempt unknown', () => {
    expect(nextSubmissionStatus(null, { status: 'JUDGING', updated_at: time })).toEqual({
      attemptId: null,
      status: 'JUDGING',
      updatedAt: time,
    });
  });

  it('preserves the known attempt on HTTP phase advances despite invalid timestamps', () => {
    expect(
      nextSubmissionStatus(
        { ...current, status: 'PENDING' },
        { status: 'JUDGING', updated_at: 'invalid-time' },
      ),
    ).toEqual(current);
  });

  it('ignores same-status duplicate, older, equal and invalid HTTP metadata', () => {
    for (const updated_at of [time, earlier, '2026-11-17T01:00:00+00:00', '', 'invalid-time']) {
      expect(nextSubmissionStatus(current, { status: 'JUDGING', updated_at })).toBeNull();
    }
  });

  it('accepts newer HTTP metadata without replacing attempt identity', () => {
    expect(nextSubmissionStatus(current, { status: 'JUDGING', updated_at: later })).toEqual({
      ...current,
      updatedAt: later,
    });
  });

  it('keeps an accepted terminal immutable for attempt-less status comparisons', () => {
    for (const status of ['PENDING', 'JUDGING', 'WRONG_ANSWER'] as const) {
      expect(
        nextSubmissionStatus({ ...current, status: 'ACCEPTED' }, { status, updated_at: later }),
      ).toBeNull();
    }
  });
});
