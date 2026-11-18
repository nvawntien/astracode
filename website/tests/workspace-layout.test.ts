// @vitest-environment jsdom

import { act, createElement, StrictMode, type ComponentProps, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspacePage from '../src/app/problems/[slug]/page';
import type { CodeEditor } from '../src/components/CodeEditor';
import type { ProblemPanel } from '../src/components/workspace/ProblemPanel';
import { ApiError, problemApi, submissionApi } from '../src/lib/api';
import { fetchProgress } from '../src/lib/progress';
import type {
  CreateSubmissionResponse,
  Me,
  Problem,
  RunResponse,
  Submission,
} from '../src/lib/types';
import { deferred, renderReact } from './helpers/react-dom';

// Keep the route, feature components, viewport hook and resize handlers real.
// Only page chrome, editor internals, problem content and network I/O are fixtures.
const observed = vi.hoisted(() => ({
  slug: 'layout-problem',
  push: vi.fn(),
  toast: vi.fn(),
  user: null as Me | null,
  editor: null as ComponentProps<typeof CodeEditor> | null,
  problem: null as ComponentProps<typeof ProblemPanel> | null,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: observed.slug }),
  useRouter: () => ({ push: observed.push }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ user: observed.user, loading: false }),
}));
vi.mock('@/components/ToastProvider', () => ({ useToast: () => ({ showToast: observed.toast }) }));
vi.mock('@/components/Header', () => ({ Header: () => null }));
vi.mock('@/components/CodeEditor', () => ({
  CodeEditor: (props: ComponentProps<typeof CodeEditor>) => {
    observed.editor = props;
    return createElement('textarea', {
      'aria-label': 'Layout fixture editor',
      value: props.value,
      readOnly: true,
    });
  },
}));
vi.mock('@/components/workspace/ProblemPanel', () => ({
  ProblemPanel: (props: ComponentProps<typeof ProblemPanel>) => {
    observed.problem = props;
    return createElement(
      'section',
      { 'data-testid': 'layout-problem' },
      props.problem.title,
      createElement(
        'button',
        { onClick: () => props.onUseExample('42\n', '84\n') },
        'Use fixture example',
      ),
      createElement(
        'button',
        { onClick: () => props.onUseSubmissionCode(detail) },
        'Restore fixture submission',
      ),
    );
  },
  ProblemPanelSkeleton: () => createElement('p', null, 'Loading layout fixture'),
  ProblemNotFound: () => createElement('p', null, 'Missing layout fixture'),
}));
vi.mock('@/lib/progress', () => ({ fetchProgress: vi.fn(), invalidateProgress: vi.fn() }));

const sourceCode = '// layout draft\n';
const user: Me = {
  id: 'layout-user',
  username: 'layout-user',
  full_name: 'Layout User',
  email: 'layout@example.test',
  role: 'user',
  rating: 0,
  is_active: true,
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
};
const problem: Problem = {
  id: 1,
  slug: 'layout-problem',
  title: 'Layout problem',
  description: '',
  input_format: '',
  output_format: '',
  difficulty: 'easy',
  time_limit: 1,
  memory_limit: 128,
  created_at: '2026-11-17T00:00:00Z',
  examples: [{ input: '1', expected_output: '2' }],
};
const created: CreateSubmissionResponse = {
  id: 41,
  problem_id: 1,
  problem_title: problem.title,
  language: 'CPP',
  status: 'ACCEPTED',
  created_at: '2026-11-17T01:00:00Z',
};
const detail: Submission = {
  ...created,
  user_id: 'layout-user',
  username: 'layout-user',
  source_code: sourceCode,
  execution_time_ms: 1,
  memory_used_kb: 100,
  passed_testcases: 1,
  total_testcases: 1,
  compile_output: null,
  error_message: null,
  updated_at: created.created_at,
};
const runResult: RunResponse = {
  status: 'completed',
  tests: [],
  diagnostics: [],
  compile_output: '',
};
type Mode = 'h' | 'v';
let view: Awaited<ReturnType<typeof renderReact>> | undefined;
let rect: DOMRect;
let originalWidth: PropertyDescriptor;
let originalSelection: string;

function box(left = 100, width = 1000, bottom = 800, height = 720): DOMRect {
  return {
    left,
    width,
    bottom,
    height,
    x: left,
    y: bottom - height,
    top: bottom - height,
    right: left + width,
    toJSON: () => ({ left, width, bottom, height }),
  };
}
function shell() {
  return view!.container.querySelector('main')!.lastElementChild as HTMLElement;
}
function problemPane() {
  return view!.container.querySelector('[data-testid="layout-problem"]')?.parentElement;
}
function editorPane() {
  return view!.container.querySelector('.ac-workspace-editor-toolbar')?.parentElement;
}
function separator(mode: Mode) {
  const element = view!.container.querySelector<HTMLElement>(
    `[role="separator"][aria-orientation="${mode === 'h' ? 'vertical' : 'horizontal'}"]`,
  );
  expect(element).not.toBeNull();
  return element!;
}
function bottomPanel() {
  return separator('v').nextElementSibling as HTMLElement;
}
function findButton(name: string | RegExp) {
  return [...view!.container.querySelectorAll('button')].find((button) => {
    const label = button.getAttribute('aria-label') ?? button.textContent!.trim();
    return typeof name === 'string' ? label === name : name.test(label);
  });
}
async function click(name: string | RegExp) {
  const button = findButton(name);
  expect(button, `button ${String(name)}`).toBeDefined();
  await act(async () => button!.click());
}
function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}
async function resize(width: number) {
  await act(async () => {
    setViewport(width);
    window.dispatchEvent(new Event('resize'));
  });
}
async function mount(width = 1280, strict = false) {
  setViewport(width);
  const page = createElement(WorkspacePage);
  view = await renderReact(strict ? createElement(StrictMode, null, page) : page);
  expect(view.container.querySelector('main')).not.toBeNull();
  return { measure: vi.spyOn(shell(), 'getBoundingClientRect').mockImplementation(() => rect) };
}
async function start(mode: Mode) {
  const event = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
  });
  await act(async () => separator(mode).dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}
async function move(clientX: number, clientY = 450, buttons = 1) {
  await act(async () =>
    window.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, buttons })),
  );
}
async function release() {
  // The target is the window, outside either separator.
  await act(async () => window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0 })));
}
async function reset(mode: Mode) {
  await act(async () =>
    separator(mode).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
  );
}
async function press(mode: Mode, key: string, options: KeyboardEventInit = {}) {
  const element = separator(mode);
  element.focus();
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await act(async () => element.dispatchEvent(event));
  return event;
}
function expectResizeValue(mode: Mode, value: number) {
  const element = separator(mode);
  expect(element.getAttribute('aria-valuenow')).toBe(String(value));
  expect(element.getAttribute('aria-valuemin')).toBe(mode === 'h' ? '30' : '120');
  expect(element.getAttribute('aria-valuemax')).toBe(mode === 'h' ? '68' : '520');
  expect(element.getAttribute('aria-valuetext')).toBe(
    mode === 'h' ? `${value}% left pane width` : `${value} pixels when expanded`,
  );
  const controlled = document.getElementById(element.getAttribute('aria-controls')!);
  expect(controlled).toBe(mode === 'h' ? problemPane() : bottomPanel());
}
function expectSelected(name: string | RegExp) {
  expect(findButton(name)?.getAttribute('aria-selected')).toBe('true');
}

function trackListeners() {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  return {
    active(type: string) {
      const events = [
        ...add.mock.calls.flatMap((call, i) =>
          call[0] === type
            ? [{ callback: call[1], add: true, order: add.mock.invocationCallOrder[i] }]
            : [],
        ),
        ...remove.mock.calls.flatMap((call, i) =>
          call[0] === type
            ? [{ callback: call[1], add: false, order: remove.mock.invocationCallOrder[i] }]
            : [],
        ),
      ].sort((a, b) => a.order - b.order);
      const active = new Set<unknown>();
      for (const event of events) {
        if (event.add) active.add(event.callback);
        else active.delete(event.callback);
      }
      return active;
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const domWindow = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
  vi.stubGlobal('localStorage', domWindow.localStorage);
  vi.stubGlobal('sessionStorage', domWindow.sessionStorage);
  originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')!;
  originalSelection = document.body.style.userSelect;
  document.body.style.userSelect = '';
  rect = box();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('astra-lang', 'CPP');
  localStorage.setItem('astra-draft:1:CPP', sourceCode);
  observed.slug = problem.slug;
  observed.user = user;
  observed.editor = observed.problem = null;
  vi.spyOn(problemApi, 'bySlug').mockResolvedValue(problem);
  vi.spyOn(submissionApi, 'run').mockResolvedValue(runResult);
  vi.spyOn(submissionApi, 'create').mockRejectedValue(
    new ApiError('fixture create stopped', 503, 50300),
  );
  vi.spyOn(submissionApi, 'get').mockResolvedValue(detail);
  vi.spyOn(submissionApi, 'issueStreamTicket').mockResolvedValue({
    ticket: 'unused-layout-ticket',
    expires_at: '',
  });
  vi.mocked(fetchProgress).mockResolvedValue({
    submissions: [],
    solvedIds: new Set(),
    attemptedIds: new Set(),
    truncated: false,
  });
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(async () => {
  try {
    await view?.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view = undefined;
    document.body.style.userSelect = originalSelection;
    Object.defineProperty(window, 'innerWidth', originalWidth);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('workspace geometry and session persistence', () => {
  it('starts at 52/48 and 235px, with the Tests panel open', async () => {
    await mount();
    expect(problemPane()?.style.width).toBe('52%');
    expect(editorPane()?.style.width).toBe('48%');
    expect(bottomPanel().style.height).toBe('235px');
    expect(bottomPanel().style.maxHeight).toBe('60%');
    expectSelected('Tests (1)');
    expect(findButton('Collapse panel')?.getAttribute('aria-expanded')).toBe('true');
    expect(sessionStorage.getItem('astra-split')).toBeNull();
    expect(sessionStorage.getItem('astra-bottom')).toBeNull();
  });

  it.each([
    ['30', '120'],
    ['68', '520'],
    ['61.5', '333'],
  ])('restores inclusive and fractional stored geometry %s/%s', async (split, bottom) => {
    sessionStorage.setItem('astra-split', split);
    sessionStorage.setItem('astra-bottom', bottom);
    await mount();
    expect(problemPane()?.style.width).toBe(`${split}%`);
    expect(editorPane()?.style.width).toBe(`${100 - Number(split)}%`);
    expect(bottomPanel().style.height).toBe(`${bottom}px`);
  });

  it.each([
    ['29', '119'],
    ['69', '521'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('ignores out-of-range or non-finite stored geometry %s/%s', async (split, bottom) => {
    sessionStorage.setItem('astra-split', split);
    sessionStorage.setItem('astra-bottom', bottom);
    await mount();
    expect(problemPane()?.style.width).toBe('52%');
    expect(bottomPanel().style.height).toBe('235px');
  });

  it('uses container-relative horizontal coordinates and releases outside the separator', async () => {
    const { measure } = await mount();
    await move(700);
    expect(measure).not.toHaveBeenCalled();
    await start('h');
    expect(document.body.style.userSelect).toBe('none');
    await move(700);
    expect(problemPane()?.style.width).toBe('60%');
    expect(editorPane()?.style.width).toBe('40%');
    expect(sessionStorage.getItem('astra-split')).toBeNull();
    await release();
    expect(document.body.style.userSelect).toBe('');
    expect(sessionStorage.getItem('astra-split')).toBe('60');
    expect(sessionStorage.getItem('astra-bottom')).toBe('235');
    await move(400, 450, 0);
    expect(problemPane()?.style.width).toBe('60%');
    expect(measure).toHaveBeenCalledTimes(1);
    expect(observed.push).not.toHaveBeenCalled();
    expect(observed.editor?.value).toBe(sourceCode);
    expect(submissionApi.run).not.toHaveBeenCalled();
    expect(submissionApi.create).not.toHaveBeenCalled();
  });

  it('clamps horizontal drag to 30–68 across sequential drags', async () => {
    await mount();
    await start('h');
    await move(-1000);
    expect(problemPane()?.style.width).toBe('30%');
    expect(editorPane()?.style.width).toBe('70%');
    await release();
    await start('h');
    await move(5000);
    expect(problemPane()?.style.width).toBe('68%');
    expect(editorPane()?.style.width).toBe('32%');
    await release();
    expect(sessionStorage.getItem('astra-split')).toBe('68');
  });

  it('uses shell bottom coordinates and clamps vertical drag to 120–520px', async () => {
    await mount();
    await start('v');
    await move(0, 450);
    expect(bottomPanel().style.height).toBe('350px');
    await move(0, 1000);
    expect(bottomPanel().style.height).toBe('120px');
    await move(0, -1000);
    expect(bottomPanel().style.height).toBe('520px');
    await release();
    expect(problemPane()?.style.width).toBe('52%');
    expect(sessionStorage.getItem('astra-bottom')).toBe('520');
  });

  it('persists both final dimensions across a real unmount/remount', async () => {
    await mount();
    await start('h');
    await move(700);
    await release();
    await start('v');
    await move(0, 450);
    await release();
    await click('Console');
    await click('Collapse panel');
    await click('Full-width editor');
    await view!.unmount();
    await mount();
    expect(problemPane()?.style.width).toBe('60%');
    expect(editorPane()?.style.width).toBe('40%');
    expect(bottomPanel().style.height).toBe('350px');
    expectSelected('Tests (1)');
    expect(findButton('Full-width editor')?.getAttribute('aria-pressed')).toBe('false');
  });

  it.each<Mode>(['h', 'v'])(
    'persists the %s double-click default immediately without changing the other dimension',
    async (mode) => {
      sessionStorage.setItem('astra-split', '60');
      sessionStorage.setItem('astra-bottom', '333');
      await mount();
      // Browser double-clicks follow two press/release cycles.
      await start(mode);
      await release();
      await start(mode);
      await release();
      await reset(mode);
      expect(mode === 'h' ? problemPane()?.style.width : bottomPanel().style.height).toBe(
        mode === 'h' ? '52%' : '235px',
      );
      expect(sessionStorage.getItem('astra-split')).toBe(mode === 'h' ? '52' : '60');
      expect(sessionStorage.getItem('astra-bottom')).toBe(mode === 'v' ? '235' : '333');
      await view!.unmount();
      await mount();
      expect(problemPane()?.style.width).toBe(mode === 'h' ? '52%' : '60%');
      expect(bottomPanel().style.height).toBe(mode === 'v' ? '235px' : '333px');
    },
  );

  it('persists the latest split when move and release share one React batch', async () => {
    await mount();
    await start('h');
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, buttons: 1 }));
      window.dispatchEvent(new MouseEvent('mouseup', { buttons: 0 }));
    });
    expect(problemPane()?.style.width).toBe('60%');
    expect(sessionStorage.getItem('astra-split')).toBe('60');
    expect(document.body.style.userSelect).toBe('');
  });

  it('keeps editing and resizing usable when sessionStorage reads and writes fail', async () => {
    const prototype = Object.getPrototypeOf(sessionStorage) as Storage;
    const read = prototype.getItem as Storage['getItem'];
    const write = prototype.setItem as Storage['setItem'];
    vi.spyOn(prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (this === sessionStorage) throw new Error('fixture storage unavailable');
      return read.call(this, key);
    });
    vi.spyOn(prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === sessionStorage) throw new Error('fixture storage unavailable');
      return write.call(this, key, value);
    });
    await mount();
    expect(problemPane()?.style.width).toBe('52%');
    await start('h');
    await move(700);
    await release();
    expect(problemPane()?.style.width).toBe('60%');
    expect(observed.editor?.value).toBe(sourceCode);
  });
});

describe('workspace geometry drag correctness', () => {
  it.each([false, true])(
    'restores the original inline selection across rerenders, repeated starts and unmount (StrictMode=%s)',
    async (strict) => {
      document.body.style.userSelect = 'text';
      const listeners = trackListeners();
      await mount(1280, strict);
      await start('h');
      await move(700);
      await start('h');
      const page = createElement(WorkspacePage);
      await view!.rerender(strict ? createElement(StrictMode, null, page) : page);
      expect(document.body.style.userSelect).toBe('none');
      await move(600);
      expect(problemPane()?.style.width).toBe('50%');
      await release();
      expect(document.body.style.userSelect).toBe('text');
      await start('v');
      await move(0, 450);
      expect(document.body.style.userSelect).toBe('none');
      await release();
      expect(document.body.style.userSelect).toBe('text');
      await start('v');
      await view!.unmount();
      expect(document.body.style.userSelect).toBe('text');
      for (const type of ['mousemove', 'mouseup', 'blur'])
        expect(listeners.active(type).size).toBe(0);
      await move(500);
      await release();
      expect(document.body.style.userSelect).toBe('text');
    },
  );

  it('captures the current inline selection separately for each new drag session', async () => {
    document.body.style.userSelect = 'text';
    await mount();
    await start('h');
    await release();
    expect(document.body.style.userSelect).toBe('text');
    document.body.style.userSelect = 'all';
    await start('v');
    await release();
    expect(document.body.style.userSelect).toBe('all');
  });

  it('persists the latest bottom height when move and release share one React batch', async () => {
    await mount();
    await start('v');
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 450, buttons: 1 }));
      window.dispatchEvent(new MouseEvent('mouseup', { buttons: 0 }));
    });
    expect(bottomPanel().style.height).toBe('350px');
    expect(sessionStorage.getItem('astra-bottom')).toBe('350');
    expect(sessionStorage.getItem('astra-split')).toBe('52');
  });

  it.each([
    { mode: 'h' as const, positions: [700, -1000, 5000], expected: 68 },
    { mode: 'h' as const, positions: [700, 5000, -1000], expected: 30 },
    { mode: 'v' as const, positions: [450, 1000, -1000], expected: 520 },
    { mode: 'v' as const, positions: [450, -1000, 1000], expected: 120 },
  ])(
    'persists the final clamped $mode value $expected after multiple batched moves',
    async ({ mode, positions, expected }) => {
      sessionStorage.setItem('astra-split', '60');
      sessionStorage.setItem('astra-bottom', '333');
      await mount();
      await start(mode);
      await act(async () => {
        for (const position of positions) {
          window.dispatchEvent(
            new MouseEvent('mousemove', {
              clientX: mode === 'h' ? position : 0,
              clientY: mode === 'v' ? position : 450,
              buttons: 1,
            }),
          );
        }
        window.dispatchEvent(new MouseEvent('mouseup', { buttons: 0 }));
      });
      expect(problemPane()?.style.width).toBe(mode === 'h' ? `${expected}%` : '60%');
      expect(bottomPanel().style.height).toBe(mode === 'v' ? `${expected}px` : '333px');
      expect(sessionStorage.getItem('astra-split')).toBe(mode === 'h' ? String(expected) : '60');
      expect(sessionStorage.getItem('astra-bottom')).toBe(mode === 'v' ? String(expected) : '333');
    },
  );

  it('keeps both dimensions current across sequential drag sessions within one batch', async () => {
    await mount();
    await act(async () => {
      separator('h').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, buttons: 1 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      separator('v').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 450, buttons: 1 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(problemPane()?.style.width).toBe('60%');
    expect(bottomPanel().style.height).toBe('350px');
    expect(sessionStorage.getItem('astra-split')).toBe('60');
    expect(sessionStorage.getItem('astra-bottom')).toBe('350');
  });

  it('writes geometry only on active completion or reset, never on unrelated rerenders or idle events', async () => {
    await mount();
    const write = vi.spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem');
    const writes = () =>
      write.mock.calls.filter(
        ([key]) => key.startsWith('astra-split') || key.startsWith('astra-bottom'),
      );
    await start('h');
    await move(700);
    await view!.rerender(createElement(WorkspacePage));
    expect(writes()).toEqual([]);
    await release();
    expect(writes()).toEqual([
      ['astra-split', '60'],
      ['astra-bottom', '235'],
    ]);
    await release();
    await act(async () => window.dispatchEvent(new Event('blur')));
    await view!.rerender(createElement(WorkspacePage));
    expect(writes()).toHaveLength(2);
    await reset('h');
    expect(writes()).toEqual([
      ['astra-split', '60'],
      ['astra-bottom', '235'],
      ['astra-split', '52'],
    ]);
    await view!.unmount();
    expect(writes()).toHaveLength(3);
  });

  it.each<Mode>(['h', 'v'])(
    'keeps the %s reset authoritative over queued move/release callbacks',
    async (mode) => {
      sessionStorage.setItem('astra-split', '60');
      sessionStorage.setItem('astra-bottom', '333');
      document.body.style.userSelect = 'all';
      await mount();
      const write = vi.spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem');
      await start(mode);
      await act(async () => {
        window.dispatchEvent(
          new MouseEvent('mousemove', { clientX: 780, clientY: 280, buttons: 1 }),
        );
        separator(mode).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        window.dispatchEvent(
          new MouseEvent('mousemove', { clientX: 400, clientY: 450, buttons: 1 }),
        );
        window.dispatchEvent(new MouseEvent('mouseup'));
      });
      expect(problemPane()?.style.width).toBe(mode === 'h' ? '52%' : '60%');
      expect(bottomPanel().style.height).toBe(mode === 'v' ? '235px' : '333px');
      expect(sessionStorage.getItem('astra-split')).toBe(mode === 'h' ? '52' : '60');
      expect(sessionStorage.getItem('astra-bottom')).toBe(mode === 'v' ? '235' : '333');
      expect(
        write.mock.calls.filter(([key]) => key === 'astra-split' || key === 'astra-bottom'),
      ).toEqual([mode === 'h' ? ['astra-split', '52'] : ['astra-bottom', '235']]);
      expect(document.body.style.userSelect).toBe('all');
      // A new drag must retain the reset value in the independent dimension.
      await start(mode === 'h' ? 'v' : 'h');
      await move(700, 450);
      await release();
      expect(problemPane()?.style.width).toBe(mode === 'h' ? '52%' : '60%');
      expect(bottomPanel().style.height).toBe(mode === 'v' ? '235px' : '350px');
      expect(sessionStorage.getItem('astra-split')).toBe(mode === 'h' ? '52' : '60');
      expect(sessionStorage.getItem('astra-bottom')).toBe(mode === 'v' ? '235' : '350');
    },
  );

  it.each<Mode>(['h', 'v'])(
    'visually resets %s even when sessionStorage writes fail',
    async (mode) => {
      sessionStorage.setItem('astra-split', '60');
      sessionStorage.setItem('astra-bottom', '333');
      await mount();
      const prototype = Object.getPrototypeOf(sessionStorage) as Storage;
      const write = prototype.setItem;
      vi.spyOn(prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (this === sessionStorage) throw new Error('fixture storage unavailable');
        return write.call(this, key, value);
      });
      await start(mode);
      await reset(mode);
      await release();
      expect(problemPane()?.style.width).toBe(mode === 'h' ? '52%' : '60%');
      expect(bottomPanel().style.height).toBe(mode === 'v' ? '235px' : '333px');
      expect(document.body.style.userSelect).toBe('');
    },
  );

  it.each<Mode>(['h', 'v'])(
    'ends %s drag on blur, persists once and permits a new session',
    async (mode) => {
      document.body.style.userSelect = 'all';
      await mount();
      const write = vi.spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem');
      const writes = () =>
        write.mock.calls.filter(([key]) => key === 'astra-split' || key === 'astra-bottom');
      await start(mode);
      await act(async () => {
        window.dispatchEvent(
          new MouseEvent('mousemove', { clientX: 700, clientY: 450, buttons: 1 }),
        );
        window.dispatchEvent(new Event('blur'));
      });
      expect(document.body.style.userSelect).toBe('all');
      expect(problemPane()?.style.width).toBe(mode === 'h' ? '60%' : '52%');
      expect(bottomPanel().style.height).toBe(mode === 'v' ? '350px' : '235px');
      expect(writes()).toEqual([
        ['astra-split', mode === 'h' ? '60' : '52'],
        ['astra-bottom', mode === 'v' ? '350' : '235'],
      ]);
      await move(400, 600, 0);
      await release();
      await act(async () => window.dispatchEvent(new Event('blur')));
      expect(problemPane()?.style.width).toBe(mode === 'h' ? '60%' : '52%');
      expect(bottomPanel().style.height).toBe(mode === 'v' ? '350px' : '235px');
      expect(writes()).toHaveLength(2);
      await start(mode);
      await move(600, 500);
      await release();
      expect(document.body.style.userSelect).toBe('all');
      expect(sessionStorage.getItem('astra-split')).toBe(mode === 'h' ? '50' : '52');
      expect(sessionStorage.getItem('astra-bottom')).toBe(mode === 'v' ? '300' : '235');
      await view!.unmount();
      expect(writes()).toHaveLength(4);
    },
  );

  it('leaves selection and storage unchanged when the window blurs without an active drag', async () => {
    document.body.style.userSelect = 'text';
    await mount();
    const write = vi.spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem');
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(document.body.style.userSelect).toBe('text');
    expect(sessionStorage.getItem('astra-split')).toBeNull();
    expect(sessionStorage.getItem('astra-bottom')).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(problemPane()?.style.width).toBe('52%');
  });

  it('ends drag and restores selection on blur even when persistence fails', async () => {
    document.body.style.userSelect = 'text';
    await mount();
    const prototype = Object.getPrototypeOf(sessionStorage) as Storage;
    const write = prototype.setItem;
    vi.spyOn(prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === sessionStorage) throw new Error('fixture storage unavailable');
      return write.call(this, key, value);
    });
    await start('h');
    await move(700);
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(document.body.style.userSelect).toBe('text');
    await move(400);
    expect(problemPane()?.style.width).toBe('60%');
  });
});

describe('workspace responsive and display state', () => {
  it.each([1280, 1020, 1019, 760, 759])(
    'uses the exact responsive regime at %spx',
    async (width) => {
      await mount(width);
      if (width >= 1020) {
        expect(problemPane()?.style.width).toBe('52%');
        expect(editorPane()?.style.width).toBe('48%');
        expect(findButton('Full-width editor')).toBeDefined();
        expect(view!.container.querySelector('[aria-label="Workspace views"]')).toBeNull();
      } else {
        expectSelected('Problem');
        expect(problemPane()?.style.width).toBe('100%');
        expect(editorPane()).toBeUndefined();
        await click('Code');
        expectSelected('Code');
        expect(problemPane()).toBeUndefined();
        expect(editorPane()?.style.width).toBe('100%');
        expect(findButton('Full-width editor')).toBeUndefined();
      }
      expect(findButton('Run')?.style.minHeight).toBe(width < 760 ? '44px' : '');
      expect(Boolean(findButton('Collapse panel'))).toBe(width >= 760);
    },
  );

  it('preserves mobile view, code and stored split while crossing desktop/stacked boundaries', async () => {
    await mount(900);
    await click('Code');
    await act(async () => observed.editor!.onChange('// edited layout draft'));
    await resize(1280);
    expect(problemPane()?.style.width).toBe('52%');
    expect(editorPane()?.style.width).toBe('48%');
    await resize(900);
    expectSelected('Code');
    expect(editorPane()?.style.width).toBe('100%');
    expect(observed.editor?.value).toBe('// edited layout draft');
    await click('Problem');
    await resize(1280);
    await resize(900);
    expectSelected('Problem');
    expect(editorPane()).toBeUndefined();
    expect(problemApi.bySlug).toHaveBeenCalledTimes(1);
    expect(observed.push).not.toHaveBeenCalled();
  });

  it('uses updated geometry and retains the active drag when its separator disappears on resize', async () => {
    await mount();
    await start('h');
    await move(700);
    rect = box(20, 800, 650);
    await resize(900);
    expect(view!.container.querySelector('[aria-orientation="vertical"]')).toBeNull();
    expect(document.body.style.userSelect).toBe('none');
    await move(420);
    await release();
    expect(sessionStorage.getItem('astra-split')).toBe('50');
    await resize(1280);
    expect(problemPane()?.style.width).toBe('50%');
    expect(editorPane()?.style.width).toBe('50%');
  });

  it('uses the resized shell bottom for a vertical drag rather than retaining its previous measurement', async () => {
    await mount();
    await start('v');
    await move(0, 450);
    expect(bottomPanel().style.height).toBe('350px');
    rect = box(100, 1000, 600, 520);
    await resize(1100);
    await move(0, 450);
    expect(bottomPanel().style.height).toBe('150px');
    await release();
    expect(sessionStorage.getItem('astra-bottom')).toBe('150');
  });

  it('enters and exits the desktop full-width editor without resetting geometry', async () => {
    sessionStorage.setItem('astra-split', '60');
    sessionStorage.setItem('astra-bottom', '333');
    await mount();
    await click('Full-width editor');
    expect(problemPane()).toBeUndefined();
    expect(editorPane()?.style.width).toBe('100%');
    expect(findButton('Exit full-width editor')?.getAttribute('aria-pressed')).toBe('true');
    expect(view!.container.querySelector('[aria-orientation="vertical"]')).toBeNull();
    expect(bottomPanel().style.height).toBe('333px');
    expect(document.fullscreenElement ?? null).toBeNull();
    await click('Exit full-width editor');
    expect(problemPane()?.style.width).toBe('60%');
    expect(editorPane()?.style.width).toBe('40%');
  });

  it('keeps Exit full-width editor available after stacked resize and restores the selected responsive view', async () => {
    await mount();
    await click('Full-width editor');
    await resize(759);
    expectSelected('Code');
    expect(problemPane()).toBeUndefined();
    expect(editorPane()?.style.width).toBe('100%');
    expect(findButton('Exit full-width editor')).toBeDefined();
    await click('Exit full-width editor');
    expect(problemPane()?.style.width).toBe('100%');
    expect(editorPane()).toBeUndefined();
    await click('Code');
    expect(editorPane()?.style.width).toBe('100%');
    await click('Problem');
    expect(problemPane()).toBeDefined();
    await resize(1020);
    expect(problemPane()?.style.width).toBe('52%');
  });

  it('collapses to 39px and reopens the retained height; selecting any bottom tab opens it', async () => {
    sessionStorage.setItem('astra-bottom', '333');
    await mount();
    for (const tab of ['Console', 'Result', 'Tests (1)']) {
      await click('Collapse panel');
      expect(bottomPanel().style.height).toBe('39px');
      expect(findButton('Expand panel')?.getAttribute('aria-expanded')).toBe('false');
      expect(view!.container.querySelector('[aria-label="Test input for Case 1"]')).toBeNull();
      await click(tab);
      expectSelected(tab);
      expect(bottomPanel().style.height).toBe('333px');
    }
    await click('Collapse panel');
    await click('Expand panel');
    expect(bottomPanel().style.height).toBe('333px');
  });

  it('keeps tab contents distinct and preserves collapsed state on mobile until a tab is chosen', async () => {
    await mount();
    expect(view!.container.querySelector('[aria-label="Test input for Case 1"]')).not.toBeNull();
    await click('Console');
    expect(view!.container.textContent).toContain('Run your code to see program output');
    await click('Result');
    expect(view!.container.textContent).toContain('Run your code against the test cases');
    await click('Collapse panel');
    await resize(700);
    await click('Code');
    expect(bottomPanel().style.height).toBe('39px');
    expect(findButton('Expand panel')).toBeUndefined();
    await click('Console');
    expect(bottomPanel().style.height).toBe('235px');
    expectSelected('Console');
  });
});

describe('workspace fullscreen responsive accessibility', () => {
  it.each([900, 700])(
    'lets explicit Problem navigation leave fullscreen without losing the draft (%spx)',
    async (width) => {
      await mount();
      await click('Full-width editor');
      await resize(width);
      expect(findButton('Exit full-width editor')).toBeDefined();
      await click('Problem');
      expectSelected('Problem');
      expect(problemPane()?.style.width).toBe('100%');
      expect(editorPane()).toBeUndefined();
      await click('Code');
      expectSelected('Code');
      expect(editorPane()?.style.width).toBe('100%');
      expect(observed.editor?.value).toBe(sourceCode);
      expect(findButton('Exit full-width editor')).toBeUndefined();
    },
  );

  it.each([900, 700])(
    'preserves language, draft and testcases while exiting fullscreen in stacked Code view (%spx)',
    async (width) => {
      localStorage.setItem('astra-lang', 'JAVA');
      localStorage.setItem('astra-draft:1:JAVA', '// existing Java draft');
      await mount();
      await click('Use fixture example');
      await act(async () => observed.editor!.onChange('// edited Java draft'));
      await act(async () => vi.advanceTimersByTimeAsync(600));
      // jsdom schedules a storage event from inside the draft-save timer. Fake timers
      // defer that nested zero-delay callback to the next tick; flush it explicitly.
      await act(async () => vi.advanceTimersToNextTimerAsync());
      expect(localStorage.getItem('astra-draft:1:JAVA')).toBe('// edited Java draft');
      await click('Full-width editor');
      await resize(width);
      await click('Code');
      expect(findButton('Exit full-width editor')?.getAttribute('aria-pressed')).toBe('true');
      await click('Exit full-width editor');
      expectSelected('Code');
      expect(editorPane()?.style.width).toBe('100%');
      expect(observed.editor?.language).toBe('JAVA');
      expect(observed.editor?.value).toBe('// edited Java draft');
      expectSelected('Tests (2)');
      expect(findButton('Custom 1')?.getAttribute('aria-pressed')).toBe('true');
      await click('Problem');
      expect(problemPane()).toBeDefined();
      await click('Code');
      expect(observed.editor?.value).toBe('// edited Java draft');
      expect(localStorage.getItem('astra-lang')).toBe('JAVA');
      expect(localStorage.getItem('astra-draft:1:JAVA')).toBe('// edited Java draft');
      expect(submissionApi.create).not.toHaveBeenCalled();
      expect(submissionApi.run).not.toHaveBeenCalled();
      expect(observed.push).not.toHaveBeenCalled();
    },
  );

  it.each(['Enter', ' '])(
    'exposes a focusable native Exit button that accepts a keyboard-origin activation (%s)',
    async (key) => {
      await mount();
      await click('Full-width editor');
      await resize(700);
      await click('Code');
      const exit = findButton('Exit full-width editor');
      expect(exit).toBeDefined();
      expect(exit!.tagName).toBe('BUTTON');
      expect(exit!.type).toBe('button');
      expect(exit!.disabled).toBe(false);
      expect(exit!.tabIndex).toBe(0);
      exit!.focus();
      expect(document.activeElement).toBe(exit);
      const clicks = vi.fn();
      exit!.addEventListener('click', clicks);
      await act(async () => {
        const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        exit!.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(false);
        exit!.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        // jsdom does not synthesize native button activation from keys. Supply its
        // keyboard-origin click (detail=0); browser key-to-click behavior is not E2E coverage.
        exit!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
      });
      expect(clicks).toHaveBeenCalledTimes(1);
      expect(findButton('Exit full-width editor')).toBeUndefined();
      await click('Problem');
      expect(problemPane()).toBeDefined();
      expect(observed.editor?.value).toBe(sourceCode);
    },
  );
});

describe('workspace keyboard resize accessibility', () => {
  it.each<Mode>(['h', 'v'])(
    'uses focused %s arrow keys with 2 percentage point / 20px increments',
    async (mode) => {
      document.body.style.userSelect = 'text';
      const { measure } = await mount();
      const increase = mode === 'h' ? 'ArrowRight' : 'ArrowUp';
      const decrease = mode === 'h' ? 'ArrowLeft' : 'ArrowDown';
      expect((await press(mode, increase)).defaultPrevented).toBe(true);
      expectResizeValue(mode, mode === 'h' ? 54 : 255);
      expect((await press(mode, decrease)).defaultPrevented).toBe(true);
      expectResizeValue(mode, mode === 'h' ? 52 : 235);
      await press(mode, decrease);
      expectResizeValue(mode, mode === 'h' ? 50 : 215);
      expect(problemPane()?.style.width).toBe(mode === 'h' ? '50%' : '52%');
      expect(bottomPanel().style.height).toBe(mode === 'v' ? '215px' : '235px');
      expect(sessionStorage.getItem(mode === 'h' ? 'astra-split' : 'astra-bottom')).toBe(
        mode === 'h' ? '50' : '215',
      );
      expect(sessionStorage.getItem(mode === 'h' ? 'astra-bottom' : 'astra-split')).toBeNull();
      expect(document.body.style.userSelect).toBe('text');
      expect(document.activeElement).toBe(separator(mode));
      await move(700);
      expect(measure).not.toHaveBeenCalled();
      expect(submissionApi.create).not.toHaveBeenCalled();
      expect(submissionApi.run).not.toHaveBeenCalled();
    },
  );

  it.each<Mode>(['h', 'v'])(
    'applies Home/End and clamps %s arrows at both boundaries',
    async (mode) => {
      await mount();
      expect((await press(mode, 'Home')).defaultPrevented).toBe(true);
      expectResizeValue(mode, mode === 'h' ? 30 : 120);
      await press(mode, mode === 'h' ? 'ArrowLeft' : 'ArrowDown');
      expectResizeValue(mode, mode === 'h' ? 30 : 120);
      expect((await press(mode, 'End')).defaultPrevented).toBe(true);
      expectResizeValue(mode, mode === 'h' ? 68 : 520);
      await press(mode, mode === 'h' ? 'ArrowRight' : 'ArrowUp');
      expectResizeValue(mode, mode === 'h' ? 68 : 520);
      expect(sessionStorage.getItem(mode === 'h' ? 'astra-split' : 'astra-bottom')).toBe(
        mode === 'h' ? '68' : '520',
      );
    },
  );

  it.each<Mode>(['h', 'v'])(
    'ignores unrelated and modified keys on the %s separator',
    async (mode) => {
      await mount();
      const write = vi.spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem');
      for (const key of [
        mode === 'h' ? 'ArrowUp' : 'ArrowRight',
        mode === 'h' ? 'ArrowDown' : 'ArrowLeft',
        'Tab',
        'Enter',
        ' ',
        'a',
      ]) {
        expect((await press(mode, key)).defaultPrevented).toBe(false);
      }
      for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
        expect(
          (await press(mode, mode === 'h' ? 'ArrowRight' : 'ArrowUp', { [modifier]: true }))
            .defaultPrevented,
        ).toBe(false);
      }
      expectResizeValue('h', 52);
      expectResizeValue('v', 235);
      expect(write).not.toHaveBeenCalled();
    },
  );

  it('updates ARIA values after storage restoration, mouse dragging and resets', async () => {
    sessionStorage.setItem('astra-split', '61.5');
    sessionStorage.setItem('astra-bottom', '333');
    await mount();
    expectResizeValue('h', 61.5);
    expectResizeValue('v', 333);
    await start('h');
    await move(700);
    await release();
    expectResizeValue('h', 60);
    await start('v');
    await move(0, 450);
    await release();
    expectResizeValue('v', 350);
    await reset('h');
    await reset('v');
    expectResizeValue('h', 52);
    expectResizeValue('v', 235);
  });

  it.each<Mode>(['h', 'v'])(
    'accumulates rapid %s keyboard changes within one React batch',
    async (mode) => {
      await mount();
      const element = separator(mode);
      element.focus();
      await act(async () => {
        for (const key of mode === 'h'
          ? ['ArrowRight', 'ArrowRight', 'ArrowLeft']
          : ['ArrowUp', 'ArrowUp', 'ArrowDown']) {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
          element.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
        }
      });
      expectResizeValue(mode, mode === 'h' ? 54 : 255);
      expect(sessionStorage.getItem(mode === 'h' ? 'astra-split' : 'astra-bottom')).toBe(
        mode === 'h' ? '54' : '255',
      );
    },
  );

  it('restores both keyboard-resized dimensions and ARIA values after remount', async () => {
    await mount();
    await press('h', 'ArrowRight');
    await press('v', 'ArrowUp');
    await view!.unmount();
    await mount();
    expect(problemPane()?.style.width).toBe('54%');
    expect(bottomPanel().style.height).toBe('255px');
    expectResizeValue('h', 54);
    expectResizeValue('v', 255);
  });

  it.each<Mode>(['h', 'v'])(
    'keeps %s mouse → keyboard → mouse geometry synchronized',
    async (mode) => {
      await mount();
      await start(mode);
      await move(700, 450);
      await release();
      await press(mode, mode === 'h' ? 'ArrowLeft' : 'ArrowDown');
      expectResizeValue(mode, mode === 'h' ? 58 : 330);
      await start(mode);
      await move(600, 500);
      await release();
      expectResizeValue(mode, mode === 'h' ? 50 : 300);
      expect(sessionStorage.getItem(mode === 'h' ? 'astra-split' : 'astra-bottom')).toBe(
        mode === 'h' ? '50' : '300',
      );
    },
  );

  it.each<Mode>(['h', 'v'])(
    'ends an active %s drag before keyboard resizing so queued mouse events cannot overwrite it',
    async (mode) => {
      document.body.style.userSelect = 'text';
      await mount();
      await start(mode);
      await act(async () => {
        window.dispatchEvent(
          new MouseEvent('mousemove', { clientX: 700, clientY: 450, buttons: 1 }),
        );
        separator(mode).focus();
        separator(mode).dispatchEvent(
          new KeyboardEvent('keydown', {
            key: mode === 'h' ? 'ArrowRight' : 'ArrowUp',
            bubbles: true,
            cancelable: true,
          }),
        );
        window.dispatchEvent(
          new MouseEvent('mousemove', { clientX: 400, clientY: 600, buttons: 1 }),
        );
        window.dispatchEvent(new MouseEvent('mouseup'));
      });
      expectResizeValue(mode, mode === 'h' ? 62 : 370);
      expect(sessionStorage.getItem(mode === 'h' ? 'astra-split' : 'astra-bottom')).toBe(
        mode === 'h' ? '62' : '370',
      );
      expect(sessionStorage.getItem(mode === 'h' ? 'astra-bottom' : 'astra-split')).toBeNull();
      expect(document.body.style.userSelect).toBe('text');
    },
  );

  it('keeps reset defaults authoritative after keyboard resizing', async () => {
    await mount();
    await press('h', 'End');
    await press('v', 'End');
    await reset('h');
    expectResizeValue('h', 52);
    expectResizeValue('v', 520);
    await reset('v');
    expectResizeValue('v', 235);
    expect(sessionStorage.getItem('astra-split')).toBe('52');
    expect(sessionStorage.getItem('astra-bottom')).toBe('235');
  });

  it.each<Mode>(['h', 'v'])(
    'keeps %s keyboard resizing usable when storage fails',
    async (mode) => {
      await mount();
      const prototype = Object.getPrototypeOf(sessionStorage) as Storage;
      const write = prototype.setItem;
      vi.spyOn(prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (this === sessionStorage) throw new Error('fixture storage unavailable');
        return write.call(this, key, value);
      });
      expect((await press(mode, mode === 'h' ? 'ArrowRight' : 'ArrowUp')).defaultPrevented).toBe(
        true,
      );
      expectResizeValue(mode, mode === 'h' ? 54 : 255);
      expect(document.body.style.userSelect).toBe('');
    },
  );

  it('resizes the saved bottom height without opening a collapsed panel or changing its tab', async () => {
    await mount();
    await click('Console');
    await click('Collapse panel');
    await press('v', 'ArrowUp');
    expect(bottomPanel().style.height).toBe('39px');
    expectSelected('Console');
    expectResizeValue('v', 255);
    await click('Expand panel');
    expect(bottomPanel().style.height).toBe('255px');
    await click('Result');
    await press('v', 'ArrowDown');
    expectSelected('Result');
    expect(bottomPanel().style.height).toBe('235px');
  });

  it.each([false, true])(
    'keeps keyboard handling single and drag cleanup intact across rerenders (StrictMode=%s)',
    async (strict) => {
      document.body.style.userSelect = 'text';
      const listeners = trackListeners();
      await mount(1280, strict);
      await press('h', 'ArrowRight');
      const page = createElement(WorkspacePage);
      await view!.rerender(strict ? createElement(StrictMode, null, page) : page);
      await press('h', 'ArrowRight');
      expectResizeValue('h', 56);
      for (const type of ['mousemove', 'mouseup', 'blur', 'resize'])
        expect(listeners.active(type).size).toBe(1);
      await start('v');
      await press('v', 'ArrowUp');
      expectResizeValue('v', 255);
      expect(document.body.style.userSelect).toBe('text');
      await start('h');
      await view!.unmount();
      expect(document.body.style.userSelect).toBe('text');
      for (const type of ['mousemove', 'mouseup', 'blur', 'resize'])
        expect(listeners.active(type).size).toBe(0);
    },
  );

  it('leaves editor Run/Submit shortcuts operational without resizing panels', async () => {
    await mount();
    const editor = view!.container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Layout fixture editor"]',
    )!;
    await act(async () =>
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    await act(async () =>
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(submissionApi.create).toHaveBeenCalledTimes(1);
    expectResizeValue('h', 52);
    expectResizeValue('v', 235);
  });
});

describe('workspace layout coordination with feature actions', () => {
  it.each([true, false])(
    'Run opens Result and retains geometry when initially bottomOpen=%s',
    async (open) => {
      const pending = deferred<RunResponse>();
      vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
      await mount();
      await click('Console');
      if (!open) await click('Collapse panel');
      await click('Run');
      expectSelected('Result');
      expect(bottomPanel().style.height).toBe('235px');
      expect(view!.container.textContent).toContain('Running your code');
      expect(submissionApi.run).toHaveBeenCalledTimes(1);
      expect(observed.editor?.value).toBe(sourceCode);
      await act(async () => pending.resolve(runResult));
      expect(bottomPanel().style.height).toBe('235px');
    },
  );

  it('Submit selects Result and opens a previously collapsed bottom panel before create settles', async () => {
    const pending = deferred<CreateSubmissionResponse>();
    vi.mocked(submissionApi.create).mockReturnValueOnce(pending.promise);
    await mount();
    await click('Console');
    await click('Collapse panel');
    await click('Submit');
    expectSelected('Result');
    expect(bottomPanel().style.height).toBe('235px');
    expect(submissionApi.create).toHaveBeenCalledTimes(1);
    expect(findButton('Collapse panel')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => pending.reject(new ApiError('fixture create stopped', 503, 50300)));
  });

  it.each([1280, 700])(
    'adding an example opens Tests and navigates to the editor where stacked (%spx)',
    async (width) => {
      await mount();
      await click('Console');
      await click('Collapse panel');
      if (width < 1020) await resize(width);
      await click('Use fixture example');
      expectSelected('Tests (2)');
      expect(bottomPanel().style.height).toBe('235px');
      expect(findButton('Custom 1')?.getAttribute('aria-pressed')).toBe('true');
      expect(
        view!.container.querySelector<HTMLTextAreaElement>('[aria-label="Test input for Custom 1"]')
          ?.value,
      ).toBe('42\n');
      expect(observed.toast).toHaveBeenCalledExactlyOnceWith(
        'Example added as a custom test',
        'success',
      );
      if (width < 1020) {
        expectSelected('Code');
        expect(problemPane()).toBeUndefined();
        expect(editorPane()?.style.width).toBe('100%');
      } else {
        expect(problemPane()?.style.width).toBe('52%');
      }
      expect(observed.editor?.value).toBe(sourceCode);
      expect(observed.push).not.toHaveBeenCalled();
      expect(submissionApi.run).not.toHaveBeenCalled();
      expect(submissionApi.create).not.toHaveBeenCalled();
    },
  );

  it('restoring unchanged submission code opens Tests and selects the stacked editor view', async () => {
    await mount();
    await click('Console');
    await click('Collapse panel');
    await resize(700);
    await click('Restore fixture submission');
    expectSelected('Code');
    expectSelected('Tests (1)');
    expect(bottomPanel().style.height).toBe('235px');
    expect(editorPane()?.style.width).toBe('100%');
    expect(observed.editor?.value).toBe(sourceCode);
    expect(observed.push).not.toHaveBeenCalled();
  });

  it('View submissions selects the problem history and stacked Problem view without route navigation', async () => {
    vi.mocked(submissionApi.create).mockResolvedValueOnce(created);
    await mount(700);
    await click('Code');
    await click('Submit');
    await click('View all submissions');
    expectSelected('Problem');
    expect(problemPane()?.style.width).toBe('100%');
    expect(editorPane()).toBeUndefined();
    expect(observed.problem?.tab).toBe('submissions');
    expect(observed.push).not.toHaveBeenCalled();
    expect(submissionApi.issueStreamTicket).not.toHaveBeenCalled();
  });
});

describe('workspace resize lifecycle and existing limitations', () => {
  it.each([false, true])(
    'keeps one active listener per event across rerenders and removes it on unmount (StrictMode=%s)',
    async (strict) => {
      const listeners = trackListeners();
      const { measure } = await mount(1280, strict);
      for (const type of ['mousemove', 'mouseup', 'blur', 'resize'])
        expect(listeners.active(type).size).toBe(1);
      await start('h');
      await move(700);
      await move(600);
      await release();
      if (!strict) await view!.rerender(createElement(WorkspacePage));
      await resize(1100);
      for (const type of ['mousemove', 'mouseup', 'blur', 'resize'])
        expect(listeners.active(type).size).toBe(1);
      expect(measure).toHaveBeenCalledTimes(2);
      await view!.unmount();
      for (const type of ['mousemove', 'mouseup', 'blur', 'resize'])
        expect(listeners.active(type).size).toBe(0);
      const stored = sessionStorage.getItem('astra-split');
      await move(500);
      await release();
      await resize(900);
      expect(measure).toHaveBeenCalledTimes(2);
      expect(sessionStorage.getItem('astra-split')).toBe(stored);
      expect(view!.container.childNodes).toHaveLength(0);
    },
  );

  it('restores selection on unmount during drag and removes all drag listeners', async () => {
    const listeners = trackListeners();
    const { measure } = await mount();
    await start('h');
    await view!.unmount();
    expect(listeners.active('mousemove').size).toBe(0);
    expect(listeners.active('mouseup').size).toBe(0);
    await move(700);
    await release();
    expect(measure).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('astra-split')).toBeNull();
    expect(document.body.style.userSelect).toBe('');
  });

  it('ends drag on blur and ignores subsequent movement with no pressed buttons', async () => {
    await mount();
    await start('h');
    await act(async () => window.dispatchEvent(new Event('blur')));
    await move(700, 450, 0);
    expect(problemPane()?.style.width).toBe('52%');
    expect(sessionStorage.getItem('astra-split')).toBe('52');
    expect(document.body.style.userSelect).toBe('');
    await release();
    expect(document.body.style.userSelect).toBe('');
  });

  it('makes both focusable separators keyboard operable with numeric ARIA values', async () => {
    await mount();
    for (const mode of ['h', 'v'] as const) {
      const element = separator(mode);
      element.focus();
      expect(document.activeElement).toBe(element);
      expect(element.tabIndex).toBe(0);
      expectResizeValue(mode, mode === 'h' ? 52 : 235);
      expect((await press(mode, mode === 'h' ? 'ArrowRight' : 'ArrowUp')).defaultPrevented).toBe(
        true,
      );
      expectResizeValue(mode, mode === 'h' ? 54 : 255);
    }
    expect(problemPane()?.style.width).toBe('54%');
    expect(bottomPanel().style.height).toBe('255px');
    expect(submissionApi.run).not.toHaveBeenCalled();
    expect(submissionApi.create).not.toHaveBeenCalled();
  });
});
