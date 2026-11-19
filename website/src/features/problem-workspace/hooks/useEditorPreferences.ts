'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import type { LanguageCode } from '../../../lib/types';
import { isStoredEditorLanguage, parseStoredFontSize, parseStoredTabSize } from '../editorStorage';

/** Global editor preferences retain their original raw-string storage format. */
export function useEditorPreferences() {
  const [language, setLanguage] = useState<LanguageCode>('GO');
  const [fontSize, setFontSize] = useState(13);
  const [tabSize, setTabSize] = useState(4);

  useEffect(() => {
    try {
      const storedLang = localStorage.getItem('astra-lang');
      if (isStoredEditorLanguage(storedLang)) setLanguage(storedLang);
      const storedFont = parseStoredFontSize(localStorage.getItem('astra-font'));
      if (storedFont !== null) setFontSize(storedFont);
      const storedTab = parseStoredTabSize(localStorage.getItem('astra-tab'));
      if (storedTab !== null) setTabSize(storedTab);
    } catch {
      /* ignore */
    }
  }, []);

  const changeLanguage = (next: LanguageCode) => {
    setLanguage(next);
    try {
      localStorage.setItem('astra-lang', next);
    } catch {
      /* ignore */
    }
  };

  const changeFontSize = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    setFontSize(next);
    try {
      localStorage.setItem('astra-font', String(next));
    } catch {
      /* ignore */
    }
  };

  const changeTabSize = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = Number(event.target.value);
    setTabSize(next);
    try {
      localStorage.setItem('astra-tab', String(next));
    } catch {
      /* ignore */
    }
  };

  return {
    language,
    setLanguage,
    changeLanguage,
    fontSize,
    tabSize,
    changeFontSize,
    changeTabSize,
  };
}
