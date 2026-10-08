import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { CliFailure } from '../src/failure.js';

const KEY = 'fs_test_key';

function configError(url: string): CliFailure {
  try {
    readConfig({ FACTUSYNC_API_KEY: KEY, FACTUSYNC_MCP_URL: url });
  } catch (error) {
    if (error instanceof CliFailure) return error;
    throw error;
  }
  throw new Error(`readConfig accepted ${url}`);
}

describe('FACTUSYNC_MCP_URL', () => {
  it('accepts https on any host', () => {
    expect(readConfig({ FACTUSYNC_API_KEY: KEY, FACTUSYNC_MCP_URL: 'https://factusync.example.com/mcp' }).mcpUrl.href).toBe(
      'https://factusync.example.com/mcp',
    );
  });

  it.each(['http://localhost:3001/mcp', 'http://127.0.0.1:3001/mcp', 'http://127.0.0.42/mcp', 'http://[::1]:3001/mcp'])(
    'accepts http on a loopback host: %s',
    (url) => {
      expect(readConfig({ FACTUSYNC_API_KEY: KEY, FACTUSYNC_MCP_URL: url }).mcpUrl.href).toBe(url);
    },
  );

  it.each(['http://factusync.example.com/mcp', 'http://192.168.1.10:3001/mcp', 'http://localhost.example.com/mcp'])(
    'rejects http on a remote host, where the key would travel in clear text: %s',
    (url) => {
      const failure = configError(url);
      expect(failure.exitCode).toBe(2);
      expect(failure.code).toBe('USAGE');
      expect(failure.message).toMatch(/https/);
    },
  );

  it.each(['ftp://factusync.example.com/mcp', 'ws://localhost:3001/mcp', 'file:///etc/passwd'])('rejects another protocol: %s', (url) => {
    const failure = configError(url);
    expect(failure.code).toBe('USAGE');
    expect(failure.message).toMatch(/https/);
  });

  it('defaults to the production https endpoint', () => {
    expect(readConfig({ FACTUSYNC_API_KEY: KEY }).mcpUrl.protocol).toBe('https:');
  });
});
