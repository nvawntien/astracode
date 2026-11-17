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
    'characterizes %s double-click reset changing the UI but retaining the old stored dimension',
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
      expect(sessionStorage.getItem('astra-split')).toBe('60');
      expect(sessionStorage.getItem('astra-bottom')).toBe('333');
      await view!.unmount();
      await mount();
      expect(problemPane()?.style.width).toBe('60%');
      expect(bottomPanel().style.height).toBe('333px');
    },
  );

  it('characterizes a same-batch move/release persisting the previous render geometry', async () => {
    await mount();
    await start('h');
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, buttons: 1 }));
      window.dispatchEvent(new MouseEvent('mouseup', { buttons: 0 }));
    });
    expect(problemPane()?.style.width).toBe('60%');
    expect(sessionStorage.getItem('astra-split')).toBe('52');
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

  it('characterizes full-width mode surviving stacked resize while its exit control is absent', async () => {
    await mount();
    await click('Full-width editor');
    await resize(759);
    expectSelected('Problem');
    expect(problemPane()).toBeUndefined();
    expect(editorPane()?.style.width).toBe('100%');
    expect(findButton('Exit full-width editor')).toBeUndefined();
    await click('Problem');
    expect(problemPane()).toBeUndefined();
    expect(editorPane()).toBeDefined();
    await resize(1020);
    await click('Exit full-width editor');
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

describe('workspace layout coordination with feature actions', () => {
  it.each([true, false])('Run selects Result while preserving bottomOpen=%s', async (open) => {
    const pending = deferred<RunResponse>();
    vi.mocked(submissionApi.run).mockReturnValueOnce(pending.promise);
    await mount();
    await click('Console');
    if (!open) await click('Collapse panel');
    await click('Run');
    expectSelected('Result');
    expect(bottomPanel().style.height).toBe(open ? '235px' : '39px');
    if (open) expect(view!.container.textContent).toContain('Running your code');
    else expect(view!.container.textContent).not.toContain('Running your code');
    expect(submissionApi.run).toHaveBeenCalledTimes(1);
    expect(observed.editor?.value).toBe(sourceCode);
    await act(async () => pending.resolve(runResult));
    expect(bottomPanel().style.height).toBe(open ? '235px' : '39px');
  });

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
      for (const type of ['mousemove', 'mouseup', 'resize'])
        expect(listeners.active(type).size).toBe(1);
      await start('h');
      await move(700);
      await move(600);
      await release();
      if (!strict) await view!.rerender(createElement(WorkspacePage));
      await resize(1100);
      for (const type of ['mousemove', 'mouseup', 'resize'])
        expect(listeners.active(type).size).toBe(1);
      expect(measure).toHaveBeenCalledTimes(2);
      await view!.unmount();
      for (const type of ['mousemove', 'mouseup', 'resize'])
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

  it('characterizes unmount during drag leaving body userSelect disabled despite listener cleanup', async () => {
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
    expect(document.body.style.userSelect).toBe('none');
  });

  it('characterizes blur not cancelling drag, including a subsequent move with no pressed buttons', async () => {
    await mount();
    await start('h');
    await act(async () => window.dispatchEvent(new Event('blur')));
    await move(700, 450, 0);
    expect(problemPane()?.style.width).toBe('60%');
    expect(document.body.style.userSelect).toBe('none');
    await release();
    expect(document.body.style.userSelect).toBe('');
  });

  it('characterizes focusable separators without keyboard resizing or numeric ARIA values', async () => {
    await mount();
    for (const mode of ['h', 'v'] as const) {
      const element = separator(mode);
      element.focus();
      expect(document.activeElement).toBe(element);
      expect(element.tabIndex).toBe(0);
      expect(element.getAttribute('aria-valuenow')).toBeNull();
      await act(async () => {
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
          element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        }
      });
    }
    expect(problemPane()?.style.width).toBe('52%');
    expect(bottomPanel().style.height).toBe('235px');
    expect(submissionApi.run).not.toHaveBeenCalled();
    expect(submissionApi.create).not.toHaveBeenCalled();
  });
});
