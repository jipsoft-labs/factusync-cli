import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands.js';
import { TOOL_CONTRACT } from './fake-factusync-server.js';

/**
 * The agent skill in `skills/factusync/` is installed from the public mirror with
 * `npx skills add jipsoft-labs/factusync-cli`. It teaches agents the same tools and commands the
 * contract pins, so a tool or command rename that forgets the skill turns this spec red.
 */

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const skill = read('skills/factusync/SKILL.md');
const mcpClients = read('skills/factusync/references/mcp-clients.md');
const INSTALL_COMMAND = 'npx skills add jipsoft-labs/factusync-cli';

function frontmatter(source: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!block) throw new Error('SKILL.md has no YAML frontmatter');
  return Object.fromEntries(
    block[1]!
      .split('\n')
      .map((line) => /^([a-z-]+):\s*(.*)$/.exec(line))
      .flatMap((match) => (match ? [[match[1]!, match[2]!.replace(/^["']|["']$/g, '')]] : [])),
  );
}

/** The first ```json block after the given heading. */
function jsonAfter(source: string, heading: string): Record<string, unknown> {
  const start = source.indexOf(heading);
  if (start < 0) throw new Error(`SKILL.md has no "${heading}" heading`);
  const block = /```json\n([\s\S]*?)\n```/.exec(source.slice(start));
  if (!block) throw new Error(`SKILL.md has no JSON example after "${heading}"`);
  return JSON.parse(block[1]!) as Record<string, unknown>;
}

describe('agent skill (skills/factusync)', () => {
  it('has the frontmatter the skills installer requires, named after its directory', () => {
    const meta = frontmatter(skill);
    expect(meta.name).toBe('factusync');
    expect(meta.description?.length ?? 0).toBeGreaterThan(50);
    expect(meta.description!.length).toBeLessThanOrEqual(1024);
  });

  it('names every MCP tool in the contract with its scope', () => {
    for (const [tool, { scope }] of Object.entries(TOOL_CONTRACT)) {
      const row = skill.split('\n').find((line) => line.includes(`\`${tool}\``) && line.startsWith('|'));
      expect(row, `SKILL.md row for ${tool}`).toBeDefined();
      expect(row).toContain(`\`${scope}\``);
    }
  });

  it('names every CLI command', () => {
    for (const command of COMMANDS) {
      expect(skill, command.words.join(' ')).toContain(`factusync ${command.words.join(' ')}`);
    }
  });

  it('keeps the create-is-not-emit rule and the key out of flags', () => {
    expect(skill).toContain('--yes');
    expect(skill).toContain('FACTUSYNC_API_KEY');
    expect(skill).toMatch(/never.*flag/i);
  });

  it('its invoice example is a valid factusync_create_invoice input shape', () => {
    const contract = TOOL_CONTRACT['factusync_create_invoice']!;
    const example = jsonAfter(skill, '## Invoice input');
    expect(Object.keys(example).filter((key) => !contract.inputKeys.includes(key))).toEqual([]);
    expect(contract.requiredKeys.filter((key) => !(key in example))).toEqual([]);
  });

  it('documents the MCP config of each client, reading the key from the environment', () => {
    expect(mcpClients).toContain('claude mcp add --transport http factusync');
    expect(mcpClients).toContain('[mcp_servers.factusync]');
    expect(mcpClients).toContain('bearer_token_env_var = "FACTUSYNC_API_KEY"');
    expect(mcpClients).toContain('"Authorization": "Bearer ${env:FACTUSYNC_API_KEY}"');
    // VS Code reads `servers`; a file keyed `mcpServers` is ignored without a word.
    expect(mcpClients).toContain('"servers"');
    // Pi has built-in MCP since 0.99; its entry carries `exposure: direct` so the tools reach the model.
    expect(mcpClients).toContain(
      'pi mcp add factusync --url https://factusync-api.jipsoft.com/mcp --bearer-token-env-var FACTUSYNC_API_KEY',
    );
    expect(mcpClients).toContain('"exposure": "direct"');
    expect(mcpClients).toContain('pi mcp list');
    for (const match of mcpClients.matchAll(/Bearer ([^"\s]+)/g)) {
      expect(match[1], 'a literal key in an example').toMatch(/^(\$|<key>)/);
    }
  });

  it('the README tells people how to install it', () => {
    expect(read('README.md')).toContain(INSTALL_COMMAND);
    expect(skill).toContain(INSTALL_COMMAND);
  });
});
