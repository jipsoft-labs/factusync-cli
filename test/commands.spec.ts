import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli-harness.js';
import { FakeFactusyncServer, FULL_KEY, structured } from './fake-factusync-server.js';

const DOCUMENT_ID = '0b9f6f5e-2d53-4b8e-9d0e-3f1f5d2c7a10';

const INVOICE = {
  externalReference: 'order-1001',
  buyer: { idType: '05', idNumber: '1710034065', name: 'MARIA PEREZ' },
  lines: [{ mainCode: 'SKU-1', description: 'Widget', quantity: 2, unitPrice: 10, ivaRateCode: '4' }],
  payment: { methodCode: '20' },
};

let fake: FakeFactusyncServer;
let env: Record<string, string>;

beforeAll(async () => {
  fake = await FakeFactusyncServer.start();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  env = { FACTUSYNC_API_KEY: FULL_KEY, FACTUSYNC_MCP_URL: fake.mcpUrl };
});

describe('command → tool arguments', () => {
  it('context calls factusync_context with no arguments and prints its structured content', async () => {
    const result = await runCli(['context'], env);

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: 'factusync_context', args: {} }]);
    expect(result.json()).toEqual({ tool: 'factusync_context', args: {} });
    expect(result.stderr).toBe('');
  });

  it('id lookup passes the identification', async () => {
    const result = await runCli(['id', 'lookup', '1790012345001'], env);

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: 'factusync_lookup_id', args: { identification: '1790012345001' } }]);
  });

  it('documents list maps every filter flag to its tool argument, limit and offset as numbers', async () => {
    const result = await runCli(
      [
        'documents',
        'list',
        '--type',
        '01',
        '--status',
        'AUTHORIZED',
        '--from',
        '2026-09-01',
        '--to',
        '2026-09-30',
        '--recipient',
        '1710034065',
        '--limit',
        '5',
        '--offset',
        '10',
      ],
      env,
    );

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([
      {
        tool: 'factusync_list_documents',
        args: {
          documentTypeCode: '01',
          status: 'AUTHORIZED',
          issuedFrom: '2026-09-01',
          issuedTo: '2026-09-30',
          recipientIdentification: '1710034065',
          limit: 5,
          offset: 10,
        },
      },
    ]);
  });

  it('documents list without flags sends no arguments, leaving the defaults to the server', async () => {
    const result = await runCli(['documents', 'list'], env);

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: 'factusync_list_documents', args: {} }]);
  });

  it('documents list rejects a non-integer --limit as a usage error, without calling the server', async () => {
    const result = await runCli(['documents', 'list', '--limit', 'ten'], env);

    expect(result.code).toBe(2);
    expect(result.error().code).toBe('USAGE');
    expect(fake.requests).toHaveLength(0);
  });

  it('documents get passes the id', async () => {
    const result = await runCli(['documents', 'get', DOCUMENT_ID], env);

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: 'factusync_get_document', args: { id: DOCUMENT_ID } }]);
  });

  it('invoice create --file sends the file content as the tool input, unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factusync-cli-'));
    const file = join(dir, 'invoice.json');
    await writeFile(file, JSON.stringify(INVOICE));

    const result = await runCli(['invoice', 'create', '--file', file], env);

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: 'factusync_create_invoice', args: INVOICE }]);
  });

  it('invoice create --file - reads the input from stdin', async () => {
    const result = await runCli(['invoice', 'create', '--file', '-'], env, { stdin: JSON.stringify(INVOICE) });

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: 'factusync_create_invoice', args: INVOICE }]);
  });

  it('invoice create with input that is not a JSON object is a usage error and calls nothing', async () => {
    const notJson = await runCli(['invoice', 'create', '--file', '-'], env, { stdin: '{ not json' });
    const notObject = await runCli(['invoice', 'create', '--file', '-'], env, { stdin: '[1, 2]' });

    expect(notJson.code).toBe(2);
    expect(notJson.error().code).toBe('INVALID_INPUT_FILE');
    expect(notObject.code).toBe(2);
    expect(notObject.error().code).toBe('INVALID_INPUT_FILE');
    expect(fake.requests).toHaveLength(0);
  });

  it('invoice create without --file is a usage error', async () => {
    const result = await runCli(['invoice', 'create'], env);

    expect(result.code).toBe(2);
    expect(fake.requests).toHaveLength(0);
  });

  it('invoice create with a file that cannot be read is a usage error', async () => {
    const result = await runCli(['invoice', 'create', '--file', join(tmpdir(), 'factusync-cli-missing.json')], env);

    expect(result.code).toBe(2);
    expect(result.error().code).toBe('INVALID_INPUT_FILE');
    expect(fake.requests).toHaveLength(0);
  });

  it('document emit --yes passes the id', async () => {
    const result = await runCli(['document', 'emit', DOCUMENT_ID, '--yes'], env);

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: 'factusync_emit_document', args: { id: DOCUMENT_ID } }]);
  });

  it('document emit without --yes is a usage error and sends NO request at all', async () => {
    const result = await runCli(['document', 'emit', DOCUMENT_ID], env);

    expect(result.code).toBe(2);
    expect(result.error().code).toBe('CONFIRMATION_REQUIRED');
    expect(result.error().message).toMatch(/--yes/);
    expect(fake.requests).toHaveLength(0);
    expect(result.stdout).toBe('');
  });

  it('a missing positional argument is a usage error', async () => {
    const result = await runCli(['documents', 'get'], env);

    expect(result.code).toBe(2);
    expect(result.error().code).toBe('USAGE');
    expect(fake.requests).toHaveLength(0);
  });

  it('an extra positional argument is a usage error', async () => {
    const result = await runCli(['documents', 'get', DOCUMENT_ID, 'extra'], env);

    expect(result.code).toBe(2);
    expect(fake.requests).toHaveLength(0);
  });

  it('tools lists what this key can call, with the CLI command for each', async () => {
    const result = await runCli(['tools'], env);

    expect(result.code).toBe(0);
    const { tools } = result.json() as { tools: Array<{ name: string; command: string | null }> };
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'factusync_context',
      'factusync_create_invoice',
      'factusync_emit_document',
      'factusync_get_document',
      'factusync_get_ride',
      'factusync_list_documents',
      'factusync_lookup_id',
    ]);
    expect(tools.find((tool) => tool.name === 'factusync_emit_document')?.command).toBe('factusync document emit <id> --yes');
    expect(fake.calls).toEqual([]);
  });
});

describe('output format', () => {
  it('prints compact JSON on one line by default', async () => {
    fake.respond('factusync_context', () => structured({ company: { ruc: '1790012345001' }, quota: { used: 3 } }));

    const result = await runCli(['context'], env);

    expect(result.stdout).toBe('{"company":{"ruc":"1790012345001"},"quota":{"used":3}}\n');
  });

  it('--pretty indents the same JSON', async () => {
    fake.respond('factusync_context', () => structured({ company: { ruc: '1790012345001' } }));

    const result = await runCli(['context', '--pretty'], env);

    expect(result.stdout).toBe('{\n  "company": {\n    "ruc": "1790012345001"\n  }\n}\n');
  });

  it('falls back to the text content as JSON when a tool returns no structured content', async () => {
    fake.respond('factusync_get_document', () => ({ content: [{ type: 'text', text: '{"status":"DRAFT"}' }] }));

    const result = await runCli(['documents', 'get', DOCUMENT_ID], env);

    expect(result.code).toBe(0);
    expect(result.json()).toEqual({ status: 'DRAFT' });
  });
});

describe('help and version', () => {
  it('--help and -h print the root usage without a key and without a request', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await runCli([flag], {});
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Usage: factusync <command>/);
      expect(result.stdout).toMatch(/FACTUSYNC_API_KEY/);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('no arguments prints the root usage as a usage error', async () => {
    const result = await runCli([], {});

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Usage: factusync <command>/);
  });

  it('each command has its own --help naming its tool and required scope', async () => {
    const result = await runCli(['document', 'emit', '--help'], {});

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/factusync document emit <id> --yes/);
    expect(result.stdout).toMatch(/factusync_emit_document/);
    expect(result.stdout).toMatch(/documents:emit/);
    expect(fake.requests).toHaveLength(0);
  });

  it('--version prints the package version', async () => {
    const result = await runCli(['--version'], {});

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('an unknown command is a usage error', async () => {
    const result = await runCli(['invoices', 'burn'], env);

    expect(result.code).toBe(2);
    expect(result.error().code).toBe('USAGE');
    expect(fake.requests).toHaveLength(0);
  });
});
