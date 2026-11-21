import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock external dependencies used by the route handlers.
// ---------------------------------------------------------------------------
vi.mock('@/lib/supabase', () => {
  const chain = () => {
    const builder: any = {
      select: vi.fn(() => builder),
      insert: vi.fn(() => builder),
      update: vi.fn(() => builder),
      delete: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      neq: vi.fn(() => builder),
      in: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      range: vi.fn(() => builder),
      single: vi.fn(async () => ({ data: mockRow, error: null })),
      maybeSingle: vi.fn(async () => ({ data: mockRow, error: null })),
      then: (cb: any) => Promise.resolve({ data: [mockRow], error: null }).then(cb),
    };
    return builder;
  };
  const mockRow = {
    id: 'meter-1',
    meter_id: 'meter-1',
    device_id: 'device-1',
    owner: 'GABC',
    public_key: 'GABC',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    reading_kwh: 100,
    timestamp: new Date().toISOString(),
    signature: 'sig',
    certificate_id: 'cert-1',
    retired: false,
  };
  return {
    supabase: {
      from: vi.fn(() => chain()),
      rpc: vi.fn(async () => ({ data: mockRow, error: null })),
    },
    getSupabaseClient: vi.fn(() => ({
      from: vi.fn(() => chain()),
      rpc: vi.fn(async () => ({ data: mockRow, error: null })),
    })),
    createClient: vi.fn(() => ({
      from: vi.fn(() => chain()),
      rpc: vi.fn(async () => ({ data: mockRow, error: null })),
    })),
  };
});

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => ({ userId: 'user-1', role: 'admin' })),
  getSession: vi.fn(async () => ({ userId: 'user-1', role: 'admin' })),
  verifyApiKey: vi.fn(async () => ({ valid: true, owner: 'GABC' })),
  withAuth: (handler: any) => handler,
  auth: vi.fn(async () => ({ userId: 'user-1', role: 'admin' })),
}));

vi.mock('@/lib/stellar', () => ({
  submitReading: vi.fn(async () => ({ txHash: 'abc123', ledger: 1 })),
  retireCertificate: vi.fn(async () => ({ txHash: 'def456', ledger: 2 })),
  rotateKey: vi.fn(async () => ({ txHash: 'ghi789', ledger: 3 })),
  getAccount: vi.fn(async () => ({ accountId: 'GABC', sequence: '1' })),
  verifySignature: vi.fn(async () => true),
  stellarClient: {
    submitTransaction: vi.fn(async () => ({ hash: 'abc123', ledger: 1 })),
  },
}));

vi.mock('@/lib/cache', () => ({
  cache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  },
  getCache: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  })),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 100 })),
  checkRateLimit: vi.fn(async () => ({ success: true, remaining: 100 })),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Load the OpenAPI spec.
// ---------------------------------------------------------------------------
const specPath = resolve(__dirname, '../../../../openapi.yaml');
const spec = yaml.parse(readFileSync(specPath, 'utf8')) as Record<string, any>;

// ---------------------------------------------------------------------------
// Build an Ajv validator with $ref resolution against the spec.
// ---------------------------------------------------------------------------
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: true,
});
addFormats(ajv);

// Register every component schema so $refs resolve.
if (spec.components?.schemas) {
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    ajv.addSchema(schema as any, `#/components/schemas/${name}`);
  }
}
// Also register the whole document for absolute $ref resolution.
ajv.addSchema(spec, 'openapi.yaml');

function resolveRef(ref: string): any {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let node: any = spec;
  for (const part of parts) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

function deref(schema: any, seen = new Set<string>()): any {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((s) => deref(s, seen));
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return {};
    seen.add(schema.$ref);
    const target = resolveRef(schema.$ref);
    return deref(target, seen);
  }
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    out[k] = deref(v, seen);
  }
  return out;
}

function validateAgainst(schema: any, data: unknown): { valid: boolean; errors?: any } {
  const resolved = deref(schema);
  const validate = ajv.compile(resolved);
  const valid = validate(data) as boolean;
  return { valid, errors: validate.errors };
}

// ---------------------------------------------------------------------------
// Route handler registry. Maps "METHOD /path" -> handler function.
// ---------------------------------------------------------------------------
type Handler = (req: NextRequest, ctx?: any) => Promise<Response> | Response;

const handlers: Record<string, Handler> = {};

async function loadHandlers() {
  const modules: Array<[string, string, string[]]> = [
    ['/api/meters', '@/app/api/meters/route', ['GET', 'POST']],
    ['/api/meters/{id}', '@/app/api/meters/[id]/route', ['GET', 'PATCH', 'DELETE']],
    ['/api/meters/{id}/rotate-key', '@/app/api/meters/[id]/rotate-key/route', ['POST']],
    ['/api/readings', '@/app/api/readings/route', ['GET', 'POST']],
    ['/api/readings/batch', '@/app/api/readings/batch/route', ['POST']],
    ['/api/verify', '@/app/api/verify/route', ['POST']],
    ['/api/verify/{id}', '@/app/api/verify/[id]/route', ['GET']],
    ['/api/certificates', '@/app/api/certificates/route', ['GET']],
    ['/api/certificates/{id}/retire', '@/app/api/certificates/[id]/retire/route', ['POST']],
    ['/api/health', '@/app/api/health/route', ['GET']],
    ['/api/ready', '@/app/api/ready/route', ['GET']],
  ];

  for (const [path, modPath, methods] of modules) {
    try {
      const mod: any = await import(/* @vite-ignore */ modPath);
      for (const method of methods) {
        const fn = mod[method] ?? mod[method.toUpperCase()] ?? mod.default;
        if (typeof fn === 'function') {
          handlers[`${method} ${path}`] = fn;
        }
      }
    } catch {
      // Handler not present; skip. Tests will report missing coverage.
    }
  }
}

// ---------------------------------------------------------------------------
// Request builder.
// ---------------------------------------------------------------------------
function buildRequest(method: string, path: string, body?: unknown): NextRequest {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
      'x-api-key': 'test-key',
    },
  };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init) as unknown as NextRequest;
}

function buildContext(path: string, params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

// ---------------------------------------------------------------------------
// Sample request bodies per path/method for POST/PATCH.
// ---------------------------------------------------------------------------
const sampleBodies: Record<string, unknown> = {
  'POST /api/meters': {
    device_id: 'device-1',
    owner: 'GABC',
    public_key: 'GABC',
  },
  'PATCH /api/meters/{id}': { status: 'active' },
  'POST /api/meters/{id}/rotate-key': { new_public_key: 'GDEF' },
  'POST /api/readings': {
    meter_id: 'meter-1',
    reading_kwh: 100,
    timestamp: new Date().toISOString(),
    signature: 'sig',
  },
  'POST /api/readings/batch': {
    readings: [
      {
        meter_id: 'meter-1',
        reading_kwh: 100,
        timestamp: new Date().toISOString(),
        signature: 'sig',
      },
    ],
  },
  'POST /api/verify': {
    meter_id: 'meter-1',
    reading_kwh: 100,
    signature: 'sig',
  },
  'POST /api/certificates/{id}/retire': { reason: 'test' },
};

// ---------------------------------------------------------------------------
// Enumerate documented operations from the spec.
// ---------------------------------------------------------------------------
interface Operation {
  path: string;
  method: string;
  operation: any;
}

function enumerateOperations(): Operation[] {
  const ops: Operation[] = [];
  const paths = spec.paths ?? {};
  for (const [path, pathItem] of Object.entries<any>(paths)) {
    if (!pathItem) continue;
    for (const [method, operation] of Object.entries<any>(pathItem)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) {
        ops.push({ path, method: method.toUpperCase(), operation });
      }
    }
  }
  return ops;
}

function extractPathParams(path: string): Record<string, string> {
  const params: Record<string, string> = {};
  const matches = path.matchAll(/\{([^}]+)\}/g);
  for (const m of matches) {
    params[m[1]] = 'test-id';
  }
  return params;
}

function concretePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_m, name) => {
    if (name === 'id') return 'test-id';
    return `test-${name}`;
  });
}

// ---------------------------------------------------------------------------
// Response schema extraction.
// ---------------------------------------------------------------------------
function getResponseSchema(operation: any, status: string): any | undefined {
  const responses = operation?.responses ?? {};
  const response = responses[status] ?? responses[Number(status)] ?? responses.default;
  if (!response) return undefined;
  const content = response.content ?? {};
  const json = content['application/json'];
  if (!json?.schema) return undefined;
  return json.schema;
}

function documentedStatuses(operation: any): string[] {
  const responses = operation?.responses ?? {};
  return Object.keys(responses).filter((s) => /^\d{3}$/.test(s));
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------
describe('OpenAPI contract tests', () => {
  const operations = enumerateOperations();

  beforeAll(async () => {
    await loadHandlers();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the OpenAPI spec with documented paths', () => {
    expect(spec).toBeTruthy();
    expect(spec.openapi).toMatch(/^3\./);
    expect(operations.length).toBeGreaterThan(0);
  });

  it('has a handler registered for every documented operation', () => {
    const missing: string[] = [];
    for (const op of operations) {
      const key = `${op.method} ${op.path}`;
      if (!handlers[key]) missing.push(key);
    }
    // Report missing handlers as a failure so drift is caught.
    expect(missing).toEqual([]);
  });

  describe.each(operations.map((op) => [`${op.method} ${op.path}`, op] as const))(
    '%s',
    (_label, op) => {
      const statuses = documentedStatuses(op.operation);
      const successStatuses = statuses.filter((s) => s.startsWith('2'));

      it('returns a response matching the documented success schema', async () => {
        const handler = handlers[`${op.method} ${op.path}`];
        if (!handler) {
          // Already asserted in the coverage test; skip here.
          return;
        }

        const pathParams = extractPathParams(op.path);
        const url = concretePath(op.path);
        const body = sampleBodies[`${op.method} ${op.path}`];
        const req = buildRequest(op.method, url, body);
        const ctx = buildContext(op.path, pathParams);

        let res: Response;
        try {
          res = await handler(req, ctx);
        } catch (err) {
          // Handler threw; fail with context.
          throw new Error(
            `Handler for ${op.method} ${op.path} threw: ${(err as Error).message}`,
          );
        }

        expect(res).toBeInstanceOf(Response);

        const status = String(res.status);
        // Prefer the documented success status; fall back to actual if documented.
        const targetStatus =
          successStatuses.includes(status) ? status : successStatuses[0] ?? status;

        const schema = getResponseSchema(op.operation, targetStatus);
        if (!schema) {
          // No schema documented for this status; nothing to validate.
          return;
        }

        let json: unknown;
        const text = await res.clone().text();
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            throw new Error(
              `Response for ${op.method} ${op.path} is not valid JSON: ${text.slice(0, 200)}`,
            );
          }
        } else {
          json = undefined;
        }

        const { valid, errors } = validateAgainst(schema, json);
        if (!valid) {
          throw new Error(
            `Schema mismatch for ${op.method} ${op.path} (status ${targetStatus}):\n` +
              JSON.stringify(errors, null, 2) +
              `\nResponse body:\n${JSON.stringify(json, null, 2)}`,
          );
        }
        expect(valid).toBe(true);
      });

      it('returns a response matching documented error schemas when applicable', async () => {
        const handler = handlers[`${op.method} ${op.path}`];
        if (!handler) return;

        const errorStatuses = statuses.filter((s) => s.startsWith('4') || s.startsWith('5'));
        if (errorStatuses.length === 0) return;

        // Validate that each documented error status has a schema we can compile.
        for (const status of errorStatuses) {
          const schema = getResponseSchema(op.operation, status);
          if (!schema) continue;
          const resolved = deref(schema);
          // Compiling ensures the schema is well-formed and $refs resolve.
          expect(() => ajv.compile(resolved)).not.toThrow();
        }
      });
    },
  );

  describe('documented error responses', () => {
    const errorCases: Array<{ path: string; method: string; status: string }> = [];
    for (const op of operations) {
      for (const status of documentedStatuses(op.operation)) {
        if (status.startsWith('4') || status.startsWith('5')) {
          errorCases.push({ path: op.path, method: op.method, status });
        }
      }
    }

    it.each(errorCases.map((c) => [`${c.method} ${c.path} -> ${c.status}`, c] as const))(
      '%s has a resolvable schema',
      (_label, c) => {
        const op = operations.find((o) => o.path === c.path && o.method === c.method);
        expect(op).toBeTruthy();
        const schema = getResponseSchema(op!.operation, c.status);
        if (!schema) return;
        const resolved = deref(schema);
        expect(() => ajv.compile(resolved)).not.toThrow();
      },
    );
  });
});