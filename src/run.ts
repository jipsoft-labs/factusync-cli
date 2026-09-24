import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { commandForTool, findCommand, type CommandSpec, type McpToolName } from './commands.js';
import { readConfig, type CliConfig } from './config.js';
import { CliFailure, EXIT_AUTH_OR_NETWORK, EXIT_OK, EXIT_TOOL_ERROR, EXIT_USAGE, usageFailure } from './failure.js';
import { commandHelp, rootHelp } from './help.js';
import { networkFailure, withMcpSession, type McpSession } from './mcp-session.js';
import { CLI_VERSION } from './version.js';

/** Everything the CLI touches outside itself, injectable so tests run it in-process. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  fetch: typeof fetch;
  /** Per-request timeout for MCP calls. Tests shorten it; the CLI uses the SDK default. */
  timeoutMs?: number;
}

export type CliEnv = Readonly<Record<string, string | undefined>>;

/** Same default as the SDK's MCP requests, for the RIDE download. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Runs one CLI invocation and returns its exit code. Never throws. */
export async function run(argv: readonly string[], env: CliEnv, io: CliIo): Promise<number> {
  try {
    return await execute(argv, env, io);
  } catch (error) {
    const failure = error instanceof CliFailure ? error : networkFailure(error);
    io.stderr(`${JSON.stringify(failure.body)}\n`);
    return failure.exitCode;
  }
}

interface ParsedCommand {
  command: CommandSpec;
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
  pretty: boolean;
}

async function execute(argv: readonly string[], env: CliEnv, io: CliIo): Promise<number> {
  if (argv.length === 0) {
    throw usageFailure("Missing command. Usage: factusync <command> [arguments]. Run 'factusync --help'.");
  }
  if (argv[0]!.startsWith('-')) return rootFlags(argv, io);

  const parsed = parseCommand(argv);
  if (parsed.values['help']) {
    io.stdout(commandHelp(parsed.command));
    return EXIT_OK;
  }

  const { command } = parsed;
  if (command.requiresConfirmation && parsed.values['yes'] !== true) {
    throw new CliFailure(
      EXIT_USAGE,
      'CONFIRMATION_REQUIRED',
      `${command.words.join(' ')} issues a real tax document with the SRI. Show the draft to the user first, then run it again with --yes.`,
    );
  }
  const args = await toolArguments(parsed, io);
  const config = readConfig(env);
  const connection = { ...config, fetch: io.fetch, ...(io.timeoutMs !== undefined ? { timeoutMs: io.timeoutMs } : {}) };

  const output = await withMcpSession(connection, async (session) => {
    if (command.tool === null) return listTools(session);
    const result = await session.callTool(command.tool, args);
    return command.tool === 'factusync_get_ride' ? saveRide(result, parsed, config, io) : result;
  });

  io.stdout(`${JSON.stringify(output, null, parsed.pretty ? 2 : undefined)}\n`);
  return EXIT_OK;
}

function rootFlags(argv: readonly string[], io: CliIo): number {
  let values: { help?: boolean; version?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw usageFailure(`${parseErrorMessage(error)} Run 'factusync --help'.`);
  }
  if (values.version) {
    io.stdout(`${CLI_VERSION}\n`);
    return EXIT_OK;
  }
  if (values.help) {
    io.stdout(rootHelp());
    return EXIT_OK;
  }
  throw usageFailure("Missing command. Run 'factusync --help'.");
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = findCommand(argv);
  if (!command) {
    const words = argv.filter((token) => !token.startsWith('-')).slice(0, 2).join(' ');
    throw usageFailure(`Unknown command '${words}'. Run 'factusync --help'.`);
  }

  const options: NonNullable<ParseArgsConfig['options']> = {
    pretty: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  };
  for (const [name, flag] of Object.entries(command.flags)) options[name] = { type: flag.type };

  let result: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    result = parseArgs({ args: argv.slice(command.words.length), options, strict: true, allowPositionals: true }) as typeof result;
  } catch (error) {
    throw usageFailure(`${parseErrorMessage(error)} Run 'factusync ${command.words.join(' ')} --help'.`);
  }

  const parsed = { command, positionals: result.positionals, values: result.values, pretty: result.values['pretty'] === true };
  if (!parsed.values['help'] && parsed.positionals.length !== command.positionals.length) {
    throw usageFailure(`Usage: ${command.usage}`);
  }
  return parsed;
}

/**
 * Node's message names the option and nothing after it, except for an inline `--flag=value`, where
 * it would echo the value: cut at `=`, so a key typed as `--api-key=…` never reaches stderr.
 */
function parseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = /Unknown option '([^'=]+)/.exec(message);
  if (unknown) return `Unknown option '${unknown[1]}'.`;
  return message.split('\n')[0]!.replace(/=[^']*/g, '');
}

async function toolArguments(parsed: ParsedCommand, io: CliIo): Promise<Record<string, unknown>> {
  const { command } = parsed;
  if (command.inputFromFile) return readInputFile(parsed.values['file'], command, io);

  const args: Record<string, unknown> = {};
  command.positionals.forEach((positional, index) => {
    args[positional.argument] = parsed.positionals[index];
  });
  for (const [name, flag] of Object.entries(command.flags)) {
    const value = parsed.values[name];
    if (!flag.argument || value === undefined) continue;
    if (flag.integer) {
      if (typeof value !== 'string' || !/^\d+$/.test(value)) throw usageFailure(`--${name} must be a whole number, got '${String(value)}'.`);
      args[flag.argument] = Number(value);
    } else {
      args[flag.argument] = value;
    }
  }
  return args;
}

async function readInputFile(file: string | boolean | undefined, command: CommandSpec, io: CliIo): Promise<Record<string, unknown>> {
  if (typeof file !== 'string' || file === '') throw usageFailure(`Usage: ${command.usage}`);

  let text: string;
  try {
    text = file === '-' ? await io.readStdin() : await readFile(file, 'utf8');
  } catch (error) {
    const reason = (error as { code?: string }).code ?? 'unreadable';
    throw new CliFailure(EXIT_USAGE, 'INVALID_INPUT_FILE', `Cannot read ${file} (${reason}).`);
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new CliFailure(EXIT_USAGE, 'INVALID_INPUT_FILE', `${file === '-' ? 'stdin' : file} is not valid JSON: ${(error as Error).message}`);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CliFailure(EXIT_USAGE, 'INVALID_INPUT_FILE', `${file === '-' ? 'stdin' : file} must hold one JSON object: the tool input.`);
  }
  return input as Record<string, unknown>;
}

async function listTools(session: McpSession): Promise<Record<string, unknown>> {
  const tools = await session.listTools();
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? tool.annotations?.title ?? null,
      description: tool.description ?? null,
      command: commandForTool(tool.name)?.usage ?? null,
    })),
  };
}

/**
 * `ride --out/--xml`: every check runs before anything is written, so a failure leaves no file.
 * The PDF is fetched with the key only from the MCP endpoint's own origin: the key never goes
 * to a host the user did not configure, whatever URL a response carries.
 */
async function saveRide(
  result: Record<string, unknown>,
  parsed: ParsedCommand,
  config: CliConfig,
  io: CliIo,
): Promise<Record<string, unknown>> {
  const out = parsed.values['out'];
  const xmlPath = parsed.values['xml'];
  const tool: McpToolName = 'factusync_get_ride';

  if (typeof xmlPath === 'string') {
    if (typeof result['xml'] !== 'string') {
      throw new CliFailure(
        EXIT_TOOL_ERROR,
        'XML_NOT_AVAILABLE',
        `${tool} returned no XML: this API key needs the documents:read scope as well as documents:ride.`,
      );
    }
    if (result['xmlTruncated'] === true) {
      throw new CliFailure(EXIT_TOOL_ERROR, 'XML_TRUNCATED', 'The server truncated this XML; it was not written. Download it from the FactuSync API instead.');
    }
  }

  let pdf: Uint8Array | undefined;
  if (typeof out === 'string') pdf = await downloadRide(result['rideUrl'], config, io);

  const saved: Record<string, unknown> = { ...result };
  try {
    if (pdf && typeof out === 'string') {
      await writeFile(out, pdf);
      saved['rideFile'] = out;
    }
    if (typeof xmlPath === 'string') {
      await writeFile(xmlPath, result['xml'] as string, 'utf8');
      delete saved['xml'];
      saved['xmlFile'] = xmlPath;
    }
  } catch (error) {
    throw new CliFailure(EXIT_USAGE, 'OUTPUT_FILE_NOT_WRITABLE', `Cannot write the output file: ${(error as Error).message}`);
  }
  return saved;
}

async function downloadRide(rideUrl: unknown, config: CliConfig, io: CliIo): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(String(rideUrl));
  } catch {
    throw new CliFailure(EXIT_TOOL_ERROR, 'RIDE_URL_MISSING', 'The tool result has no valid rideUrl.');
  }
  if (url.origin !== config.mcpUrl.origin) {
    throw new CliFailure(
      EXIT_TOOL_ERROR,
      'RIDE_URL_UNTRUSTED',
      `The RIDE URL is on ${url.origin}, not on ${config.mcpUrl.origin} (FACTUSYNC_MCP_URL); the API key is not sent there.`,
    );
  }

  let response: Response;
  try {
    response = await io.fetch(url, {
      headers: { 'X-API-Key': config.apiKey },
      signal: AbortSignal.timeout(io.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkFailure(error);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliFailure(
      EXIT_AUTH_OR_NETWORK,
      response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      `FactuSync refused the RIDE download (HTTP ${response.status}).`,
    );
  }
  if (!response.ok) {
    throw new CliFailure(EXIT_TOOL_ERROR, 'RIDE_DOWNLOAD_FAILED', `The RIDE download answered HTTP ${response.status}.`, {
      status: response.status,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}
