// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submissionApi } from '../src/lib/api';
import { useSubmissionStream } from '../src/lib/submission-stream';
import type { SubmissionStreamEvent, SubmissionStreamTicketResponse } from '../src/lib/types';
import { TestEventSource } from './helpers/event-source';
import { deferred, renderReact } from './helpers/react-dom';

type Options = Parameters<typeof useSubmissionStream>[0];
let latest: ReturnType<typeof useSubmissionStream>;
let view: Awaited<ReturnType<typeof renderReact>> | undefined;
const event: SubmissionStreamEvent = {
  submission_id: 41,
  attempt_id: 'fixture-attempt-a',
  status: 'JUDGING',
  updated_at: '2026-11-17T01:00:00Z',
};
const ticket = { ticket: 'fixture-ticket', expires_at: '2026-11-17T02:00:00Z' };

function Probe(options: Options) {
  latest = useSubmissionStream(options);
  return null;
}

function options(overrides: Partial<Options> = {}): Options {
  return {
    submissionId: 41,
    enabled: true,
    onStatus: vi.fn(),
    onTerminal: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

async function mount(props: Options, strict = false) {
  const probe = createElement(Probe, props);
  view = await renderReact(strict ? createElement(StrictMode, null, probe) : probe);
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', TestEventSource);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue(ticket);
  TestEventSource.instances = [];
});

afterEach(async () => {
  await view?.unmount();
  view = undefined;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('real React submission stream lifecycle', () => {
  it('stays idle when disabled and connects to the ticket URL when enabled', async () => {
    const props = options({ enabled: false });
    await mount(props);
    expect(latest.state).toBe('idle');
    expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
    await view!.rerender(createElement(Probe, { ...props, enabled: true }));
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledExactlyOnceWith(
      41,
      expect.any(AbortSignal),
    );
    const source = TestEventSource.instances[0];
    expect(source.url).toContain('/events/submissions/41?ticket=fixture-ticket');
    expect(latest.state).toBe('connecting');
    await act(async () => source.open());
    expect(latest.state).toBe('open');
  });

  it('rejects other submission IDs and stale attempts, and reads the latest callback after rerender', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const props = options();
    await mount(props);
    const source = TestEventSource.instances[0];
    await act(async () => {
      source.emit('submission.updated', { ...event, submission_id: 99 });
      source.emit('submission.snapshot', event);
      source.emit('submission.updated', { ...event, attempt_id: 'fixture-attempt-b' });
    });
    expect(props.onStatus).toHaveBeenCalledExactlyOnceWith(event);
    expect(warn).toHaveBeenCalledWith('ignored stale submission stream event', {
      submission_id: 41,
      status: 'JUDGING',
    });
    const onStatus = vi.fn();
    await view!.rerender(createElement(Probe, { ...props, onStatus }));
    await act(async () => source.emit('submission.updated', event));
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(event);
    expect(TestEventSource.instances).toHaveLength(1);
  });

  it('handles a terminal event once, even when duplicate events were queued before close', async () => {
    const props = options();
    await mount(props);
    const source = TestEventSource.instances[0];
    const terminal = { ...event, status: 'ACCEPTED' };
    await act(async () => {
      source.emit('submission.completed', terminal);
      source.emit('submission.completed', terminal);
      source.fail();
    });
    expect(props.onTerminal).toHaveBeenCalledExactlyOnceWith(terminal);
    // The existing raw handler still forwards duplicate status callbacks before complete() dedupes.
    expect(props.onStatus).toHaveBeenCalledTimes(2);
    expect(latest.state).toBe('completed');
    expect(source.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports malformed JSON and malformed contracts without an automatic retry', async () => {
    const props = options();
    await mount(props);
    await act(async () => TestEventSource.instances[0].raw('submission.updated', '{broken'));
    expect(latest.error).toEqual({
      kind: 'malformed_event',
      message: 'Live update payload was not valid JSON.',
    });
    expect(latest.state).toBe('error');
    expect(TestEventSource.instances[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => latest.reconnect());
    await act(async () =>
      TestEventSource.instances[1].emit('submission.updated', { ...event, status: 'UNKNOWN' }),
    );
    expect(latest.error).toEqual({
      kind: 'malformed_event',
      message: 'Live update payload did not match the contract.',
    });
    expect(props.onStatus).not.toHaveBeenCalled();
  });

  it('retries stream failures with the existing five backoff delays and then reports recovery state', async () => {
    const props = options();
    await mount(props);
    for (const [index, delay] of [1000, 2000, 4000, 8000, 10000].entries()) {
      await act(async () => TestEventSource.instances[index].fail());
      expect(latest.state).toBe('reconnecting');
      await advance(delay - 1);
      expect(TestEventSource.instances).toHaveLength(index + 1);
      await advance(1);
      expect(TestEventSource.instances).toHaveLength(index + 2);
    }
    await act(async () => TestEventSource.instances[5].fail());
    expect(latest.state).toBe('error');
    expect(props.onError).toHaveBeenCalledExactlyOnceWith({
      kind: 'stream',
      message: 'Live updates are unavailable.',
    });
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries ticket failures six total times, then supports explicit reconnect', async () => {
    vi.mocked(submissionApi.issueStreamTicket).mockRejectedValue(new Error('ticket unavailable'));
    const props = options();
    await mount(props);
    for (const delay of [1000, 2000, 4000, 8000, 10000]) await advance(delay);
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(6);
    expect(latest.state).toBe('error');
    expect(props.onError).toHaveBeenCalledExactlyOnceWith({
      kind: 'ticket',
      message: 'Could not request a live update ticket.',
    });
    vi.mocked(submissionApi.issueStreamTicket).mockResolvedValue(ticket);
    await act(async () => latest.reconnect());
    expect(TestEventSource.instances).toHaveLength(1);
    expect(latest.state).toBe('connecting');
    expect(latest.error).toBeNull();
  });

  it('aborts an outstanding ticket on unmount and ignores a late successful response', async () => {
    const pending = deferred<SubmissionStreamTicketResponse>();
    vi.mocked(submissionApi.issueStreamTicket).mockReturnValue(pending.promise);
    const props = options();
    await mount(props);
    const signal = vi.mocked(submissionApi.issueStreamTicket).mock.calls[0][1]!;
    await view!.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(ticket));
    expect(TestEventSource.instances).toHaveLength(0);
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('aborts a replaced ticket and ignores old-generation events after the tracked ID changes', async () => {
    const pending = deferred<SubmissionStreamTicketResponse>();
    vi.mocked(submissionApi.issueStreamTicket).mockReturnValueOnce(pending.promise);
    const props = options();
    await mount(props);
    const signal = vi.mocked(submissionApi.issueStreamTicket).mock.calls[0][1]!;
    await view!.rerender(createElement(Probe, { ...props, submissionId: 42 }));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.reject(new DOMException('aborted', 'AbortError')));
    const source = TestEventSource.instances[0];
    await view!.rerender(createElement(Probe, { ...props, submissionId: 43 }));
    await act(async () =>
      source.emit('submission.completed', { ...event, submission_id: 42, status: 'ACCEPTED' }),
    );
    expect(source.closed).toBe(true);
    expect(props.onTerminal).not.toHaveBeenCalled();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('clears reconnect timers on disable so they cannot create another stream', async () => {
    const props = options();
    await mount(props);
    await act(async () => TestEventSource.instances[0].fail());
    expect(vi.getTimerCount()).toBe(1);
    await view!.rerender(createElement(Probe, { ...props, enabled: false }));
    expect(vi.getTimerCount()).toBe(0);
    await advance(20000);
    expect(TestEventSource.instances).toHaveLength(1);
    expect(latest.state).toBe('idle');
  });

  it('survives StrictMode setup-cleanup-setup without duplicate live transports', async () => {
    const props = options();
    await mount(props, true);
    expect(submissionApi.issueStreamTicket).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(submissionApi.issueStreamTicket).mock.calls;
    expect(calls[0][1]!.aborted).toBe(true);
    expect(calls[1][1]!.aborted).toBe(false);
    expect(TestEventSource.instances).toHaveLength(1);
    await act(async () =>
      TestEventSource.instances[0].emit('submission.completed', { ...event, status: 'ACCEPTED' }),
    );
    expect(props.onTerminal).toHaveBeenCalledTimes(1);
  });
});
