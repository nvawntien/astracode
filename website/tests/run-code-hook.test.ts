// @vitest-environment jsdom

import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunCode } from '../src/features/problem-workspace/hooks/useRunCode';
import { ApiError, NetworkError, submissionApi } from '../src/lib/api';
import type { RunResponse } from '../src/lib/types';
import { deferred, renderReact } from './helpers/react-dom';

type Options = Parameters<typeof useRunCode>[0] & {
  slug: string;
  accountId: string | null;
  checkingResult: boolean;
};
let latest: ReturnType<typeof useRunCode>;
let view: Awaited<ReturnType<typeof renderReact>> | undefined;
const commits: string[] = [];
const result: RunResponse = {
  status: 'completed',
  compile_output: '',
  diagnostics: [
    { kind: 'runtime', severity: 'error', message: 'old diagnostic', line: 4, column: 1 },
  ],
  tests: [
    {
      id: 'custom-1',
      kind: 'custom',
      status: 'runtime_error',
      stdout: 'old stdout',
      stderr: 'old stderr',
      expected_output: null,
      execution_time_ms: 1,
      memory_used_kb: 100,
      diagnostics: [],
    },
  ],
};
function options(): Options {
  return {
    slug: 'problem-a',
    accountId: 'account-a',
    problem: { id: 1 },
    language: 'CPP',
    code: 'old source',
    tests: [
      {
        id: 'custom-1',
        kind: 'custom',
        name: 'Custom 1',
        input: '1\n',
        expected: null,
        fromExample: false,
      },
    ],
    submitting: false,
    checkingResult: false,
    online: true,
    requireAuth: vi.fn(() => true),
    showToast: vi.fn(),
    onStart: vi.fn(),
    onResult: vi.fn(),
    onUnavailable: vi.fn(),
  };
}
function Probe(props: Options) {
  latest = useRunCode(props);
  return createElement(
    'output',
    null,
    JSON.stringify({
      running: latest.running,
      result: latest.runResult,
      console: latest.consoleLines,
    }),
  );
}
function Observer(props: Options) {
  useLayoutEffect(() => {
    commits.push(document.querySelector('output')?.textContent ?? '');
  });
  return createElement(Probe, props);
}
function element(props: Options, strict = false) {
  const probe = createElement(Observer, props);
  return strict ? createElement(StrictMode, null, probe) : probe;
}
async function mount(props: Options, strict = false) {
  view = await renderReact(element(props, strict));
}
async function start() {
  let done!: Promise<void>;
  await act(async () => {
    done = latest.run();
  });
  return { done };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  commits.length = 0;
  vi.spyOn(submissionApi, 'run').mockResolvedValue(result);
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Run request scope and real React lifecycle', () => {
  it.each(['slug', 'problem ID', 'account', 'logout'] as const)(
    'rejects an old success after changing %s without remounting the hook',
    async (change) => {
      const props = options();
      const pending = deferred<RunResponse>();
      vi.mocked(submissionApi.run).mockReturnValue(pending.promise);
      await mount(props);
      const request = await start();
      const next = {
        ...props,
        ...(change === 'slug'
          ? { slug: 'problem-b' }
          : change === 'problem ID'
            ? { problem: { id: 2 } }
            : { accountId: change === 'logout' ? null : 'account-b' }),
      };
      await view!.rerender(element(next));
      await act(async () => {
        pending.resolve(result);
        await request.done;
      });
      expect(latest.runResult).toBeNull();
      expect(latest.consoleLines).toEqual([]);
      expect(latest.running).toBe(false);
      expect(props.onResult).not.toHaveBeenCalled();
      expect(props.onUnavailable).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
      expect(vi.mocked(submissionApi.run).mock.calls[0][1]?.aborted).toBe(true);
    },
  );

  it.each([
    result,
    new NetworkError(),
    new ApiError('missing', 501, 50100),
    new ApiError('denied', 403, 40300),
  ])(
    'keeps B busy and its callbacks untouched when obsolete A settles with %j',
    async (outcome) => {
      const props = options();
      const a = deferred<RunResponse>();
      const b = deferred<RunResponse>();
      vi.mocked(submissionApi.run).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
      await mount(props);
      const old = await start();
      const next = {
        ...props,
        slug: 'problem-b',
        problem: { id: 2 },
        accountId: 'account-b',
        onResult: vi.fn(),
        onStart: vi.fn(),
        onUnavailable: vi.fn(),
        showToast: vi.fn(),
      };
      await view!.rerender(element(next));
      const current = await start();
      expect(submissionApi.run).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (outcome instanceof Error) a.reject(outcome);
        else a.resolve(outcome);
        await old.done;
      });
      expect(latest.running).toBe(true);
      expect(latest.runResult).toBeNull();
      expect(latest.consoleLines).toEqual([]);
      expect(props.onResult).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
      expect(props.onUnavailable).not.toHaveBeenCalled();
      expect(next.onResult).not.toHaveBeenCalled();
      expect(next.showToast).not.toHaveBeenCalled();
      expect(next.onUnavailable).not.toHaveBeenCalled();
      expect(next.onStart).toHaveBeenCalledTimes(1);
      const final = { ...result, compile_output: 'current result' };
      await act(async () => {
        b.resolve(final);
        await current.done;
      });
      expect(latest.running).toBe(false);
      expect(latest.runResult).toEqual(final);
      expect(next.onResult).toHaveBeenCalledExactlyOnceWith(final, result.diagnostics);
    },
  );

  it('does not let an old result overwrite an already completed newer Run', async () => {
    const props = options();
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await mount(props);
    const old = await start();
    await view!.rerender(element({ ...props, slug: 'problem-b', problem: { id: 2 } }));
    await act(async () => latest.run());
    const current = latest.runResult;
    await act(async () => {
      pending.resolve({ ...result, compile_output: 'obsolete' });
      await old.done;
    });
    expect(latest.runResult).toBe(current);
    expect(props.onResult).toHaveBeenCalledTimes(1);
  });

  it.each(['account', 'problem'] as const)(
    'hides completed output before layout effects when %s changes',
    async (change) => {
      const props = options();
      await mount(props);
      await act(async () => latest.run());
      expect(view!.container.textContent).toContain('old stdout');
      await view!.rerender(
        element({
          ...props,
          ...(change === 'account'
            ? { accountId: 'account-b' }
            : { slug: 'problem-b', problem: { id: 2 } }),
        }),
      );
      expect(commits.at(-1)).not.toContain('old stdout');
      expect(commits.at(-1)).not.toContain('old diagnostic');
      expect(latest.runResult).toBeNull();
      expect(latest.consoleLines).toEqual([]);
    },
  );

  it('keeps same-scope source/language snapshots valid across edits and callback rerenders', async () => {
    const props = options();
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValue(pending.promise);
    await mount(props);
    const request = await start();
    const nextResult = vi.fn();
    await view!.rerender(
      element({ ...props, language: 'JAVA', code: 'new source', onResult: nextResult }),
    );
    expect(vi.mocked(submissionApi.run).mock.calls[0][1]?.aborted).toBe(false);
    expect(vi.mocked(submissionApi.run).mock.calls[0][0]).toMatchObject({
      language: 'CPP',
      source_code: 'old source',
    });
    await act(async () => {
      pending.resolve(result);
      await request.done;
    });
    expect(props.onResult).toHaveBeenCalledExactlyOnceWith(result, result.diagnostics);
    expect(nextResult).not.toHaveBeenCalled();
    expect(latest.runResult).toEqual(result);
  });

  it.each(['resolve', 'reject'] as const)(
    'invalidates pending work on unmount before a late %s',
    async (outcome) => {
      const props = options();
      const pending = deferred<RunResponse>();
      vi.mocked(submissionApi.run).mockReturnValue(pending.promise);
      await mount(props);
      const request = await start();
      const signal = vi.mocked(submissionApi.run).mock.calls[0][1];
      await view!.unmount();
      await act(async () => {
        if (outcome === 'resolve') pending.resolve(result);
        else pending.reject(new NetworkError());
        await request.done;
      });
      expect(signal?.aborted).toBe(true);
      expect(view!.container.textContent).toBe('');
      expect(props.onResult).not.toHaveBeenCalled();
      expect(props.showToast).not.toHaveBeenCalled();
    },
  );

  it('survives StrictMode replay and same-account refresh without duplicating or aborting a valid Run', async () => {
    const props = options();
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValue(pending.promise);
    await mount(props, true);
    const request = await start();
    await view!.rerender(element({ ...props }, true));
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submissionApi.run).mock.calls[0][1]?.aborted).toBe(false);
    await act(async () => {
      pending.resolve(result);
      await request.done;
    });
    expect(props.onResult).toHaveBeenCalledTimes(1);
    expect(latest.running).toBe(false);
  });

  it('blocks direct Run during manual checking and allows it after checking finishes', async () => {
    const props = { ...options(), checkingResult: true };
    await mount(props);
    await act(async () => latest.run());
    expect(submissionApi.run).not.toHaveBeenCalled();
    expect(props.requireAuth).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
    await view!.rerender(element({ ...props, checkingResult: false }));
    await act(async () => latest.run());
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate direct invocations before React flushes running state', async () => {
    const props = options();
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValue(pending.promise);
    await mount(props);
    const run = latest.run;
    await act(async () => {
      void run();
      void run();
    });
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(result));
    expect(props.onResult).toHaveBeenCalledTimes(1);
  });

  it('keeps guests unauthorized and permits a Run after login', async () => {
    const props = { ...options(), accountId: null, requireAuth: vi.fn(() => false) };
    await mount(props);
    await act(async () => latest.run());
    expect(props.requireAuth).toHaveBeenCalledExactlyOnceWith('run code');
    expect(submissionApi.run).not.toHaveBeenCalled();
    await view!.rerender(element(options()));
    await act(async () => latest.run());
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
  });
});
