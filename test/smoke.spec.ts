import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The built binary, as npm links it: `pnpm test` builds first, so this is the real `dist/`. */
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('built binary (dist/cli.js)', () => {
  it('is executable and prints the usage with exit 0, without a key', () => {
    accessSync(CLI, constants.X_OK);
    const env = { ...process.env };
    delete env['FACTUSYNC_API_KEY'];

    const result = spawnSync(CLI, ['--help'], { encoding: 'utf8', env, timeout: 20_000 });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: factusync <command>/);
  });
});
