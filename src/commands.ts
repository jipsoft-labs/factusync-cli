/**
 * The MCP tools the CLI calls and the API-key scope each one needs on the server. Mirrors
 * `MCP_TOOL_REQUIRED_SCOPES` in the backend; `mcp-tool-contract.json` pins the two together
 * (see `test/tool-contract.spec.ts` and the backend's `mcp-cli-contract.spec.ts`).
 */
export const TOOL_SCOPES = {
  factusync_context: 'documents:read',
  factusync_lookup_id: 'validation:read',
  factusync_list_documents: 'documents:read',
  factusync_get_document: 'documents:read',
  factusync_create_invoice: 'documents:write',
  factusync_emit_document: 'documents:emit',
  factusync_get_ride: 'documents:ride',
} as const;

export type McpToolName = keyof typeof TOOL_SCOPES;

export interface FlagSpec {
  type: 'string' | 'boolean';
  /** The tool argument this flag fills; absent for flags the CLI consumes itself. */
  argument?: string;
  /** Sent as a number; the value must be a non-negative integer. */
  integer?: boolean;
  description: string;
}

export interface PositionalSpec {
  name: string;
  /** The tool argument this positional fills. */
  argument: string;
}

export interface CommandSpec {
  words: readonly string[];
  /** The tool it calls; `null` for `tools`, which lists them instead. */
  tool: McpToolName | null;
  usage: string;
  summary: string;
  positionals: readonly PositionalSpec[];
  flags: Readonly<Record<string, FlagSpec>>;
  /** The whole tool input is the JSON object read from `--file` (a path, or `-` for stdin). */
  inputFromFile?: boolean;
  /** Refuses to run without `--yes`: the tool issues something that cannot be taken back. */
  requiresConfirmation?: boolean;
  notes?: readonly string[];
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    words: ['context'],
    tool: 'factusync_context',
    usage: 'factusync context',
    summary: 'Company, SRI environment of the key, plan quota and signing certificate. Start here.',
    positionals: [],
    flags: {},
  },
  {
    words: ['id', 'lookup'],
    tool: 'factusync_lookup_id',
    usage: 'factusync id lookup <identification>',
    summary: 'Validates a cédula (10 digits) or RUC (13 digits) and returns the legal name the SRI expects.',
    positionals: [{ name: 'identification', argument: 'identification' }],
    flags: {},
  },
  {
    words: ['documents', 'list'],
    tool: 'factusync_list_documents',
    usage:
      'factusync documents list [--type <code>] [--status <status>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--recipient <id>] [--limit <n>] [--offset <n>]',
    summary: 'Lists documents, newest first, as compact summaries. Page with --limit (max 50) and nextOffset.',
    positionals: [],
    flags: {
      type: { type: 'string', argument: 'documentTypeCode', description: '01 invoice, 03 purchase settlement, 04 credit note, 05 debit note, 06 waybill, 07 withholding' },
      status: { type: 'string', argument: 'status', description: 'Document status, e.g. DRAFT, AUTHORIZED, REJECTED' },
      from: { type: 'string', argument: 'issuedFrom', description: 'SRI issue date from, inclusive (YYYY-MM-DD). Excludes drafts' },
      to: { type: 'string', argument: 'issuedTo', description: 'SRI issue date to, inclusive (YYYY-MM-DD). Excludes drafts' },
      recipient: { type: 'string', argument: 'recipientIdentification', description: 'Buyer cédula or RUC, digits only' },
      limit: { type: 'string', argument: 'limit', integer: true, description: 'Page size, 1 to 50 (server default 20)' },
      offset: { type: 'string', argument: 'offset', integer: true, description: 'Rows to skip: pass the nextOffset of the previous page' },
    },
  },
  {
    words: ['documents', 'get'],
    tool: 'factusync_get_document',
    usage: 'factusync documents get <id>',
    summary: 'One document: status, number, access key, SRI rejection reason, cancellation request.',
    positionals: [{ name: 'id', argument: 'id' }],
    flags: {},
    notes: ['Emission is asynchronous: call this again to follow SENT_TO_SRI → AUTHORIZED or REJECTED.'],
  },
  {
    words: ['invoice', 'create'],
    tool: 'factusync_create_invoice',
    usage: 'factusync invoice create --file <path|->',
    summary: 'Creates a DRAFT invoice from a JSON file (or stdin with -) and returns its preview with computed taxes and totals.',
    positionals: [],
    flags: {
      file: { type: 'string', description: 'JSON file with the invoice input, or - to read it from stdin' },
    },
    inputFromFile: true,
    notes: [
      'Nothing is sent to the SRI. Show the preview to the user, then run factusync document emit <id> --yes.',
      'Idempotent on externalReference: the same value returns the same document (alreadyExisted: true).',
    ],
  },
  {
    words: ['document', 'emit'],
    tool: 'factusync_emit_document',
    usage: 'factusync document emit <id> --yes',
    summary: "Sends a DRAFT document to the SRI in the key's environment. Production keys issue legally binding documents.",
    positionals: [{ name: 'id', argument: 'id' }],
    flags: {
      yes: { type: 'boolean', description: 'Required. Confirms the user approved this draft' },
    },
    requiresConfirmation: true,
    notes: ['Asynchronous: follow the result with factusync documents get <id>.'],
  },
  {
    words: ['ride'],
    tool: 'factusync_get_ride',
    usage: 'factusync ride <id> [--out <file.pdf>] [--xml <file.xml>]',
    summary: 'For an AUTHORIZED document: the RIDE (PDF) URL, and the authorized XML when the key may read documents.',
    positionals: [{ name: 'id', argument: 'id' }],
    flags: {
      out: { type: 'string', description: 'Download the RIDE PDF to this file (sent with the same API key)' },
      xml: { type: 'string', description: 'Write the authorized XML to this file (needs documents:read too)' },
    },
  },
  {
    words: ['tools'],
    tool: null,
    usage: 'factusync tools',
    summary: 'Lists the MCP tools this API key can call, with the CLI command for each.',
    positionals: [],
    flags: {},
  },
];

/** The longest command whose words start `argv`, so `documents list` wins over a shorter match. */
export function findCommand(argv: readonly string[]): CommandSpec | undefined {
  return [...COMMANDS]
    .sort((a, b) => b.words.length - a.words.length)
    .find((command) => command.words.every((word, index) => argv[index] === word));
}

export function commandForTool(tool: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.tool === tool);
}
