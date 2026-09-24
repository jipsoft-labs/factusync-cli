import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli-harness.js';
import { FAKE_PDF, FakeFactusyncServer, FULL_KEY, RIDE_ONLY_KEY, structured } from './fake-factusync-server.js';

const DOCUMENT_ID = '0b9f6f5e-2d53-4b8e-9d0e-3f1f5d2c7a10';

let fake: FakeFactusyncServer;
let env: Record<string, string>;
let dir: string;

beforeAll(async () => {
  fake = await FakeFactusyncServer.start();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  env = { FACTUSYNC_API_KEY: FULL_KEY, FACTUSYNC_MCP_URL: fake.mcpUrl };
  dir = await mkdtemp(join(tmpdir(), 'factusync-cli-ride-'));
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('factusync ride', () => {
  it('without --out/--xml prints the tool result and downloads nothing', async () => {
    const result = await runCli(['ride', DOCUMENT_ID], env);

    expect(result.code).toBe(0);
    expect(fake.calls).toEqual([{ tool: 'factusync_get_ride', args: { id: DOCUMENT_ID } }]);
    expect(result.json()).toMatchObject({ documentId: DOCUMENT_ID, rideUrl: `${fake.baseUrl}/documents/${DOCUMENT_ID}/ride` });
    expect(fake.requests.filter((request) => request.url.startsWith('/documents/'))).toHaveLength(0);
  });

  it('--out writes the PDF fetched from rideUrl with the X-API-Key header', async () => {
    const out = join(dir, 'ride.pdf');

    const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env);

    expect(result.code).toBe(0);
    expect(await readFile(out)).toEqual(FAKE_PDF);
    expect(fake.requests.filter((request) => request.url.startsWith('/documents/'))).toEqual([
      { method: 'GET', url: `/documents/${DOCUMENT_ID}/ride`, apiKey: FULL_KEY },
    ]);
    expect(result.json()).toMatchObject({ documentId: DOCUMENT_ID, rideFile: out });
  });

  it('--xml writes the authorized XML and leaves it out of stdout', async () => {
    const xml = join(dir, 'invoice.xml');

    const result = await runCli(['ride', DOCUMENT_ID, '--xml', xml], env);

    expect(result.code).toBe(0);
    expect(await readFile(xml, 'utf8')).toBe('<factura id="comprobante"/>');
    const printed = result.json() as Record<string, unknown>;
    expect(printed['xmlFile']).toBe(xml);
    expect(printed).not.toHaveProperty('xml');
  });

  it('--xml with a key that gets no XML fails clearly and writes no file at all', async () => {
    const out = join(dir, 'ride.pdf');
    const xml = join(dir, 'invoice.xml');

    const result = await runCli(['ride', DOCUMENT_ID, '--out', out, '--xml', xml], {
      FACTUSYNC_API_KEY: RIDE_ONLY_KEY,
      FACTUSYNC_MCP_URL: fake.mcpUrl,
    });

    expect(result.code).toBe(1);
    expect(result.error().code).toBe('XML_NOT_AVAILABLE');
    expect(result.error().message).toMatch(/documents:read/);
    expect(await exists(xml)).toBe(false);
    expect(await exists(out)).toBe(false);
  });

  it('--xml refuses to write an XML the server truncated', async () => {
    fake.respond('factusync_get_ride', () =>
      structured({ documentId: DOCUMENT_ID, rideUrl: `${fake.baseUrl}/documents/${DOCUMENT_ID}/ride`, xml: '<factura', xmlTruncated: true }),
    );
    const xml = join(dir, 'invoice.xml');

    const result = await runCli(['ride', DOCUMENT_ID, '--xml', xml], env);

    expect(result.code).toBe(1);
    expect(result.error().code).toBe('XML_TRUNCATED');
    expect(await exists(xml)).toBe(false);
  });

  it('never sends the key to a rideUrl on another origin than FACTUSYNC_MCP_URL', async () => {
    fake.respond('factusync_get_ride', () =>
      structured({ documentId: DOCUMENT_ID, rideUrl: `https://attacker.example/documents/${DOCUMENT_ID}/ride` }),
    );
    const out = join(dir, 'ride.pdf');

    const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env);

    expect(result.code).toBe(1);
    expect(result.error().code).toBe('RIDE_URL_UNTRUSTED');
    expect(await exists(out)).toBe(false);
  });

  it('a RIDE download the API rejects (401) exits 3', async () => {
    fake.respond('factusync_get_ride', () =>
      structured({ documentId: DOCUMENT_ID, rideUrl: `${fake.baseUrl}/documents/${DOCUMENT_ID}/ride` }),
    );
    const out = join(dir, 'ride.pdf');
    const rejectRide: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/ride')) return Promise.resolve(new Response('{"code":"UNAUTHORIZED"}', { status: 401 }));
      return fetch(input, init);
    };

    const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env, { fetch: rejectRide });

    expect(result.code).toBe(3);
    expect(result.error().code).toBe('UNAUTHORIZED');
    expect(await exists(out)).toBe(false);
  });
});
