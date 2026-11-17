import { LANGUAGES } from '../../lib/format';
import { CODE_TEMPLATES } from '../../lib/templates';
import type { LanguageCode } from '../../lib/types';

export function isStoredEditorLanguage(value: string | null): value is LanguageCode {
  return LANGUAGES.some((language) => language.code === value);
}

export function parseStoredFontSize(value: string | null): number | null {
  const size = Number(value);
  return size >= 11 && size <= 18 ? size : null;
}

export function parseStoredTabSize(value: string | null): number | null {
  const size = Number(value);
  return [2, 4, 8].includes(size) ? size : null;
}

export function resolveDraftCode(language: LanguageCode, draft: string | null): string {
  // Preserve the existing treatment of an empty saved draft as no draft.
  return draft || CODE_TEMPLATES[language];
}
