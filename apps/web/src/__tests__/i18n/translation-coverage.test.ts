import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Recursively collect all leaf key paths from a JSON object.
 * Arrays are treated as leaves (their contents are not traversed for key parity),
 * since translation files typically store arrays as a single translatable value.
 */
function collectKeyPaths(value: JsonValue, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return prefix ? [prefix] : [];
  }

  return keys.flatMap((key) => {
    const childPath = prefix ? `${prefix}.${key}` : key;
    return collectKeyPaths(value[key], childPath);
  });
}

function loadMessages(locale: string): JsonValue {
  const filePath = path.resolve(process.cwd(), 'messages', `${locale}.json`);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as JsonValue;
}

describe('i18n translation coverage', () => {
  const enKeys = new Set(collectKeyPaths(loadMessages('en')));
  const esKeys = new Set(collectKeyPaths(loadMessages('es')));
  const ptBRKeys = new Set(collectKeyPaths(loadMessages('pt-BR')));
  const locales = ['fr', 'es'] as const;

  it('messages/es.json has the same key set as messages/en.json', () => {
    const missingInEs = [...enKeys].filter((key) => !esKeys.has(key)).sort();
    const extraInEs = [...esKeys].filter((key) => !enKeys.has(key)).sort();

    expect(
      { missingInEs, extraInEs },
      `Translation key parity mismatch between en.json and es.json.\n` +
        `Missing in es.json: ${missingInEs.length ? missingInEs.join(', ') : 'none'}\n` +
        `Extra in es.json: ${extraInEs.length ? extraInEs.join(', ') : 'none'}`,
    ).toEqual({ missingInEs: [], extraInEs: [] });
  });

  it('messages/pt-BR.json has the same key set as messages/en.json', () => {
    const missingInPtBR = [...enKeys].filter((key) => !ptBRKeys.has(key)).sort();
    const extraInPtBR = [...ptBRKeys].filter((key) => !enKeys.has(key)).sort();

    expect(
      { missingInPtBR, extraInPtBR },
      `Translation key parity mismatch between en.json and pt-BR.json.\n` +
        `Missing in pt-BR.json: ${missingInPtBR.length ? missingInPtBR.join(', ') : 'none'}\n` +
        `Extra in pt-BR.json: ${extraInPtBR.length ? extraInPtBR.join(', ') : 'none'}`,
    ).toEqual({ missingInPtBR: [], extraInPtBR: [] });
  });

  it('messages/en.json contains at least one translation key', () => {
    expect(enKeys.size).toBeGreaterThan(0);
  });

  it.each(locales)('messages/%s.json has the same key set as messages/en.json', (locale) => {
    const localeKeys = new Set(collectKeyPaths(loadMessages(locale)));

    const missing = [...enKeys].filter((key) => !localeKeys.has(key)).sort();
    const extra = [...localeKeys].filter((key) => !enKeys.has(key)).sort();

    expect(
      { missing, extra },
      `Translation key parity mismatch between en.json and ${locale}.json.\n` +
        `Missing in ${locale}.json: ${missing.length ? missing.join(', ') : 'none'}\n` +
        `Extra in ${locale}.json: ${extra.length ? extra.join(', ') : 'none'}`,
    ).toEqual({ missing: [], extra: [] });
  });

  it('all locale files have identical key sets', () => {
    const allLocales = ['en', ...locales];
    const keySets = allLocales.map((locale) => ({
      locale,
      keys: new Set(collectKeyPaths(loadMessages(locale))),
    }));

    const mismatches = keySets
      .filter(({ keys }) => {
        if (keys.size !== enKeys.size) return true;
        return [...enKeys].some((key) => !keys.has(key));
      })
      .map(({ locale }) => locale);

    expect(
      mismatches,
      `Locales with key sets differing from en.json: ${mismatches.length ? mismatches.join(', ') : 'none'}`,
    ).toEqual([]);
  });
});

describe('language switcher', () => {
  it('reflects the active locale', async () => {
    const { getActiveLocale, SUPPORTED_LOCALES } = await import('@/lib/i18n');

    for (const locale of SUPPORTED_LOCALES) {
      expect(getActiveLocale(locale)).toBe(locale);
    }

    // Falls back to the default locale for unsupported values.
    expect(getActiveLocale('xx')).toBe('en');
    expect(getActiveLocale(undefined)).toBe('en');
  });
});