import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_LOCALES } from '../../i18n/config';

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

  it('messages/es.json contains at least one translation key', () => {
    expect(esKeys.size).toBeGreaterThan(0);
  });

  it("includes 'es' in SUPPORTED_LOCALES", () => {
    expect(SUPPORTED_LOCALES).toContain('es');
  });
});