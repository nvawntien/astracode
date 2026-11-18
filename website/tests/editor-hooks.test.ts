import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEvent } from 'react';
import { useEditorPreferences as editorPreferences } from '../src/features/problem-workspace/hooks/useEditorPreferences';

type Effect = () => void | (() => void);

// Capture preference effects in Node. Draft ownership runs with real React in editor-draft.test.ts.
const react = vi.hoisted(() => ({
  useState: vi.fn<(initial: unknown) => [unknown, ReturnType<typeof vi.fn>]>(),
  useEffect: vi.fn<(effect: Effect, dependencies: unknown[]) => void>(),
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
