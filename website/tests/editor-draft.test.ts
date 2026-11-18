// @vitest-environment jsdom

import { act, createElement, StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorDraft } from '../src/features/problem-workspace/hooks/useEditorDraft';
import { CODE_TEMPLATES, draftKey } from '../src/lib/templates';
import type { LanguageCode } from '../src/lib/types';
import { renderReact } from './helpers/react-dom';

interface Owner {
  accountId?: string | null;
  authLoading?: boolean;
  problemId?: number | null;
}

let editor: ReturnType<typeof useEditorDraft>;
let changeLanguage: (language: LanguageCode) => void;
let view: Awaited<ReturnType<typeof renderReact>> | undefined;
let storage: Map<string, string>;
const key = (language: LanguageCode, problemId = 17, accountId = 'a') =>
  draftKey(accountId, problemId, language);

function Probe({ accountId = 'a', authLoading = false, problemId = 17 }: Owner) {
  const [language, setLanguage] = useState<LanguageCode>('GO');
  editor = useEditorDraft({
    accountId,
    authLoading,
    problemId: problemId ?? undefined,
    language,
    setLanguage,
  });
  changeLanguage = setLanguage;
  return createElement('output', null, editor.code);
}

function element(owner: Owner = {}) {
  return createElement(StrictMode, null, createElement(Probe, owner));
}
async function mount(owner?: Owner) {
  view = await renderReact(element(owner));
}
async function advance(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  });
});
afterEach(async () => {
  try {
    await view?.unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

describe('editor draft lifecycle under StrictMode', () => {
  it('uses a safe default without touching storage while auth or problem is unknown', async () => {
    await mount({ problemId: null });
    expect(editor.code).toBe(CODE_TEMPLATES.GO);
    expect(editor.ready).toBe(false);
    expect(editor.draftSavedAt).toBeNull();
    await view!.rerender(element({ authLoading: true }));
    await act(async () => editor.setCode('edit raced hydration'));
    expect(editor.restoreDraft('CPP', 'stale restore')).toBe(false);
    await advance(600);
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('reads only the selected owner, problem and language and cancels the departed draft timer', async () => {
    storage.set(key('GO'), '// A Go');
    storage.set(key('CPP'), '// A C++');
    storage.set(key('CPP', 29), '// next problem');
    storage.set(key('CPP', 29, 'b'), '// B next problem');
    await mount();
    expect(editor.code).toBe('// A Go');

    await act(async () => editor.setCode('unsaved old language'));
    await act(async () => changeLanguage('CPP'));
    expect(editor.code).toBe('// A C++');
    expect(editor.draftSavedAt).toBeNull();
    await act(async () => editor.setCode('unsaved old problem'));
    await view!.rerender(element({ problemId: 29 }));
    expect(editor.code).toBe('// next problem');
    await view!.rerender(element({ problemId: 29, accountId: 'b' }));
    expect(editor.code).toBe('// B next problem');
    await advance(600);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(new Set(vi.mocked(localStorage.getItem).mock.calls.map(([k]) => k))).toEqual(
      new Set([key('GO'), key('CPP'), key('CPP', 29), key('CPP', 29, 'b')]),
    );
  });

  it('saves the latest edit after 600 ms and clears the indicator on scope change', async () => {
    await mount();
    await act(async () => {
      editor.setCode('older batch edit');
      editor.setCode('latest batch edit');
    });
    await advance(300);
    await act(async () => editor.setCode('newest edit\n'));
    await advance(599);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(editor.draftSavedAt).toBeNull();
    await advance(1);
    expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith(key('GO'), 'newest edit\n');
    expect(editor.draftSavedAt).toBe(Date.now());

    await view!.rerender(element({ accountId: 'b' }));
    expect(editor.draftSavedAt).toBeNull();
    await act(async () => editor.setCode('B own edit'));
    await advance(600);
    expect(storage.get(key('GO', 17, 'b'))).toBe('B own edit');
    await view!.rerender(element());
    expect(editor.code).toBe('newest edit\n');
  });

  it('invalidates delayed edit, reset and restore callbacks even after returning to the same account', async () => {
    await mount();
    const obsolete = editor;
    await view!.rerender(element({ accountId: 'b' }));
    await view!.rerender(element());
    await act(async () => {
      editor.setCode('A current draft');
      obsolete.setCode('A obsolete edit');
      obsolete.resetCode();
      expect(obsolete.restoreDraft('CPP', 'A obsolete restore')).toBe(false);
    });
    expect(editor.code).toBe('A current draft');
    await advance(600);
    expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith(key('GO'), 'A current draft');
  });

  it('cancels a pending save on unmount and reloads only the previous saved copy', async () => {
    storage.set(key('GO'), '// persisted');
    await mount();
    await act(async () => editor.setCode('// unsaved'));
    await view!.unmount();
    await advance(1000);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    await mount();
    expect(editor.code).toBe('// persisted');
  });

  it('resets only the code to the selected template and keeps the save debounced', async () => {
    storage.set(key('GO'), '// draft');
    await mount();
    await act(async () => editor.resetCode());
    expect(editor.code).toBe(CODE_TEMPLATES.GO);
    expect(editor.draftSavedAt).toBeNull();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    await advance(600);
    expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith(key('GO'), CODE_TEMPLATES.GO);
  });

  it('writes restored source into the target language before switching and survives remount', async () => {
    await mount();
    await act(async () => expect(editor.restoreDraft('CPP', 'restored source\n')).toBe(true));
    expect(vi.mocked(localStorage.setItem).mock.calls).toEqual([
      ['astra-lang', 'CPP'],
      [key('CPP'), 'restored source\n'],
    ]);
    expect(editor.editorKey).toBe(key('CPP'));
    expect(editor.code).toBe('restored source\n');
    expect(editor.draftSavedAt).toBe(Date.now());
    await view!.unmount();
    await mount();
    await act(async () => changeLanguage('CPP'));
    expect(editor.code).toBe('restored source\n');
  });

  it('falls back if storage is unavailable and keeps a cross-language restore in memory', async () => {
    vi.stubGlobal('localStorage', undefined);
    await mount();
    expect(editor.code).toBe(CODE_TEMPLATES.GO);
    await act(async () => expect(editor.restoreDraft('CPP', 'restored source')).toBe(true));
    expect(editor.code).toBe('restored source');
    expect(editor.draftSavedAt).toBeNull();
    await advance(600);
    expect(editor.draftSavedAt).toBeNull();
    await act(async () => editor.setCode('editable even if storage fails'));
    await advance(600);
    expect(editor.code).toBe('editable even if storage fails');
    expect(editor.draftSavedAt).toBeNull();
  });

  it('keeps guest edits in memory without reading or writing drafts and discards them on remount', async () => {
    storage.set('astra-draft:17:GO', '// unowned legacy');
    storage.set(key('GO'), '// private A');
    await mount({ accountId: null });
    expect(editor.code).toBe(CODE_TEMPLATES.GO);
    await act(async () => editor.setCode('guest scratch code'));
    expect(editor.code).toBe('guest scratch code');
    await advance(600);
    await view!.unmount();
    await mount({ accountId: null });
    expect(editor.code).toBe(CODE_TEMPLATES.GO);
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(storage.get('astra-draft:17:GO')).toBe('// unowned legacy');
  });
});
