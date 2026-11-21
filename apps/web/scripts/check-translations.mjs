#!/usr/bin/env node
/**
 * Translation coverage checker.
 *
 * Recursively compares the keys in messages/en.json (source) against
 * each target locale (default: es, pt-BR) and reports:
 *   - missing keys (present in EN, absent in target)
 *   - extra keys   (present in target, absent in EN)
 *
 * It also scans component source files for hardcoded English strings
 * (JSX text nodes and common user-visible props) and reports them.
 *
 * Exits non-zero when any target locale's coverage is below 100% or when
 * hardcoded English strings are detected in component files.
 *
 * Usage: node scripts/check-translations.mjs [--source en] [--target es] [--target pt-BR]
 *        [--no-scan] [--scan-dir <path>]...
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = resolve(__dirname, "..", "messages");
const DEFAULT_SCAN_DIRS = [resolve(__dirname, "..", "src")];

const DEFAULT_TARGETS = ["es", "pt-BR"];

function parseArgs(argv) {
  const args = {
    source: "en",
    targets: [],
    scan: true,
    scanDirs: [...DEFAULT_SCAN_DIRS],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source" && argv[i + 1]) {
      args.source = argv[++i];
    } else if (arg === "--target" && argv[i + 1]) {
      args.targets.push(argv[++i]);
    } else if (arg.startsWith("--source=")) {
      args.source = arg.slice("--source=".length);
    } else if (arg.startsWith("--target=")) {
      args.targets.push(arg.slice("--target=".length));
    } else if (arg === "--no-scan") {
      args.scan = false;
    } else if (arg === "--scan-dir" && argv[i + 1]) {
      if (args.scanDirs === DEFAULT_SCAN_DIRS) args.scanDirs = [];
      args.scanDirs.push(resolve(argv[++i]));
    } else if (arg.startsWith("--scan-dir=")) {
      if (args.scanDirs === DEFAULT_SCAN_DIRS) args.scanDirs = [];
      args.scanDirs.push(resolve(arg.slice("--scan-dir=".length)));
    }
  }
  if (args.targets.length === 0) {
    args.targets = [...DEFAULT_TARGETS];
  }
  return args;
}

function loadJson(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`Failed to read ${filePath}: ${err.message}`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${filePath}: ${err.message}`);
    process.exit(2);
  }
}

/**
 * Recursively collect all leaf key paths from an object.
 * Leaf = any non-plain-object value (string, number, boolean, array, null).
 * Arrays are treated as leaves so their contents are not diffed key-by-key.
 */
function collectKeys(obj, prefix = "", out = new Set()) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    if (prefix) out.add(prefix);
    return out;
  }
  const entries = Object.entries(obj);
  if (entries.length === 0 && prefix) {
    // Empty object — treat as a leaf so it is still tracked.
    out.add(prefix);
    return out;
  }
  for (const [key, value] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      collectKeys(value, path, out);
    } else {
      out.add(path);
    }
  }
  return out;
}

const SCAN_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage"]);

// Props whose string values are rendered to the user and must be translated.
const USER_VISIBLE_PROPS = [
  "placeholder",
  "title",
  "alt",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "label",
  "helperText",
  "description",
];

// Matches JSX text nodes: text between a `>` and the next `<` on the same line.
const JSX_TEXT_RE = />([^<>{}]+)</g;

// Matches `prop="literal"` and `prop='literal'` for user-visible props.
const PROP_RE = new RegExp(
  `\\b(${USER_VISIBLE_PROPS.join("|")})\\s*=\\s*(["'])([^"']*)\\2`,
  "g"
);

// Matches `prop={"literal"}` / `prop={'literal'}` for user-visible props.
const PROP_EXPR_RE = new RegExp(
  `\\b(${USER_VISIBLE_PROPS.join("|")})\\s*=\\s*\\{\\s*(["'])([^"']*)\\2\\s*\\}`,
  "g"
);

// Matches toast/error helper calls with a literal English message, e.g.
// toast.error("Something went wrong") or setError('Failed to save').
const CALL_RE =
  /\b(?:toast(?:\.(?:error|success|info|warning|message))?|setError|setMessage|setStatus|alert)\s*\(\s*(["'])([^"']*)\1/g;

// A string is considered translatable English if it contains at least one
// letter and is not purely a symbol/number/whitespace token.
function looksLikeEnglish(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/[A-Za-z]/.test(trimmed)) return false;
  // Ignore single characters, CSS-ish tokens, and obvious identifiers.
  if (trimmed.length < 2) return false;
  if (/^[a-z0-9_-]+$/i.test(trimmed) && !/\s/.test(trimmed) && trimmed.length < 4) {
    return false;
  }
  return true;
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(full, out);
    } else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function scanFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  const findings = [];

  const collect = (re, group) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      const text = match[group];
      if (looksLikeEnglish(text)) {
        findings.push({ line: lineOf(source, match.index), text: text.trim() });
      }
    }
  };

  collect(JSX_TEXT_RE, 1);
  collect(PROP_RE, 3);
  collect(PROP_EXPR_RE, 3);
  collect(CALL_RE, 2);

  return findings;
}

function scanComponents(scanDirs) {
  const results = [];
  for (const dir of scanDirs) {
    for (const file of walkFiles(dir)) {
      const findings = scanFile(file);
      if (findings.length > 0) {
        results.push({ file, findings });
      }
    }
  }
  return results;
}

/**
 * Check a single target locale against the source keys.
 * Returns true when the target is fully in sync (no missing or extra keys)
 * and no hardcoded English strings are detected.
 */
function checkTarget(source, sourceKeys, target, scan, scanDirs) {
  const targetPath = resolve(MESSAGES_DIR, `${target}.json`);
  const targetJson = loadJson(targetPath);
  const targetKeys = collectKeys(targetJson);

  const missing = [...sourceKeys].filter((k) => !targetKeys.has(k)).sort();
  const extra = [...targetKeys].filter((k) => !sourceKeys.has(k)).sort();

  const total = sourceKeys.size;
  const covered = total - missing.length;
  const coverage = total === 0 ? 100 : (covered / total) * 100;

  console.log(`Translation coverage check: ${source} -> ${target}`);
  console.log(`  Source keys (${source}): ${total}`);
  console.log(`  Target keys (${target}): ${targetKeys.size}`);
  console.log(`  Covered: ${covered}/${total} (${coverage.toFixed(2)}%)`);

  if (missing.length > 0) {
    console.log(`\nMissing keys in ${target}.json (${missing.length}):`);
    for (const key of missing) {
      console.log(`  - ${key}`);
    }
  }

  if (extra.length > 0) {
    console.log(`\nExtra keys in ${target}.json not present in ${source}.json (${extra.length}):`);
    for (const key of extra) {
      console.log(`  + ${key}`);
    }
  }

  let hardcodedCount = 0;
  if (scan) {
    const scanResults = scanComponents(scanDirs);
    hardcodedCount = scanResults.reduce(
      (sum, r) => sum + r.findings.length,
      0
    );
    if (hardcodedCount > 0) {
      console.error(
        `\nHardcoded English strings detected in component files (${hardcodedCount}):`
      );
      for (const { file, findings } of scanResults) {
        console.error(`  ${relative(resolve(__dirname, ".."), file)}`);
        for (const { line, text } of findings) {
          console.error(`    ${line}: "${text}"`);
        }
      }
      console.error(
        "\nExtract these strings into messages/*.json and reference them via the i18n helper."
      );
    }
  }

  const keysInSync = missing.length === 0 && extra.length === 0;
  if (keysInSync) {
    console.log(`\n✓ ${target}.json is fully in sync with ${source}.json.`);
  }

  if (coverage < 100) {
    console.error(
      `\n✗ Translation coverage for "${target}" is ${coverage.toFixed(2)}%, below the required 100%.`
    );
  }

  if (coverage < 100 || hardcodedCount > 0) {
    return false;
  }

  if (!keysInSync) {
    // Coverage is 100% but there are extra keys — warn but do not fail.
    console.warn(
      `\n⚠ ${target}.json has extra keys not present in ${source}.json. Coverage is 100%.`
    );
  }

  return true;
}

function main() {
  const { source, targets, scan, scanDirs } = parseArgs(process.argv.slice(2));

  const sourcePath = resolve(MESSAGES_DIR, `${source}.json`);
  const sourceJson = loadJson(sourcePath);
  const sourceKeys = collectKeys(sourceJson);

  let allOk = true;
  for (const target of targets) {
    console.log("");
    const ok = checkTarget(source, sourceKeys, target, scan, scanDirs);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    process.exit(1);
  }

  process.exit(0);
}

main();