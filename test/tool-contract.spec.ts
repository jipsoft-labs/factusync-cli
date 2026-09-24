import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS, TOOL_SCOPES, commandForTool } from '../src/commands.js';
import { TOOL_CONTRACT } from './fake-factusync-server.js';

/**
 * The CLI side of the contract with the FactuSync MCP server. `mcp-tool-contract.json` is the
 * pivot: the backend's `mcp-cli-contract.spec.ts` fails when the real tools stop matching it, and
 * this spec fails when the CLI stops matching it. A rename on either side turns one of them red.
 */

const contractTools = Object.keys(TOOL_CONTRACT).sort();
const toolCommands = COMMANDS.filter((command) => command.tool !== null);

function argumentKeys(command: (typeof COMMANDS)[number]): string[] {
  return [
    ...command.positionals.map((positional) => positional.argument),
    ...Object.values(command.flags).flatMap((flag) => (flag.argument ? [flag.argument] : [])),
  ];
}

/** The example invoice in README.md: the first ```json block of the `invoice create` section. */
function readmeInvoiceExample(): Record<string, unknown> {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('### `factusync invoice create'));
  const block = /```json\n([\s\S]*?)\n```/.exec(section);
  if (!block) throw new Error('README.md has no JSON example in the invoice create section');
  return JSON.parse(block[1]!) as Record<string, unknown>;
}

describe('CLI ↔ MCP tool contract (mcp-tool-contract.json)', () => {
  it('the CLI knows exactly the tools in the contract, each with the same scope', () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual(contractTools);
    for (const [tool, scope] of Object.entries(TOOL_SCOPES)) {
      expect({ tool, scope }).toEqual({ tool, scope: TOOL_CONTRACT[tool]!.scope });
    }
  });

  it('every contract tool has exactly one command, and every command calls a contract tool', () => {
    for (const tool of contractTools) {
      expect(COMMANDS.filter((command) => command.tool === tool).map((command) => command.words.join(' ')), tool).toHaveLength(1);
      expect(commandForTool(tool)).toBeDefined();
    }
    expect(toolCommands.map((command) => command.tool).sort()).toEqual(contractTools);
  });

  it.each(toolCommands.filter((command) => !command.inputFromFile).map((command) => [command.words.join(' '), command] as const))(
    '%s sends only argument names the tool accepts, and always its required ones',
    (_name, command) => {
      const contract = TOOL_CONTRACT[command.tool!]!;
      const sent = argumentKeys(command);

      expect(sent.filter((key) => !contract.inputKeys.includes(key))).toEqual([]);
      const alwaysSent = command.positionals.map((positional) => positional.argument);
      expect(contract.requiredKeys.filter((key) => !alwaysSent.includes(key))).toEqual([]);
    },
  );

  it('invoice create passes the file through, and the README example is a valid input shape', () => {
    const create = COMMANDS.find((command) => command.tool === 'factusync_create_invoice')!;
    expect(create.inputFromFile).toBe(true);
    expect(argumentKeys(create)).toEqual([]);

    const contract = TOOL_CONTRACT['factusync_create_invoice']!;
    const example = readmeInvoiceExample();
    expect(Object.keys(example).filter((key) => !contract.inputKeys.includes(key))).toEqual([]);
    expect(contract.requiredKeys.filter((key) => !(key in example))).toEqual([]);
  });

  it('the scope table in README.md matches the contract', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const [tool, { scope }] of Object.entries(TOOL_CONTRACT)) {
      const row = readme.split('\n').find((line) => line.startsWith('| `factusync') && line.includes(`| \`${tool}\` |`));
      expect(row, `README row for ${tool}`).toBeDefined();
      expect(row).toContain(`\`${scope}\``);
    }
  });
});
