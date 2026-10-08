import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli-harness.js';
import { FAKE_PDF, FakeFactusyncServer, FULL_KEY, RIDE_ONLY_KEY, structured } from './fake-factusync-server.js';

const DOCUMENT_ID = '0b9f6f5e-2d53-4b8e-9d0e-3f1f5d2c7a10';
const ACCESS_KEY = '2409202601179001234500120010010000001231234567811';
const NOW = new Date('2026-10-07T15:30:12.345Z');
const at = (date: Date) => () => date;

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

  it('refuses a redirect on the RIDE download: the key never reaches the Location host', async () => {
    const elsewhere = await FakeFactusyncServer.start();
    try {
      fake.redirect('ride', 302, `${elsewhere.baseUrl}/documents/${DOCUMENT_ID}/ride`);
      const out = join(dir, 'ride.pdf');

      const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env);

      expect(result.code).toBe(3);
      expect(result.error().code).toBe('RIDE_REDIRECT_REFUSED');
      expect(elsewhere.requests).toEqual([]);
      expect(await exists(out)).toBe(false);
    } finally {
      await elsewhere.close();
    }
  });

  it.each([['text/html; charset=utf-8'], ['application/json']])('refuses a RIDE download that is not a PDF (%s) and writes nothing', async (contentType) => {
    fake.serveRide({ contentType, body: Buffer.from('<html>login</html>') });
    const out = join(dir, 'ride.pdf');

    const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env);

    expect(result.code).toBe(1);
    expect(result.error().code).toBe('RIDE_NOT_PDF');
    expect(await exists(out)).toBe(false);
  });

  it('accepts a PDF Content-Type with parameters', async () => {
    fake.serveRide({ contentType: 'application/pdf; charset=binary' });
    const out = join(dir, 'ride.pdf');

    const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env);

    expect(result.code).toBe(0);
    expect(await readFile(out)).toEqual(FAKE_PDF);
  });

  it.each([
    ['declares a Content-Length', false],
    ['streams without a Content-Length', true],
  ])('refuses a RIDE larger than the cap that %s and writes nothing', async (_label, chunked) => {
    fake.serveRide({ body: Buffer.alloc(8 * 1024, 0x25), chunked });
    const out = join(dir, 'ride.pdf');

    const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env, { maxRideBytes: 4 * 1024 });

    expect(result.code).toBe(1);
    expect(result.error().code).toBe('RIDE_TOO_LARGE');
    expect(await exists(out)).toBe(false);
  });

  it('accepts a RIDE exactly at the cap', async () => {
    const body = Buffer.alloc(4 * 1024, 0x25);
    fake.serveRide({ body, chunked: true });
    const out = join(dir, 'ride.pdf');

    const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env, { maxRideBytes: 4 * 1024 });

    expect(result.code).toBe(0);
    expect(await readFile(out)).toEqual(body);
  });

  describe('--out/--xml naming a directory', () => {
    it('--out <existing dir> writes ride-<accessKey>-<UTC timestamp>.pdf inside it', async () => {
      const result = await runCli(['ride', DOCUMENT_ID, '--out', dir], env, { now: at(NOW) });

      const expected = join(dir, `ride-${ACCESS_KEY}-20261007T153012Z.pdf`);
      expect(result.code).toBe(0);
      expect(await readFile(expected)).toEqual(FAKE_PDF);
      expect(result.json()).toMatchObject({ rideFile: expected });
    });

    it('a trailing / makes it a directory too, and --xml gets the same stem with .xml', async () => {
      const result = await runCli(['ride', DOCUMENT_ID, '--out', `${dir}/`, '--xml', `${dir}/`], env, { now: at(NOW) });

      expect(result.code).toBe(0);
      expect((await readdir(dir)).sort()).toEqual([
        `ride-${ACCESS_KEY}-20261007T153012Z.pdf`,
        `ride-${ACCESS_KEY}-20261007T153012Z.xml`,
      ]);
      expect(result.json()).toMatchObject({
        rideFile: join(dir, `ride-${ACCESS_KEY}-20261007T153012Z.pdf`),
        xmlFile: join(dir, `ride-${ACCESS_KEY}-20261007T153012Z.xml`),
      });
    });

    it('two downloads at different times keep both files', async () => {
      const first = await runCli(['ride', DOCUMENT_ID, '--out', dir], env, { now: at(NOW) });
      const second = await runCli(['ride', DOCUMENT_ID, '--out', dir], env, { now: at(new Date('2026-10-07T15:30:13Z')) });

      expect([first.code, second.code]).toEqual([0, 0]);
      expect(await readdir(dir)).toHaveLength(2);
    });

    it('never overwrites: a generated name that already exists fails and leaves the file alone', async () => {
      const taken = join(dir, `ride-${ACCESS_KEY}-20261007T153012Z.pdf`);
      await writeFile(taken, 'kept');

      const result = await runCli(['ride', DOCUMENT_ID, '--out', dir], env, { now: at(NOW) });

      expect(result.code).toBe(2);
      expect(result.error().code).toBe('OUTPUT_FILE_EXISTS');
      expect(await readFile(taken, 'utf8')).toBe('kept');
    });

    it('without an accessKey the name uses the documentId, made safe for a file name', async () => {
      fake.respond('factusync_get_ride', () =>
        structured({ documentId: '../../etc/x', rideUrl: `${fake.baseUrl}/documents/${DOCUMENT_ID}/ride` }),
      );

      const result = await runCli(['ride', DOCUMENT_ID, '--out', dir], env, { now: at(NOW) });

      expect(result.code).toBe(0);
      expect(await readdir(dir)).toEqual(['ride-.._.._etc_x-20261007T153012Z.pdf']);
    });

    it('--out <file> keeps writing exactly that path, replacing it', async () => {
      const out = join(dir, 'chosen.pdf');
      await writeFile(out, 'old');

      const result = await runCli(['ride', DOCUMENT_ID, '--out', out], env, { now: at(NOW) });

      expect(result.code).toBe(0);
      expect(await readFile(out)).toEqual(FAKE_PDF);
      expect(await readdir(dir)).toEqual(['chosen.pdf']);
    });
  });
});
