# factusync — FactuSync CLI for agents and scripts

`factusync` issues and reads Ecuadorian SRI electronic documents in FactuSync from a shell. It is a
thin client of the FactuSync MCP endpoint: every command calls one MCP tool, with the same input,
the same API-key scopes, the same error texts and the same idempotency as the MCP tools.

It is written to be used by an AI agent (for example Pi, which has no MCP support) and by shell
scripts. Every command prints JSON.

## Run it

```bash
# From npm (https://www.npmjs.com/package/@jipsoft/factusync-cli):
npx @jipsoft/factusync-cli context
npm install -g @jipsoft/factusync-cli && factusync context

# From the FactuSync repository:
pnpm --filter @jipsoft/factusync-cli build
node packages/factusync-cli/dist/cli.js context
```

Requires Node.js 22 or newer.

## Configuration (environment only)

| Variable | Required | Meaning |
|---|---|---|
| `FACTUSYNC_API_KEY` | yes | A FactuSync API key. Sent as the `X-API-Key` header. |
| `FACTUSYNC_MCP_URL` | no | The MCP endpoint. Default `https://factusync-api.jipsoft.com/mcp`. |

The key is **never** accepted as a flag (`--api-key`, `--key` are rejected as unknown options), so it
does not end up in shell history or in the process list. Never print the key or paste it into a
conversation.

A key's **SRI environment** (testing or production) is fixed when the key is created: every document
created through it goes to that environment. `factusync context` tells you which one it is.

## The rule: create is not emit

1. `factusync invoice create --file invoice.json` makes a **DRAFT** and returns a preview with the taxes
   and totals FactuSync computed. Nothing is sent to the SRI.
2. Show that preview to the user and get their approval.
3. `factusync document emit <documentId> --yes` sends the draft to the SRI. With a production key this
   issues a **legally binding** tax document. `--yes` is required; without it the command does nothing
   and exits 2.
4. Emission is asynchronous: poll `factusync documents get <documentId>` until `status` is `AUTHORIZED`
   or `REJECTED` (the SRI reason is in `failure`).
5. `factusync ride <documentId> --out invoice.pdf` downloads the RIDE (PDF) once it is `AUTHORIZED`.

**Idempotency:** `externalReference` (for example your order id) identifies the invoice. Creating
again with the same `externalReference` returns the existing document with `alreadyExisted: true` —
as it is stored, even if the new input differs — instead of a second invoice. Retrying a create after
a timeout is therefore safe. Emit is not idempotent in that sense: only a `DRAFT` can be emitted.

## Commands

Each command needs one scope on the API key. A key without it cannot see or call that tool
(`TOOL_NOT_AVAILABLE`). `factusync tools` lists what the current key can call.

| Command | MCP tool | Scope |
|---|---|---|
| `factusync context` | `factusync_context` | `documents:read` |
| `factusync id lookup <identification>` | `factusync_lookup_id` | `validation:read` |
| `factusync documents list [--type --status --from --to --recipient --limit --offset]` | `factusync_list_documents` | `documents:read` |
| `factusync documents get <id>` | `factusync_get_document` | `documents:read` |
| `factusync invoice create --file <path\|->` | `factusync_create_invoice` | `documents:write` |
| `factusync document emit <id> --yes` | `factusync_emit_document` | `documents:emit` |
| `factusync ride <id> [--out file.pdf] [--xml file.xml]` | `factusync_get_ride` | `documents:ride` (+ `documents:read` for the XML) |
| `factusync tools` | `tools/list` | none |

Every command accepts `--pretty` (indented JSON) and `--help` / `-h`. `factusync --help` and
`factusync --version` work without a key.

### `factusync context`

Start here. Prints `{ company: { ruc, legalName, tradeName, defaultEstablishment, defaultEmissionPoint },
keyEnvironment, companyEnvironment, quota: { period, used, limit, status, remainingIncludingGrace,
graceEndsAt }, certificate: { status, notAfter } }`. `keyEnvironment` (`testing` / `production`) is
where documents created with this key go. `certificate.status` is `VALID`, `EXPIRED`, `MISSING` or
`UNKNOWN_EXPIRY`: nothing can be emitted without a valid signing certificate.

### `factusync id lookup <identification>`

`identification` is a cédula (10 digits) or RUC (13 digits). Prints `{ id, source, active, legalName,
tradeName, taxStatus, taxpayerType, registeredAddress, email }`. Use `legalName` as the buyer name.

### `factusync documents list`

| Flag | Tool argument | Value |
|---|---|---|
| `--type` | `documentTypeCode` | `01` invoice, `03` purchase settlement, `04` credit note, `05` debit note, `06` waybill, `07` withholding |
| `--status` | `status` | e.g. `DRAFT`, `SENT_TO_SRI`, `AUTHORIZED`, `REJECTED` |
| `--from` / `--to` | `issuedFrom` / `issuedTo` | `YYYY-MM-DD`, inclusive, the SRI issue date. Drafts have none: a date filter never returns drafts |
| `--recipient` | `recipientIdentification` | Buyer cédula or RUC, digits only |
| `--limit` | `limit` | 1 to 50, default 20 |
| `--offset` | `offset` | Rows to skip: the `nextOffset` of the previous page |

Prints `{ items: [{ id, documentTypeCode, status, number, accessKey, environment,
recipientIdentification, recipientName, total, issueDate, createdAt }], hasMore, nextOffset }`,
newest first.

### `factusync documents get <id>`

Prints one document without its line items: `id`, `documentTypeCode`, `status`, `number`
(`001-001-000000123`), `establishment`, `emissionPoint`, `sequenceNumber`, `accessKey`, `authorizedAt`,
`failure` (the SRI rejection, when there is one), `cancellation`, `createdAt`, `updatedAt` and the
last state the SRI reported (`sriObservedState`, `sriDiverges`).

### `factusync invoice create --file <path|->`

The file (or stdin, with `--file -`) is exactly the `factusync_create_invoice` input, one JSON object:

```json
{
  "externalReference": "order-1001",
  "buyer": {
    "idType": "05",
    "idNumber": "1710034065",
    "name": "MARIA PEREZ",
    "email": "maria@example.com",
    "address": "Av. Amazonas N34-56, Quito"
  },
  "lines": [
    {
      "mainCode": "SKU-1",
      "description": "Widget",
      "quantity": 2,
      "unitPrice": 10,
      "discount": 1,
      "ivaRateCode": "4"
    }
  ],
  "payment": { "methodCode": "20" },
  "additionalInfo": { "Pedido": "order-1001" }
}
```

- `externalReference` (required): your idempotency key, up to 200 characters.
- `establishment`, `emissionPoint` (optional): 3 digits each; default to the company defaults.
- `buyer` (required): `idType` `04` RUC (13 digits), `05` cédula (10 digits), `06` passport, `07`
  consumidor final (then `idNumber` must be `9999999999999` and `name` `CONSUMIDOR FINAL`); `name`;
  optional `email` (the authorized invoice is emailed there) and `address`.
- `lines` (required, 1 to 200, `mainCode` unique): `quantity` > 0, `unitPrice` ≥ 0 **before discount
  and before IVA**, optional `discount` as an amount for the whole line, and `ivaRateCode` — the SRI
  IVA rate **code**, not the percentage (`4` = 15%, `0` = 0%, `7` = exempt), checked against the live
  catalog.
- `payment` (optional): one SRI payment `methodCode` for the whole amount (for example `01` without
  the financial system, `20` other with the financial system), plus `term` and `timeUnit` (for example
  `"dias"`) together for credit.
- `additionalInfo` (optional): key/value pairs printed on the RIDE; the key is what the buyer reads.

FactuSync computes every tax and total. Prints `{ documentId, status: "DRAFT", alreadyExisted,
externalReference, environment, establishment, emissionPoint, number, buyer, lines: [{ …, taxRate,
taxableBase, taxAmount }], totals, payments }`.

### `factusync document emit <id> --yes`

Only after the user approved the draft. Prints `{ documentId, jobId, status, next }`; then follow the
document with `documents get`. Only `DRAFT` documents can be emitted.

### `factusync ride <id> [--out file.pdf] [--xml file.xml]`

Only for `AUTHORIZED` documents. Prints `{ documentId, status, number, accessKey, rideUrl, rideDownload,
xml?, xmlTruncated? }`.

- `--out file.pdf` downloads the PDF from `rideUrl` with the same key and adds `rideFile` to the output.
  The key is only sent when `rideUrl` is on the same origin as `FACTUSYNC_MCP_URL`
  (otherwise `RIDE_URL_UNTRUSTED`).
- `--xml file.xml` writes the authorized XML, adds `xmlFile` and leaves `xml` out of the output. The
  XML is only returned when the key also has `documents:read` (otherwise `XML_NOT_AVAILABLE`); an XML
  the server truncated is not written (`XML_TRUNCATED`).
- If any check fails, no file is written.

### `factusync tools`

Prints `{ tools: [{ name, title, description, command }] }`: the tools this key can call and the CLI
command for each.

## Output and errors

- Success: the tool's structured result as compact JSON on stdout, one line (`--pretty` indents it).
- Failure: nothing on stdout; one JSON object on stderr: `{ "code": "…", "message": "…", "details": … }`
  (`details` only when the server sent them). `code` is FactuSync's API error code when the server
  gave one (for example `INVALID_STATE_TRANSITION`, `NOT_FOUND`, `VALIDATION_FAILED`,
  `UNKNOWN_TAX_RATE`, `EXTERNAL_REFERENCE_IN_USE`), otherwise one of the codes below.

| Exit | Meaning | Codes |
|---|---|---|
| 0 | OK | |
| 1 | The tool answered with an error | the API code, `TOOL_ERROR`, `TOOL_NOT_AVAILABLE`, `INVALID_INPUT`, `MCP_ERROR`, `XML_NOT_AVAILABLE`, `XML_TRUNCATED`, `RIDE_URL_UNTRUSTED`, `RIDE_DOWNLOAD_FAILED` |
| 2 | Usage error: nothing was sent | `USAGE`, `CONFIRMATION_REQUIRED`, `INVALID_INPUT_FILE`, `OUTPUT_FILE_NOT_WRITABLE` |
| 3 | Authentication or network | `MISSING_API_KEY`, `UNAUTHORIZED`, `FORBIDDEN`, `HTTP_ERROR`, `NETWORK_ERROR`, `TIMEOUT` |

A missing `FACTUSYNC_API_KEY` fails with exit 3 before any network request.

## Example session

```bash
export FACTUSYNC_API_KEY=…   # from a secret store, never typed into a conversation
factusync context --pretty
factusync id lookup 1710034065
factusync invoice create --file invoice.json      # → documentId, preview
# … the user approves the preview …
factusync document emit "$DOCUMENT_ID" --yes
factusync documents get "$DOCUMENT_ID"            # until AUTHORIZED or REJECTED
factusync ride "$DOCUMENT_ID" --out invoice.pdf --xml invoice.xml
```

## Source and issues

This package is developed inside JipSoft's private monorepo, next to the FactuSync server it talks
to, so a shared contract test (`mcp-tool-contract.json`) keeps the commands and the server's tools
from drifting apart. [github.com/jipsoft-labs/factusync-cli](https://github.com/jipsoft-labs/factusync-cli)
is a public mirror, synced on every release. Issues are welcome there; pull requests are read and
ported into the monorepo by hand, so they are not merged in the mirror itself.

To build and test a checkout of the mirror: `npm install && npm test` with npm 11 or later. npm 10
fails to resolve vitest 4's peer dependencies (`Cannot read properties of null (reading 'edgesOut')`);
on npm 10 use `npm install --legacy-peer-deps`. Installing the published package is not affected.

## License

MIT. See [LICENSE](LICENSE).
