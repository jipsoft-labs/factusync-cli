import { CliFailure, EXIT_AUTH_OR_NETWORK, usageFailure } from './failure.js';

export const DEFAULT_MCP_URL = 'https://factusync-api.jipsoft.com/mcp';

export interface CliConfig {
  apiKey: string;
  mcpUrl: URL;
}

/**
 * Plain http would carry the API key in clear text: it is accepted only for a server on this
 * machine (a local FactuSync, tests). `URL` already normalizes the host, so `127.1` is `127.0.0.1`.
 */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Configuration comes from the environment only. The key in particular is never a flag: a flag
 * lands in shell history and in the process list, where other users on the machine can read it.
 */
export function readConfig(env: Readonly<Record<string, string | undefined>>): CliConfig {
  const rawUrl = env['FACTUSYNC_MCP_URL']?.trim() || DEFAULT_MCP_URL;
  let mcpUrl: URL;
  try {
    mcpUrl = new URL(rawUrl);
  } catch {
    throw usageFailure(`FACTUSYNC_MCP_URL is not a valid URL: ${rawUrl}`);
  }
  if (mcpUrl.protocol !== 'https:' && !(mcpUrl.protocol === 'http:' && isLoopback(mcpUrl.hostname))) {
    throw usageFailure(`FACTUSYNC_MCP_URL must be an https URL (http only for localhost): ${rawUrl}`);
  }

  const apiKey = env['FACTUSYNC_API_KEY']?.trim();
  if (!apiKey) {
    throw new CliFailure(
      EXIT_AUTH_OR_NETWORK,
      'MISSING_API_KEY',
      'FACTUSYNC_API_KEY is not set. Export your FactuSync API key in that variable; it is never accepted as a flag.',
    );
  }
  return { apiKey, mcpUrl };
}
