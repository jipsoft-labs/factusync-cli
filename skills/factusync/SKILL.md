---
name: factusync
description: Issue and read Ecuadorian SRI electronic documents (facturas, RIDE, XML) in FactuSync through its MCP tools or the factusync CLI. Use when the user asks to create, emit, find, check the status of, or download an invoice, look up a cédula or RUC, or check FactuSync quota, certificate or SRI environment.
---

# FactuSync (Ecuador SRI e-invoicing)

FactuSync issues SRI electronic documents. It exposes seven MCP tools at
`https://factusync-api.jipsoft.com/mcp`, and the `factusync` CLI (`@jipsoft/factusync-cli`) calls the
same tools from a shell, with the same input, scopes, error texts and idempotency.

Install or update this skill with `npx skills add jipsoft-labs/factusync-cli`.

## Pick the channel

1. **MCP tools available** (tools named `factusync_*` are in your tool list): call them directly.
2. **Otherwise, a shell is available**: use the CLI. Check it runs with `npx -y @jipsoft/factusync-cli --version`
   (Node.js 22+). Prefer `factusync` if it is installed globally; else prefix every command with
   `npx -y @jipsoft/factusync-cli`.
3. **Neither works**: tell the user how to connect their client, from
   [references/mcp-clients.md](references/mcp-clients.md), and stop.

If a call fails with `MISSING_API_KEY` or `UNAUTHORIZED`, the user must configure the key; you cannot.

## The API key

- The key lives in `FACTUSYNC_API_KEY`, set by the user from a secret store.
  The CLI never accepts the key as a flag. Never ask the user to paste the key into the conversation, never print it, never write
  it to a file, and never echo `$FACTUSYNC_API_KEY`.
- Each key has fixed scopes and a fixed SRI environment (`testing` or `production`). A tool the key
  lacks the scope for is not listed (`TOOL_NOT_AVAILABLE`). `factusync tools` lists what it can call.
- `FACTUSYNC_MCP_URL` (optional) points the CLI at another endpoint; `https:` only, `http:` only for
  localhost.

## Tools and commands

| MCP tool | CLI command | Scope | Use |
|---|---|---|---|
| `factusync_context` | `factusync context` | `documents:read` | Company, key environment, quota, certificate. Call it first. |
| `factusync_lookup_id` | `factusync id lookup <identification>` | `validation:read` | Cédula (10 digits) or RUC (13) → legal name, tax status, email. |
| `factusync_list_documents` | `factusync documents list [--type --status --from --to --recipient --limit --offset]` | `documents:read` | Newest first, up to 50 per page, `nextOffset` to continue. |
| `factusync_get_document` | `factusync documents get <id>` | `documents:read` | Status, number, access key, SRI failure. |
| `factusync_create_invoice` | `factusync invoice create --file <path\|->` | `documents:write` | Makes a DRAFT and returns the computed preview. |
| `factusync_emit_document` | `factusync document emit <id> --yes` | `documents:emit` | Sends a DRAFT to the SRI. |
| `factusync_get_ride` | `factusync ride <id> [--out file.pdf] [--xml file.xml]` | `documents:ride` | RIDE (PDF) and XML of an AUTHORIZED document. |

The CLI prints JSON on stdout (`--pretty` indents it) and errors as `{code, message, details?}` on
stderr. Exit codes: `0` ok, `1` tool error, `2` usage error (nothing was sent), `3` authentication or
network. `factusync <command> --help` shows every flag.

## Workflow: issue an invoice

1. **Context.** `factusync_context`. Tell the user the `keyEnvironment`. If it is `production`, say
   plainly that emitting issues a legally binding tax document. Stop if `certificate.status` is not
   `VALID` or the quota has nothing left.
2. **Buyer.** For a cédula or RUC, `factusync_lookup_id` and use its `legalName` as the buyer name.
   Ask for anything missing; never invent an identification number, price or IVA rate.
3. **Create the draft.** `factusync_create_invoice` with a stable `externalReference` (the order id).
   Nothing reaches the SRI.
4. **Show the preview and wait for approval.** Show buyer, each line with `taxRate`, `taxableBase`,
   `taxAmount`, and `totals`. Do not continue without an explicit yes from the user for this draft.
5. **Emit.** `factusync_emit_document` (CLI: `--yes`, required). Never emit a document the user did
   not approve, and never emit several in a loop without approval of the whole batch.
6. **Follow it.** Emission is asynchronous: poll `factusync_get_document` every few seconds until
   `status` is `AUTHORIZED` or `REJECTED`. On `REJECTED`, show `failure` (the SRI reason) and fix the
   input in a new draft; a rejected document is not emitted again.
7. **RIDE.** Once `AUTHORIZED`, `factusync_get_ride` (CLI: `factusync ride <id> --out invoice.pdf`).

**Retries are safe on create, not on emit.** Creating again with the same `externalReference` returns
the stored document with `alreadyExisted: true` (as stored, even if the new input differs), never a
second invoice. Emit only works on a `DRAFT`; after a timeout, check the status with `documents get`
before emitting again.

## Invoice input

The `factusync_create_invoice` input, also the JSON file the CLI reads (`--file invoice.json`, or
`--file -` for stdin):

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

- `buyer.idType`: `04` RUC (13 digits), `05` cédula (10), `06` passport, `07` consumidor final (then
  `idNumber` `9999999999999` and `name` `CONSUMIDOR FINAL`). `email` gets the authorized invoice.
- `lines` (1 to 200, `mainCode` unique): `unitPrice` is **before discount and before IVA**; `discount`
  is an amount for the whole line, not a percentage.
- `ivaRateCode` is the SRI **code**, not the percentage: `4` = 15%, `0` = 0%, `7` = exempt. Ask the
  user when you do not know the rate of a product.
- `payment.methodCode`: `01` without the financial system (cash), `20` other with the financial system
  (card, transfer). For credit add `term` and `timeUnit` (for example `"dias"`).
- `establishment` / `emissionPoint` (3 digits each) default to the company's.
- FactuSync computes every tax and total: never send them, and never compute them yourself for the
  user as if they were final. The preview is the source of truth.

## Finding documents

- `documents list --type 01 --status AUTHORIZED --from 2026-10-01 --to 2026-10-31`. Types: `01` invoice,
  `03` purchase settlement, `04` credit note, `05` debit note, `06` waybill, `07` withholding.
- Date filters use the SRI issue date and never return drafts; list drafts with `--status DRAFT`.
- `--recipient <cédula or RUC>` filters by buyer. Page with `--offset <nextOffset>` while `hasMore`.

## Errors

| Code | What to do |
|---|---|
| `MISSING_API_KEY`, `UNAUTHORIZED`, `FORBIDDEN` | The user must set or replace `FACTUSYNC_API_KEY`. |
| `TOOL_NOT_AVAILABLE` | The key lacks the scope named in the message; the user creates a key with it. |
| `CONFIRMATION_REQUIRED` | You ran `document emit` without `--yes`. Get the user's approval first. |
| `UNKNOWN_TAX_RATE` | `ivaRateCode` is not in the SRI catalog; ask the user. |
| `DISCOUNT_EXCEEDS_LINE` | A line's `discount` is larger than quantity × unit price. |
| `VALIDATION_FAILED`, `INVALID_INPUT` | Read `details`, fix the input, create again. |
| `INVALID_STATE_TRANSITION` | Wrong status for the action (emit a non-DRAFT, RIDE of a non-AUTHORIZED). Check `documents get`. |
| `EXTERNAL_REFERENCE_IN_USE` | The reference belongs to another document type; use a different one. |
| `NETWORK_ERROR`, `TIMEOUT` | Retry reads and creates; check the status before re-emitting. |

Full CLI reference: <https://github.com/jipsoft-labs/factusync-cli#readme>. MCP setup per client:
[references/mcp-clients.md](references/mcp-clients.md).
