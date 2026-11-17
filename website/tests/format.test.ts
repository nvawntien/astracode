import { describe, expect, it } from 'vitest';
import {
  formatMemoryKb,
  formatRuntimeMs,
  formatTestcaseCount,
  formatTimeLimit,
  initials,
  isPendingStatus,
  isTerminalSubmissionStatus,
  verdictMeta,
} from '../src/lib/format';

describe('measurement formatting', () => {
  it('distinguishes missing measurements from measured zero', () => {
    expect(formatRuntimeMs(undefined)).toBe('—');
    expect(formatRuntimeMs(null)).toBe('—');
    expect(formatRuntimeMs(0)).toBe('0 ms');
    expect(formatMemoryKb(null)).toBe('—');
    expect(formatMemoryKb(0)).toBe('0 KB');
  });

  it('formats memory at the KB/MB and precision boundaries', () => {
    expect(formatMemoryKb(1023)).toBe('1023 KB');
    expect(formatMemoryKb(1024)).toBe('1.00 MB');
    expect(formatMemoryKb(10240)).toBe('10.0 MB');
  });

  it('preserves the existing mixed-unit problem time-limit convention', () => {
    expect(formatTimeLimit(0)).toBe('—');
    expect(formatTimeLimit(2)).toBe('2 s');
    expect(formatTimeLimit(50)).toBe('50 ms');
    expect(formatTimeLimit(1000)).toBe('1 s');
  });

  it('shows a zero pass count and requires both testcase measurements', () => {
    expect(formatTestcaseCount(0, 10)).toBe('0/10');
    expect(formatTestcaseCount(null, 10)).toBe('—');
    expect(formatTestcaseCount(3, undefined)).toBe('—');
  });
});

describe('display fallbacks', () => {
  it('uses first and last names and handles blank names without throwing', () => {
    expect(initials('  Ada   Byron Lovelace  ')).toBe('AL');
    expect(initials('Ada')).toBe('AD');
    expect(initials(null)).toBe('?');
    expect(initials(' ', 'NA')).toBe('NA');
  });

  it('distinguishes queued/judging, terminal failures and unknown statuses', () => {
    expect(isPendingStatus('PENDING')).toBe(true);
    expect(isPendingStatus('JUDGING')).toBe(true);
    expect(isPendingStatus('WRONG_ANSWER')).toBe(false);
    expect(isTerminalSubmissionStatus('ACCEPTED')).toBe(true);
    expect(isTerminalSubmissionStatus('WRONG_ANSWER')).toBe(true);
    expect(isTerminalSubmissionStatus('PENDING')).toBe(false);
    expect(isTerminalSubmissionStatus('FUTURE_STATUS')).toBe(false);
    expect(verdictMeta('FUTURE_STATUS').label).toBe('Unknown');
  });
});
