'use client';

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { CODE_TEMPLATES, draftKey } from '../../../lib/templates';
import type { LanguageCode, Problem } from '../../../lib/types';
import { resolveDraftCode } from '../editorStorage';

interface EditorDraftOptions {
  problem: Pick<Problem, 'id'> | null;
  language: LanguageCode;
  setLanguage: Dispatch<SetStateAction<LanguageCode>>;
}

export function useEditorDraft({ problem, language, setLanguage }: EditorDraftOptions) {
  const [code, setCode] = useState<string>(CODE_TEMPLATES.GO);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);

  // Keep the problem object dependency: even a refreshed problem reloads its draft.
  useEffect(() => {
    if (!problem) return;
    try {
      setCode(resolveDraftCode(language, localStorage.getItem(draftKey(problem.id, language))));
    } catch {
      setCode(CODE_TEMPLATES[language]);
    }
    setDraftSavedAt(null);
  }, [problem, language]);

  useEffect(() => {
    if (!problem) return;
    const id = setTimeout(() => {
      try {
        localStorage.setItem(draftKey(problem.id, language), code);
        setDraftSavedAt(Date.now());
      } catch {
        /* quota exceeded — the editor still works, just without a draft */
      }
    }, 600);
    return () => clearTimeout(id);
  }, [code, problem, language]);

  const resetCode = () => setCode(CODE_TEMPLATES[language]);

  const restoreDraft = useCallback(
    (nextLanguage: LanguageCode, sourceCode: string) => {
      if (!problem) return;
      try {
        localStorage.setItem('astra-lang', nextLanguage);
        localStorage.setItem(draftKey(problem.id, nextLanguage), sourceCode);
      } catch {
        /* editor still updates even if local draft persistence is unavailable */
      }

      setLanguage(nextLanguage);
      setCode(sourceCode);
      setDraftSavedAt(Date.now());
    },
    [problem, setLanguage],
  );

  return { code, setCode, draftSavedAt, resetCode, restoreDraft };
}
