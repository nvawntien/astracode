'use client';

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { CODE_TEMPLATES, draftKey } from '../../../lib/templates';
import type { LanguageCode } from '../../../lib/types';
import { resolveDraftCode } from '../editorStorage';

interface EditorDraftOptions {
  accountId: string | null;
  authLoading: boolean;
  problemId: number | undefined;
  language: LanguageCode;
  setLanguage: Dispatch<SetStateAction<LanguageCode>>;
}

interface DraftSnapshot {
  key: string;
  code: string;
  savedAt: number | null;
  dirty: boolean;
}

export function useEditorDraft({
  accountId,
  authLoading,
  problemId,
  language,
  setLanguage,
}: EditorDraftOptions) {
  const scope = useMemo(() => {
    if (authLoading || problemId === undefined) return null;
    const storageKey = accountId === null ? null : draftKey(accountId, problemId, language);
    return {
      accountId,
      problemId,
      storageKey,
      key: storageKey ?? JSON.stringify([null, problemId, language]),
    };
  }, [accountId, authLoading, problemId, language]);
  const activeScope = useRef<typeof scope>(null);
  const [snapshot, setSnapshot] = useState<DraftSnapshot | null>(null);
  const draft = scope && snapshot?.key === scope.key ? snapshot : null;
  const ready = draft !== null;

  useLayoutEffect(() => {
    activeScope.current = scope;
    if (!scope) {
      setSnapshot(null);
    } else {
      let savedCode: string | null = null;
      try {
        if (scope.storageKey) savedCode = localStorage.getItem(scope.storageKey);
      } catch {
        /* Editing is available even if storage is not. */
      }
      const loaded = {
        key: scope.key,
        code: resolveDraftCode(language, savedCode),
        savedAt: null,
        dirty: false,
      };
      // Restore can supply the destination language's snapshot in the same
      // batch as the language change, even when storage is unavailable.
      setSnapshot((current) => (current?.key === scope.key ? current : loaded));
    }
    return () => {
      activeScope.current = null;
    };
  }, [scope, language]);

  const isCurrentDraft = useCallback(
    () => ready && scope !== null && activeScope.current === scope,
    [ready, scope],
  );

  useLayoutEffect(() => {
    const storageKey = scope?.storageKey;
    if (!storageKey || !draft?.dirty) return;
    const timer = setTimeout(() => {
      if (activeScope.current !== scope) return;
      try {
        localStorage.setItem(storageKey, draft.code);
        const savedAt = Date.now();
        setSnapshot((current) =>
          current === draft ? { ...draft, dirty: false, savedAt } : current,
        );
      } catch {
        /* quota exceeded — keep the source available in the editor */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [scope, draft]);

  const setCode = (code: string) => {
    if (!scope || !isCurrentDraft()) return;
    setSnapshot((current) =>
      current?.key === scope.key ? { ...current, code, dirty: true } : current,
    );
  };

  const restoreDraft = useCallback(
    (nextLanguage: LanguageCode, sourceCode: string) => {
      if (!scope || scope.accountId === null || !isCurrentDraft()) return false;

      const key = draftKey(scope.accountId, scope.problemId, nextLanguage);
      let savedAt: number | null = null;
      try {
        localStorage.setItem('astra-lang', nextLanguage);
        localStorage.setItem(key, sourceCode);
        savedAt = Date.now();
      } catch {
        /* Restore the source in memory even when storage is unavailable. */
      }

      setSnapshot({ key, code: sourceCode, savedAt, dirty: savedAt === null });
      setLanguage(nextLanguage);
      return true;
    },
    [isCurrentDraft, scope, setLanguage],
  );

  return {
    code: draft?.code ?? CODE_TEMPLATES[language],
    setCode,
    draftSavedAt: draft?.savedAt ?? null,
    resetCode: () => setCode(CODE_TEMPLATES[language]),
    restoreDraft,
    editorKey: scope?.key,
    ready,
    isCurrentDraft,
  };
}
