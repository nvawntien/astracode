import { describe, expect, it } from 'vitest';
import {
  isStoredEditorLanguage,
  parseStoredFontSize,
  parseStoredTabSize,
  resolveDraftCode,
} from '../src/features/problem-workspace/editorStorage';
import { CODE_TEMPLATES, draftKey } from '../src/lib/templates';
import type { LanguageCode } from '../src/lib/types';

const languages: LanguageCode[] = ['GO', 'CPP', 'PYTHON', 'JAVA'];

describe('workspace draft storage contract', () => {
  it('isolates each problem/language pair using the existing key format', () => {
    const drafts = new Map<string, string>();
    for (const problemId of [17, 29]) {
      for (const language of languages) {
        const key = draftKey(problemId, language);
        expect(key).toBe(`astra-draft:${problemId}:${language}`);
        drafts.set(key, `${problemId} ${language} draft\n`);
      }
    }
    expect(drafts.size).toBe(8);
    for (const problemId of [17, 29]) {
      for (const language of languages) {
        expect(resolveDraftCode(language, drafts.get(draftKey(problemId, language)) ?? null)).toBe(
          `${problemId} ${language} draft\n`,
        );
      }
    }
    expect(resolveDraftCode('CPP', drafts.get(draftKey(99, 'CPP')) ?? null)).toBe(
      CODE_TEMPLATES.CPP,
    );
  });

  it.each(languages)('uses the %s template for missing or empty saved code', (language) => {
    expect(resolveDraftCode(language, null)).toBe(CODE_TEMPLATES[language]);
    expect(resolveDraftCode(language, '')).toBe(CODE_TEMPLATES[language]);
  });

  it('preserves whitespace, newlines and raw source instead of parsing or trimming it', () => {
    for (const code of ['   ', '\n\t', 'console.log("test");\n', '{"code":"raw"}']) {
      expect(resolveDraftCode('GO', code)).toBe(code);
    }
  });
});

describe('stored editor preference compatibility', () => {
  it.each(languages)('recognizes the stored language %s', (language) => {
    expect(isStoredEditorLanguage(language)).toBe(true);
  });

  it.each([null, '', 'go', 'C++', 'RUST', ' GO '])(
    'ignores unsupported language %s',
    (language) => {
      expect(isStoredEditorLanguage(language)).toBe(false);
    },
  );

  it.each([
    ['11', 11],
    ['18', 18],
    ['12.5', 12.5],
    [' 13 ', 13],
    ['1.3e1', 13],
  ])('preserves the existing Number conversion for font size %s', (stored, expected) => {
    expect(parseStoredFontSize(String(stored))).toBe(expected);
  });

  it.each([null, '', 'invalid', 'NaN', 'Infinity', '-Infinity', '10', '19'])(
    'ignores missing, malformed or out-of-range font size %s',
    (stored) => {
      expect(parseStoredFontSize(stored)).toBeNull();
    },
  );

  it.each([
    ['2', 2],
    ['4', 4],
    ['8', 8],
    [' 4 ', 4],
  ])('accepts the existing tab size representation %s', (stored, expected) => {
    expect(parseStoredTabSize(String(stored))).toBe(expected);
  });

  it.each([null, '', 'invalid', 'NaN', 'Infinity', '0', '3', '4.5'])(
    'ignores unsupported tab size %s',
    (stored) => {
      expect(parseStoredTabSize(stored)).toBeNull();
    },
  );
});
