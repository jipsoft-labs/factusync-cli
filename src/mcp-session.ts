import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCOPES, type McpToolName } from './commands.js';
import { CliFailure, EXIT_AUTH_OR_NETWORK, EXIT_TOOL_ERROR } from './failure.js';
import { CLI_VERSION } from './version.js';

export interface ConnectionConfig {
  mcpUrl: URL;
  apiKey: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

/** One connected MCP client: what a command needs, nothing about the SDK leaks out. */
export interface McpSession {
  callTool(tool: McpToolName, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listTools(): Promise<Tool[]>;
}

/**
 * Opens a stateless Streamable HTTP connection to FactuSync's `POST /mcp` with the key as
 * `X-API-Key`, runs `action`, and closes it. Every SDK or transport failure leaves here already
 * turned into a `CliFailure` with its exit code.
 */
export async function withMcpSession<T>(config: ConnectionConfig, action: (session: McpSession) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(config.mcpUrl, {
    requestInit: { headers: { 'X-API-Key': config.apiKey } },
    fetch: config.fetch,
  });
  const client = new Client({ name: 'factusync-cli', version: CLI_VERSION });
  const options = config.timeoutMs !== undefined ? { timeout: config.timeoutMs } : undefined;

  try {
    await client.connect(transport, options);
    return await action({
      callTool: async (tool, args) => {
        let result: CallToolResult;
        try {
          result = (await client.callTool({ name: tool, arguments: args }, undefined, options)) as CallToolResult;
        } catch (error) {
          throw toolCallFailure(tool, error);
        }
        if (result.isError) throw toolResultFailure(tool, result);
        return result.structuredContent ?? parseTextContent(result);
      },
      listTools: async () => {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor !== undefined ? { cursor } : undefined, options);
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return tools;
      },
    });
  } catch (error) {
    throw transportFailure(error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A successful result without `structuredContent`: its first text block, as JSON when it is JSON. */
function parseTextContent(result: CallToolResult): Record<string, unknown> {
  const text = textBlocks(result)[0] ?? '';
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // not JSON: returned as text below
  }
  return { text };
}

function textBlocks(result: CallToolResult): string[] {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

const CODED_MESSAGE = /^([A-Z][A-Z0-9_]*): ([\s\S]*)$/;
const SDK_ERROR_MESSAGE = /^MCP error (-?\d+): ([\s\S]*)$/;

/**
 * A tool error as the server wrote it: `CODE: message` (FactuSync's API error text) plus an
 * optional `{"details": …}` block, or plain text. The SDK's own errors (`MCP error -32602: …`)
 * arrive the same way: an unknown tool means this key's scopes do not include it.
 */
export function toolResultFailure(tool: McpToolName, result: CallToolResult): CliFailure {
  const [first = '', ...rest] = textBlocks(result);
  const details = rest.map(detailsOf).find((value) => value !== undefined);

  const sdkError = SDK_ERROR_MESSAGE.exec(first);
  if (sdkError) return sdkFailure(tool, Number(sdkError[1]), sdkError[2] ?? '');

  const coded = CODED_MESSAGE.exec(first);
  if (coded) return new CliFailure(EXIT_TOOL_ERROR, coded[1]!, coded[2]!, details);
  return new CliFailure(EXIT_TOOL_ERROR, 'TOOL_ERROR', first || 'The tool failed without a message.', details);
}

function detailsOf(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && 'details' in parsed) return (parsed as { details: unknown }).details;
  } catch {
    // not a details block
  }
  return undefined;
}

function sdkFailure(tool: McpToolName, code: number, message: string): CliFailure {
  if (code === ErrorCode.MethodNotFound || /^Tool \S+ (not found|disabled)$/.test(message)) {
    return new CliFailure(
      EXIT_TOOL_ERROR,
      'TOOL_NOT_AVAILABLE',
      `This API key cannot use ${tool}: it needs the '${TOOL_SCOPES[tool]}' scope. Run 'factusync tools' to see what it can call.`,
    );
  }
  if (message.startsWith('Input validation error')) return new CliFailure(EXIT_TOOL_ERROR, 'INVALID_INPUT', message);
  return new CliFailure(EXIT_TOOL_ERROR, 'TOOL_ERROR', message);
}

/** `callTool` threw instead of returning an error result: a JSON-RPC error, or the transport. */
function toolCallFailure(tool: McpToolName, error: unknown): unknown {
  if (error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed) {
    return sdkFailure(tool, error.code, error.message.replace(/^MCP error -?\d+: /, ''));
  }
  return error;
}

/** Anything that is not already a `CliFailure`: authentication, HTTP, connection or timeout. */
export function transportFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) {
      return new CliFailure(EXIT_AUTH_OR_NETWORK, 'UNAUTHORIZED', 'FactuSync rejected the API key (HTTP 401). Check FACTUSYNC_API_KEY.');
    }
    if (error.code === 403) {
      return new CliFailure(EXIT_AUTH_OR_NETWORK, 'FORBIDDEN', 'FactuSync refused this API key (HTTP 403).');
    }
    return new CliFailure(EXIT_AUTH_OR_NETWORK, 'HTTP_ERROR', `The MCP endpoint answered HTTP ${error.code}.`, { status: error.code });
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new CliFailure(EXIT_AUTH_OR_NETWORK, 'TIMEOUT', 'FactuSync did not answer in time.');
  }
  if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed) {
    return new CliFailure(EXIT_TOOL_ERROR, 'MCP_ERROR', error.message.replace(/^MCP error -?\d+: /, ''), { mcpCode: error.code });
  }
  return networkFailure(error);
}

/** `fetch` rejections: refused, unresolvable, reset or aborted connections. */
export function networkFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new CliFailure(EXIT_AUTH_OR_NETWORK, 'TIMEOUT', 'FactuSync did not answer in time.');
  }
  if (error instanceof TypeError || (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)) {
    const cause = (error as Error & { cause?: { code?: unknown } }).cause;
    const reason = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
    return new CliFailure(EXIT_AUTH_OR_NETWORK, 'NETWORK_ERROR', `Could not reach FactuSync${reason}. Check FACTUSYNC_MCP_URL and the network.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliFailure(EXIT_TOOL_ERROR, 'UNEXPECTED_ERROR', message);
}
