import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';

/**
 * An in-process stand-in for `POST /mcp` on the FactuSync API, built the way the real controller
 * is: stateless Streamable HTTP with JSON responses, a new `McpServer` per request holding only the
 * tools the key's scopes allow, and 401 without a known `X-API-Key`.
 *
 * The tools and their argument names come from `mcp-tool-contract.json` — the manifest the backend
 * spec pins to the real tools — so the fake cannot quietly accept a name the server would not.
 * Every tool argument is `unknown` here: validating values is the server's job, not the CLI's.
 */

interface ContractTool {
  scope: string;
  inputKeys: string[];
  requiredKeys: string[];
}

export const TOOL_CONTRACT: Record<string, ContractTool> = (
  JSON.parse(readFileSync(new URL('../mcp-tool-contract.json', import.meta.url), 'utf8')) as {
    tools: Record<string, ContractTool>;
  }
).tools;

export const ALL_SCOPES = [...new Set(Object.values(TOOL_CONTRACT).map((tool) => tool.scope))];

export const FULL_KEY = 'fs_test_full_key';
export const RIDE_ONLY_KEY = 'fs_test_ride_only_key';
export const FAKE_PDF = Buffer.from('%PDF-1.4\n% fake RIDE for tests\n%%EOF\n');

export interface RecordedRequest {
  method: string;
  url: string;
  apiKey: string | undefined;
}

export interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
}

export type FakeToolHandler = (
  args: Record<string, unknown>,
  context: { scopes: readonly string[]; baseUrl: string },
) => CallToolResult | Promise<CallToolResult>;

export function structured(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** Default answer: which tool ran and with what, so a test can read the mapping back from stdout. */
const echoHandler =
  (tool: string): FakeToolHandler =>
  (args) =>
    structured({ tool, args });

export class FakeFactusyncServer {
  readonly requests: RecordedRequest[] = [];
  readonly calls: RecordedCall[] = [];
  private handlers = new Map<string, FakeToolHandler>();
  private readonly keys = new Map<string, readonly string[]>([
    [FULL_KEY, ALL_SCOPES],
    [RIDE_ONLY_KEY, ['documents:ride']],
  ]);

  private constructor(
    private readonly http: Server,
    readonly baseUrl: string,
  ) {}

  static async start(): Promise<FakeFactusyncServer> {
    let instance: FakeFactusyncServer | undefined;
    const http = createServer((req, res) => {
      void instance!.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    instance = new FakeFactusyncServer(http, `http://127.0.0.1:${port}`);
    return instance;
  }

  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`;
  }

  /** Replace one tool's answer for the rest of the test. */
  respond(tool: string, handler: FakeToolHandler): void {
    this.handlers.set(tool, handler);
  }

  reset(): void {
    this.requests.length = 0;
    this.calls.length = 0;
    this.handlers = new Map();
  }

  async close(): Promise<void> {
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const apiKey = headerValue(req.headers['x-api-key']);
    this.requests.push({ method: req.method ?? '', url: req.url ?? '', apiKey });
    const scopes = apiKey !== undefined ? this.keys.get(apiKey) : undefined;

    const ride = /^\/documents\/([^/]+)\/ride$/.exec(req.url ?? '');
    if (req.method === 'GET' && ride) {
      if (!scopes?.includes('documents:ride')) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"code":"UNAUTHORIZED"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(FAKE_PDF);
      return;
    }

    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      // Stateless like the real controller: no SSE stream to open (GET), no session to end (DELETE).
      res
        .writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
        .end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}');
      return;
    }
    if (!scopes) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end('{"statusCode":401,"code":"UNAUTHORIZED","message":"An API key is required"}');
      return;
    }

    const server = this.serverFor(scopes);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  private serverFor(scopes: readonly string[]): McpServer {
    const server = new McpServer({ name: 'factusync', version: '1.0.0' });
    for (const [name, contract] of Object.entries(TOOL_CONTRACT)) {
      if (!scopes.includes(contract.scope)) continue;
      const inputSchema = Object.fromEntries(
        contract.inputKeys.map((key) => [key, contract.requiredKeys.includes(key) ? requiredValue() : z.unknown().optional()]),
      );
      server.registerTool(name, { title: name, description: `Fake ${name}`, inputSchema }, async (args) => {
        const recorded = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
        this.calls.push({ tool: name, args: recorded });
        const handler = this.handlers.get(name) ?? defaultHandler(name);
        return handler(recorded, { scopes, baseUrl: this.baseUrl });
      });
    }
    return server;
  }
}

function defaultHandler(tool: string): FakeToolHandler {
  if (tool !== 'factusync_get_ride') return echoHandler(tool);
  return (args, { scopes, baseUrl }) =>
    structured({
      documentId: args['id'],
      status: 'AUTHORIZED',
      number: '001-001-000000123',
      accessKey: '2409202601179001234500120010010000001231234567811',
      rideUrl: `${baseUrl}/documents/${String(args['id'])}/ride`,
      rideDownload: 'GET with the same API key; the response is application/pdf.',
      ...(scopes.includes('documents:read') ? { xml: '<factura id="comprobante"/>', xmlTruncated: false } : {}),
    });
}

/** `z.unknown()` alone accepts a missing key; a required argument must be present. */
function requiredValue() {
  return z.any().refine((value) => value !== undefined, 'Required');
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
