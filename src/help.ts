import { COMMANDS, TOOL_SCOPES, type CommandSpec } from './commands.js';
import { DEFAULT_MCP_URL } from './config.js';

const COMMON = [
  'Environment:',
  '  FACTUSYNC_API_KEY   Required. Your FactuSync API key. Never accepted as a flag.',
  `  FACTUSYNC_MCP_URL   Optional. Default ${DEFAULT_MCP_URL}`,
  '',
  'Output: the tool result as JSON on stdout (--pretty indents it).',
  'Errors: JSON {code, message, details?} on stderr.',
  'Exit codes: 0 ok, 1 tool error, 2 usage error, 3 authentication or network error.',
];

function scopeOf(command: CommandSpec): string {
  return command.tool ? TOOL_SCOPES[command.tool] : '-';
}

export function rootHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.words.join(' ').length));
  const rows = COMMANDS.map(
    (command) => `  ${command.words.join(' ').padEnd(width)}  ${scopeOf(command).padEnd(15)}  ${command.summary}`,
  );
  return [
    'Usage: factusync <command> [arguments] [--pretty]',
    '',
    'FactuSync (Ecuador SRI e-invoicing) for AI agents and scripts, through the FactuSync MCP endpoint.',
    '',
    `Commands (required API-key scope):`,
    ...rows,
    '',
    'Create is not emit: invoice create makes a DRAFT; show it to the user, then document emit <id> --yes.',
    '',
    ...COMMON,
    '',
    "Run 'factusync <command> --help' for a command's arguments. 'factusync --version' prints the version.",
    '',
  ].join('\n');
}

export function commandHelp(command: CommandSpec): string {
  const flags = Object.entries(command.flags).map(([name, flag]) => {
    const value = flag.type === 'string' ? ` <${flag.integer ? 'n' : 'value'}>` : '';
    const target = flag.argument ? ` (tool argument ${flag.argument})` : '';
    return `  --${name}${value}: ${flag.description}${target}`;
  });
  return [
    `Usage: ${command.usage} [--pretty]`,
    '',
    command.summary,
    '',
    command.tool ? `MCP tool: ${command.tool}. Required API-key scope: ${TOOL_SCOPES[command.tool]}.` : 'Uses tools/list: shows only what this key can call.',
    ...(command.positionals.length > 0
      ? ['', 'Arguments:', ...command.positionals.map((positional) => `  <${positional.name}>: tool argument ${positional.argument}`)]
      : []),
    '',
    'Options:',
    ...flags,
    '  --pretty: indent the JSON output',
    '  --help, -h: this help',
    ...(command.notes && command.notes.length > 0 ? ['', ...command.notes] : []),
    '',
    ...COMMON,
    '',
  ].join('\n');
}
