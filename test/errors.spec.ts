import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli-harness.js';
import { FakeFactusyncServer, FULL_KEY, RIDE_ONLY_KEY } from './fake-factusync-server.js';

const DOCUMENT_ID = '0b9f6f5e-2d53-4b8e-9d0e-3f1f5d2c7a10';

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

describe('the API key', () => {
  it('missing FACTUSYNC_API_KEY exits 3 before any request', async () => {
    const result = await runCli(['context'], { FACTUSYNC_MCP_URL: fake.mcpUrl });

    expect(result.code).toBe(3);
    expect(result.error()).toEqual({
      code: 'MISSING_API_KEY',
      message: expect.stringMatching(/FACTUSYNC_API_KEY/),
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('a blank FACTUSYNC_API_KEY counts as missing', async () => {
    const result = await runCli(['context'], { FACTUSYNC_API_KEY: '  ', FACTUSYNC_MCP_URL: fake.mcpUrl });

    expect(result.code).toBe(3);
    expect(fake.requests).toHaveLength(0);
  });

  it('is sent as X-API-Key on every request', async () => {
    await runCli(['context'], env);

    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((request) => request.apiKey === FULL_KEY)).toBe(true);
  });

  it.each([['--api-key'], ['--key']])('is never accepted as a flag: %s is an unknown option (exit 2, no request)', async (flag) => {
    const withoutEnv = await runCli(['context', flag, FULL_KEY], { FACTUSYNC_MCP_URL: fake.mcpUrl });
    const withEnv = await runCli(['context', flag, FULL_KEY], env);
    const inline = await runCli(['context', `${flag}=${FULL_KEY}`], { FACTUSYNC_MCP_URL: fake.mcpUrl });

    for (const result of [withoutEnv, withEnv, inline]) {
      expect(result.code).toBe(2);
      expect(result.error().code).toBe('USAGE');
      expect(result.stderr).not.toContain(FULL_KEY);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('a key the server rejects (401) exits 3 with UNAUTHORIZED', async () => {
    const result = await runCli(['context'], { FACTUSYNC_API_KEY: 'fs_revoked', FACTUSYNC_MCP_URL: fake.mcpUrl });

    expect(result.code).toBe(3);
    expect(result.error().code).toBe('UNAUTHORIZED');
    expect(result.stdout).toBe('');
  });
});

describe('tool errors', () => {
  it('exit 1 with the code, message and details parsed from the tool error', async () => {
    fake.respond('factusync_emit_document', () => ({
      isError: true,
      content: [
        { type: 'text', text: 'INVALID_STATE_TRANSITION: Only DRAFT documents can be emitted: this one is AUTHORIZED' },
        { type: 'text', text: JSON.stringify({ details: { status: 'AUTHORIZED' } }) },
      ],
    }));

    const result = await runCli(['document', 'emit', DOCUMENT_ID, '--yes'], env);

    expect(result.code).toBe(1);
    expect(result.error()).toEqual({
      code: 'INVALID_STATE_TRANSITION',
      message: 'Only DRAFT documents can be emitted: this one is AUTHORIZED',
      details: { status: 'AUTHORIZED' },
    });
    expect(result.stdout).toBe('');
  });

  it('a message without a code keeps its text under TOOL_ERROR', async () => {
    fake.respond('factusync_get_document', () => ({
      isError: true,
      content: [{ type: 'text', text: `Document ${DOCUMENT_ID} not found.` }],
    }));

    const result = await runCli(['documents', 'get', DOCUMENT_ID], env);

    expect(result.code).toBe(1);
    expect(result.error()).toEqual({ code: 'TOOL_ERROR', message: `Document ${DOCUMENT_ID} not found.` });
  });

  it('a tool the key cannot use exits 1 naming the scope it needs', async () => {
    const result = await runCli(['document', 'emit', DOCUMENT_ID, '--yes'], {
      FACTUSYNC_API_KEY: RIDE_ONLY_KEY,
      FACTUSYNC_MCP_URL: fake.mcpUrl,
    });

    expect(result.code).toBe(1);
    expect(result.error().code).toBe('TOOL_NOT_AVAILABLE');
    expect(result.error().message).toMatch(/documents:emit/);
  });

  it('arguments the server rejects exit 1 with INVALID_INPUT', async () => {
    // `buyer` and `lines` are required by the tool: the server's own validation answers, not the CLI.
    const result = await runCli(['invoice', 'create', '--file', '-'], env, { stdin: '{"externalReference":"x"}' });

    expect(result.code).toBe(1);
    expect(result.error().code).toBe('INVALID_INPUT');
  });
});

describe('network', () => {
  it('a server that refuses the connection exits 3 with NETWORK_ERROR', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const result = await runCli(['context'], { FACTUSYNC_API_KEY: FULL_KEY, FACTUSYNC_MCP_URL: `http://127.0.0.1:${port}/mcp` });

    expect(result.code).toBe(3);
    expect(result.error().code).toBe('NETWORK_ERROR');
  });

  it('a request that times out exits 3 with TIMEOUT', async () => {
    fake.respond('factusync_context', () => new Promise(() => undefined));

    const result = await runCli(['context'], env, { timeoutMs: 300 });

    expect(result.code).toBe(3);
    expect(result.error().code).toBe('TIMEOUT');
  });

  it('an invalid FACTUSYNC_MCP_URL is a usage error before any request', async () => {
    const result = await runCli(['context'], { FACTUSYNC_API_KEY: FULL_KEY, FACTUSYNC_MCP_URL: 'not a url' });

    expect(result.code).toBe(2);
    expect(result.error().code).toBe('USAGE');
    expect(fake.requests).toHaveLength(0);
  });
});
