import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEvent } from 'react';
import { useEditorDraft as editorDraft } from '../src/features/problem-workspace/hooks/useEditorDraft';
import { useEditorPreferences as editorPreferences } from '../src/features/problem-workspace/hooks/useEditorPreferences';
import { CODE_TEMPLATES, draftKey } from '../src/lib/templates';
import type { LanguageCode } from '../src/lib/types';

type Effect = () => void | (() => void);

// Capture the hook's actual effect callbacks for Node unit tests. React scheduling,
// rerenders, StrictMode and browser lifecycle behavior need separate browser tests.
const react = vi.hoisted(() => ({
  useState: vi.fn<(initial: unknown) => [unknown, ReturnType<typeof vi.fn>]>(),
  useEffect: vi.fn<(effect: Effect, dependencies: unknown[]) => void>(),
  useCallback: vi.fn((callback: unknown) => callback),
}));

vi.mock('react', () => react);

let effects: Effect[];
let updates: ReturnType<typeof vi.fn>[];
let stored: Map<string, string>;
let getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>;
let setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;

function captureState(values: unknown[] = []) {
  effects = [];
  updates = [];
  let index = 0;
  react.useState.mockImplementation((initial) => {
    const value = index < values.length ? values[index] : initial;
    index += 1;
    const update = vi.fn();
    updates.push(update);
    return [value, update];
  });
  react.useEffect.mockImplementation((effect) => {
    effects.push(effect);
  });
}

function captureDraft(
  problem: { id: number } | null = { id: 17 },
  language: LanguageCode = 'GO',
  code = CODE_TEMPLATES.GO,
) {
  captureState([code, null]);
  const setLanguage = vi.fn();
  const state = editorDraft({ problem, language, setLanguage });
  return { ...state, setLanguage, load: effects[0], persist: effects[1], updates: [...updates] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  stored = new Map();
  getItem = vi.fn((key: string) => stored.get(key) ?? null);
  setItem = vi.fn((key: string, value: string) => {
    stored.set(key, value);
  });
  vi.stubGlobal('localStorage', { getItem, setItem });
  captureState();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('editor preferences', () => {
  it('starts with GO, font size 13 and tab size 4 without reading storage during render', () => {
    const state = editorPreferences();
    expect([state.language, state.fontSize, state.tabSize]).toEqual(['GO', 13, 4]);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('loads the global preferences in the original order and raw format', () => {
    stored.set('astra-lang', 'CPP');
    stored.set('astra-font', '14');
    stored.set('astra-tab', '2');
    editorPreferences();
    effects[0]();
    expect(getItem.mock.calls).toEqual([['astra-lang'], ['astra-font'], ['astra-tab']]);
    expect(updates.map((update) => update.mock.calls)).toEqual([[['CPP']], [[14]], [[2]]]);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('keeps defaults for malformed preferences without rewriting storage', () => {
    stored.set('astra-lang', 'rust');
    stored.set('astra-font', 'NaN');
    stored.set('astra-tab', '3');
    editorPreferences();
    effects[0]();
    for (const update of updates) expect(update).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('preserves the shared try boundary when a later preference read fails', () => {
    getItem.mockImplementation((key) => {
      if (key === 'astra-lang') return 'JAVA';
      throw new Error('storage unavailable');
    });
    editorPreferences();
    expect(() => effects[0]()).not.toThrow();
    expect(updates[0]).toHaveBeenCalledWith('JAVA');
    expect(updates[1]).not.toHaveBeenCalled();
    expect(updates[2]).not.toHaveBeenCalled();
    expect(getItem.mock.calls).toEqual([['astra-lang'], ['astra-font']]);
  });

  it('persists language, font and tab changes as raw strings', () => {
    const state = editorPreferences();
    state.changeLanguage('PYTHON');
    state.changeFontSize({ target: { value: '16' } } as ChangeEvent<HTMLInputElement>);
    state.changeTabSize({ target: { value: '8' } } as ChangeEvent<HTMLSelectElement>);
    expect(setItem.mock.calls).toEqual([
      ['astra-lang', 'PYTHON'],
      ['astra-font', '16'],
      ['astra-tab', '8'],
    ]);
    expect(updates.map((update) => update.mock.calls)).toEqual([[['PYTHON']], [[16]], [[8]]]);
  });

  it('updates preferences even when persistence throws', () => {
    setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    const state = editorPreferences();
    expect(() => state.changeLanguage('JAVA')).not.toThrow();
    expect(() =>
      state.changeFontSize({ target: { value: '11' } } as ChangeEvent<HTMLInputElement>),
    ).not.toThrow();
    expect(() =>
      state.changeTabSize({ target: { value: '2' } } as ChangeEvent<HTMLSelectElement>),
    ).not.toThrow();
    expect(updates.map((update) => update.mock.calls)).toEqual([[['JAVA']], [[11]], [[2]]]);
  });
});

describe('editor draft effect callbacks and actions', () => {
  it('starts with the GO template and no saved indicator, and does nothing without a problem', () => {
    const state = captureDraft(null);
    expect(state.code).toBe(CODE_TEMPLATES.GO);
    expect(state.draftSavedAt).toBeNull();
    state.load();
    state.persist();
    state.restoreDraft('CPP', 'restored');
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [17, 'GO'],
    [17, 'CPP'],
    [29, 'GO'],
  ] as const)(
    'loads only problem %s and language %s, then clears the saved indicator',
    (id, language) => {
      stored.set(draftKey(id, language), `${id} ${language} source`);
      const state = captureDraft({ id }, language);
      state.load();
      expect(getItem).toHaveBeenCalledExactlyOnceWith(`astra-draft:${id}:${language}`);
      expect(state.updates[0]).toHaveBeenCalledWith(`${id} ${language} source`);
      expect(state.updates[1]).toHaveBeenCalledWith(null);
    },
  );

  it('falls back to the selected language template when storage is inaccessible', () => {
    vi.stubGlobal('localStorage', undefined);
    const state = captureDraft({ id: 17 }, 'PYTHON');
    expect(() => state.load()).not.toThrow();
    expect(state.updates[0]).toHaveBeenCalledWith(CODE_TEMPLATES.PYTHON);
    expect(state.updates[1]).toHaveBeenCalledWith(null);
  });

  it('saves raw code after 600 ms and updates the indicator only after a successful write', () => {
    const state = captureDraft({ id: 29 }, 'CPP', 'edited code\n');
    state.persist();
    vi.advanceTimersByTime(599);
    expect(setItem).not.toHaveBeenCalled();
    expect(state.updates[1]).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setItem).toHaveBeenCalledExactlyOnceWith('astra-draft:29:CPP', 'edited code\n');
    expect(state.updates[1]).toHaveBeenCalledExactlyOnceWith(Date.now());
  });

  it('cancels the older pending write before persisting a newer edit', () => {
    const problem = { id: 17 };
    const previous = captureDraft(problem, 'GO', 'older edit');
    expect(react.useEffect.mock.calls.slice(-2).map(([, dependencies]) => dependencies)).toEqual([
      [problem, 'GO'],
      ['older edit', problem, 'GO'],
    ]);
    const cleanup = previous.persist();
    vi.advanceTimersByTime(300);
    cleanup?.();
    const current = captureDraft(problem, 'GO', 'newer edit');
    current.persist();
    vi.advanceTimersByTime(600);
    expect(setItem).toHaveBeenCalledExactlyOnceWith('astra-draft:17:GO', 'newer edit');
    expect(previous.updates[1]).not.toHaveBeenCalled();
  });

  it('does not flush the previous language or write after cleanup on a problem/language change', () => {
    const previous = captureDraft({ id: 17 }, 'GO', 'unsaved old draft');
    const cleanup = previous.persist();
    cleanup?.();
    stored.set('astra-draft:29:JAVA', 'next problem draft');
    const current = captureDraft({ id: 29 }, 'JAVA', 'next problem draft');
    current.load();
    const currentCleanup = current.persist();
    vi.advanceTimersByTime(600);
    expect(current.updates[0]).toHaveBeenCalledWith('next problem draft');
    expect(setItem).toHaveBeenCalledExactlyOnceWith('astra-draft:29:JAVA', 'next problem draft');
    setItem.mockClear();
    currentCleanup?.();
    vi.advanceTimersByTime(1000);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('cancels an outstanding save without flushing on unmount cleanup', () => {
    const state = captureDraft();
    const cleanup = state.persist();
    cleanup?.();
    vi.advanceTimersByTime(1000);
    expect(setItem).not.toHaveBeenCalled();
    expect(state.updates[1]).not.toHaveBeenCalled();
  });

  it('does not throw or mark a failed save as successful', () => {
    setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    const state = captureDraft();
    state.persist();
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    expect(state.updates[1]).not.toHaveBeenCalled();
  });

  it('resets only the code to the current language template, leaving persistence debounced', () => {
    const state = captureDraft({ id: 17 }, 'JAVA', 'current code');
    state.resetCode();
    expect(state.updates[0]).toHaveBeenCalledExactlyOnceWith(CODE_TEMPLATES.JAVA);
    expect(state.updates[1]).not.toHaveBeenCalled();
    expect(state.setLanguage).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('writes a restored source to the target language before updating editor state', () => {
    const state = captureDraft({ id: 17 }, 'GO');
    state.restoreDraft('CPP', 'restored source\n');
    expect(setItem.mock.calls).toEqual([
      ['astra-lang', 'CPP'],
      ['astra-draft:17:CPP', 'restored source\n'],
    ]);
    expect(state.setLanguage).toHaveBeenCalledExactlyOnceWith('CPP');
    expect(state.updates[0]).toHaveBeenCalledExactlyOnceWith('restored source\n');
    expect(state.updates[1]).toHaveBeenCalledExactlyOnceWith(Date.now());
    expect(setItem.mock.invocationCallOrder[1]).toBeLessThan(
      state.setLanguage.mock.invocationCallOrder[0],
    );
  });

  it('still updates restored code when storage fails, while preserving the existing next-load fallback', () => {
    vi.stubGlobal('localStorage', undefined);
    const state = captureDraft({ id: 17 }, 'GO');
    expect(() => state.restoreDraft('CPP', 'restored source')).not.toThrow();
    expect(state.setLanguage).toHaveBeenCalledWith('CPP');
    expect(state.updates[0]).toHaveBeenCalledWith('restored source');
    expect(state.updates[1]).toHaveBeenCalledWith(Date.now());
    // Existing limitation: a subsequent language-change load cannot find that draft.
    const next = captureDraft({ id: 17 }, 'CPP', 'restored source');
    next.load();
    expect(next.updates[0]).toHaveBeenCalledWith(CODE_TEMPLATES.CPP);
  });
});
