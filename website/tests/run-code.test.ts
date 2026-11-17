import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunCode as runCode } from '../src/features/problem-workspace/hooks/useRunCode';
import { ApiError, NetworkError, RUN_ENDPOINT, buildApiUrl, submissionApi } from '../src/lib/api';
import type { TestCase } from '../src/features/problem-workspace/types';
import type { CodeDiagnostic, RunResponse, RunTestCaseResult } from '../src/lib/types';

const react = vi.hoisted(() => ({ useState: vi.fn() }));
vi.mock('react', () => react);

const tests: TestCase[] = [
  {
    id: 'sample-1',
    kind: 'sample',
    name: 'Case 1',
    input: ' 1\n',
    expected: '',
    fromExample: true,
  },
  {
    id: 'custom-2',
    kind: 'custom',
    name: 'Custom 1',
    input: '2\n',
    expected: null,
    fromExample: false,
  },
];
const accepted: RunTestCaseResult = {
  id: 'sample-1',
  kind: 'sample',
  status: 'accepted',
  stdout: 'ok\n',
  stderr: '',
  expected_output: '',
  execution_time_ms: 2,
  memory_used_kb: 100,
  diagnostics: [],
};
const completed: RunResponse = {
  status: 'completed',
  compile_output: '',
  diagnostics: [],
  tests: [accepted],
};
const diagnostic: CodeDiagnostic = {
  kind: 'compile',
  severity: 'error',
  message: 'syntax error',
  line: 3,
  column: 1,
};
type Options = Parameters<typeof runCode>[0];
type ConsoleLine = { text: string; color: string };

// Runs the real async handler and state setters with explicit render snapshots.
// This is orchestration unit coverage, not React scheduling or browser E2E.
function fixture(overrides: Partial<Options> = {}, initialRunning = false) {
  let running = initialRunning;
  let runResult: RunResponse | null = completed;
  let consoleLines: ConsoleLine[] = [{ text: 'previous console', color: 'var(--code-fg)' }];
  const options: Options = {
    problem: { id: 42 },
    language: 'CPP',
    code: 'source code\n',
    tests,
    submitting: false,
    online: true,
    requireAuth: vi.fn(() => true),
    showToast: vi.fn(),
    onStart: vi.fn(),
    onResult: vi.fn(),
    onUnavailable: vi.fn(),
    ...overrides,
  };
  const setRunning = (next: boolean) => {
    running = next;
  };
  const setRunResult = (next: RunResponse | null) => {
    runResult = next;
  };
  const setConsoleLines = (next: ConsoleLine[]) => {
    consoleLines = next;
  };
  return {
    options,
    read: () => ({ running, runResult, consoleLines }),
    render(next: Partial<Options> = {}) {
      react.useState
        .mockReturnValueOnce([running, setRunning])
        .mockReturnValueOnce([runResult, setRunResult])
        .mockReturnValueOnce([consoleLines, setConsoleLines]);
      return runCode({ ...options, ...next });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(submissionApi, 'run').mockResolvedValue(completed);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('interactive Run Code orchestration', () => {
  it('preserves the exact HTTP body, cookies, content type and API envelope via the real client', async () => {
    vi.mocked(submissionApi.run).mockRestore();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 0, msg: 'ok', data: completed }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetch);
    const f = fixture();
    await f.render().run();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(buildApiUrl(RUN_ENDPOINT));
    expect(request).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(request.body))).toEqual({
      problem_id: 42,
      language: 'CPP',
      source_code: 'source code\n',
      testcases: [
        { id: 'sample-1', kind: 'sample', stdin: ' 1\n', expected_output: '' },
        { id: 'custom-2', kind: 'custom', stdin: '2\n', expected_output: null },
      ],
    });
    expect(f.read().runResult).toEqual(completed);
    expect(f.read().running).toBe(false);
  });

  it('does not start without a problem, authentication, connectivity or when Run/Submit is active', async () => {
    const deniedAuth = vi.fn(() => false);
    const scenarios = [
      fixture({ problem: null }),
      fixture({ requireAuth: deniedAuth }),
      fixture({ online: false }),
      fixture({ submitting: true }),
      fixture({}, true),
    ];
    for (const f of scenarios) {
      const before = f.read();
      await f.render().run();
      expect(f.read()).toEqual(before);
      expect(f.options.onStart).not.toHaveBeenCalled();
      expect(f.options.onResult).not.toHaveBeenCalled();
    }
    expect(submissionApi.run).not.toHaveBeenCalled();
    expect(deniedAuth).toHaveBeenCalledExactlyOnceWith('run code');
    expect(scenarios[2].options.showToast).toHaveBeenCalledExactlyOnceWith(
      'You appear to be offline',
      'error',
    );
    expect(scenarios[0].options.requireAuth).not.toHaveBeenCalled();
    expect(scenarios[3].options.requireAuth).not.toHaveBeenCalled();
  });

  it('sets running before the request and blocks another Run after the pending render', async () => {
    let finish!: (result: RunResponse) => void;
    vi.mocked(submissionApi.run).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture();
    const pending = f.render().run();
    expect(f.read().running).toBe(true);
    expect(f.read().runResult).toBe(completed);
    expect(f.read().consoleLines[0].text).toBe('previous console');
    expect(f.options.onStart).toHaveBeenCalledTimes(1);
    await f.render().run();
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    finish(completed);
    await pending;
    expect(f.read().running).toBe(false);
    expect(f.options.onResult).toHaveBeenCalledExactlyOnceWith(completed, []);
    expect(f.read().consoleLines).toEqual([
      { text: '[sample-1] stdout\nok\n', color: 'var(--code-fg)' },
    ]);
  });

  it('uses the latest render language, source and testcases without an extra request', async () => {
    const f = fixture();
    await f.render({ language: 'JAVA', code: 'new source', tests: [tests[1]] }).run();
    expect(submissionApi.run).toHaveBeenCalledExactlyOnceWith({
      problem_id: 42,
      language: 'JAVA',
      source_code: 'new source',
      testcases: [{ id: 'custom-2', kind: 'custom', stdin: '2\n', expected_output: null }],
    });
  });

  it('forwards compile failure diagnostics and produces the same compile console output', async () => {
    const result: RunResponse = {
      status: 'compile_error',
      compile_output: 'compiler failed\n',
      diagnostics: [diagnostic, diagnostic],
      tests: [],
    };
    vi.mocked(submissionApi.run).mockResolvedValue(result);
    const f = fixture();
    await f.render().run();
    expect(f.read()).toEqual({
      running: false,
      runResult: result,
      consoleLines: [{ text: 'compiler failed\n', color: 'var(--warn)' }],
    });
    expect(f.options.onResult).toHaveBeenCalledExactlyOnceWith(result, [diagnostic]);
  });

  it('forwards runtime failures and ordered diagnostics to the page for selection and line jumps', async () => {
    const runtime = { ...diagnostic, kind: 'runtime', testcase_id: 'custom-2' };
    const result: RunResponse = {
      ...completed,
      tests: [
        accepted,
        {
          ...accepted,
          id: 'custom-2',
          kind: 'custom',
          status: 'runtime_error',
          stdout: '',
          stderr: 'panic\n',
          diagnostics: [runtime],
        },
      ],
    };
    vi.mocked(submissionApi.run).mockResolvedValue(result);
    const f = fixture();
    await f.render().run();
    expect(f.options.onResult).toHaveBeenCalledExactlyOnceWith(result, [runtime]);
    expect(f.read().consoleLines).toEqual([
      { text: '[sample-1] stdout\nok\n', color: 'var(--code-fg)' },
      { text: '[custom-2] stderr\npanic\n', color: 'var(--error)' },
    ]);
    expect(f.read().running).toBe(false);
  });

  it('handles 404, 405 and 501 as unavailable, preserving messages and console transition', async () => {
    vi.stubEnv('NEXT_PUBLIC_RUN_ENDPOINT', '/custom/run');
    for (const status of [404, 405, 501]) {
      vi.mocked(submissionApi.run).mockRejectedValue(new ApiError('missing', status, status * 100));
      const f = fixture();
      await f.render().run();
      expect(f.options.showToast).toHaveBeenCalledExactlyOnceWith(
        'Custom runs are unavailable right now — use Submit',
        'error',
      );
      expect(f.read().consoleLines).toEqual([
        { text: `POST /custom/run → ${status}`, color: 'var(--text3)' },
        {
          text: 'Custom tests are unavailable right now. Submit runs the official test suite.',
          color: 'var(--warn)',
        },
      ]);
      expect(f.options.onUnavailable).toHaveBeenCalledTimes(1);
      expect(f.options.onResult).not.toHaveBeenCalled();
      expect(f.read().running).toBe(false);
      expect(f.read().runResult).toBe(completed);
    }
  });

  it('cleans up network and API errors without new retries or losing the previous result/console', async () => {
    const errors = [
      [
        new NetworkError(),
        'AstraCode is temporarily unreachable. Check your connection and try again.',
      ],
      [new ApiError('rate limited', 429, 42900), 'rate limited'],
      [new ApiError('', 400, 40000), 'Run failed'],
    ] as const;
    for (const [error, message] of errors) {
      vi.mocked(submissionApi.run).mockClear().mockRejectedValue(error);
      const f = fixture();
      const before = f.read();
      await f.render().run();
      expect(f.read()).toEqual(before);
      expect(f.options.showToast).toHaveBeenCalledExactlyOnceWith(message, 'error');
      expect(f.options.onResult).not.toHaveBeenCalled();
      expect(f.options.onUnavailable).not.toHaveBeenCalled();
      expect(submissionApi.run).toHaveBeenCalledTimes(1);
    }
  });

  it('retains the existing silent unknown-error path while clearing running', async () => {
    vi.mocked(submissionApi.run).mockRejectedValue(new Error('unexpected'));
    const f = fixture();
    await f.render().run();
    expect(f.read().running).toBe(false);
    expect(f.options.showToast).not.toHaveBeenCalled();
    expect(f.options.onResult).not.toHaveBeenCalled();
  });

  it('allows Submit to clear only the Run result while retaining console state', () => {
    const f = fixture();
    f.render().setRunResult(null);
    expect(f.read()).toEqual({
      running: false,
      runResult: null,
      consoleLines: [{ text: 'previous console', color: 'var(--code-fg)' }],
    });
    expect(submissionApi.run).not.toHaveBeenCalled();
  });
});
