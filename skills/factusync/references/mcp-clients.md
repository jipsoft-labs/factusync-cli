# Connect a client to the FactuSync MCP server

Endpoint: `https://factusync-api.jipsoft.com/mcp` (Streamable HTTP). Authentication: the FactuSync API
key as `Authorization: Bearer <key>` (or `X-API-Key: <key>`). The user creates the key in FactuSync
with the scopes they need, and exports it as `FACTUSYNC_API_KEY` from a secret store. Every example
below reads the key from the environment or a password prompt: never put the key itself in a file.

## Claude Code

```bash
# The shell replaces $FACTUSYNC_API_KEY when the command runs.
claude mcp add --transport http factusync https://factusync-api.jipsoft.com/mcp --header "Authorization: Bearer $FACTUSYNC_API_KEY"
```

Or in `.mcp.json` (Claude Code expands `${VAR}` in headers):

```json
{
  "mcpServers": {
    "factusync": {
      "type": "http",
      "url": "https://factusync-api.jipsoft.com/mcp",
      "headers": {
        "Authorization": "Bearer ${FACTUSYNC_API_KEY}"
      }
    }
  }
}
```

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.factusync]
url = "https://factusync-api.jipsoft.com/mcp"
bearer_token_env_var = "FACTUSYNC_API_KEY"
```

## Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "factusync": {
      "url": "https://factusync-api.jipsoft.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:FACTUSYNC_API_KEY}"
      }
    }
  }
}
```

## VS Code

`.vscode/mcp.json`. The root key is `servers`; a file keyed `mcpServers` is ignored. VS Code asks for
the key once and stores it as a secret:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "factusync-api-key",
      "description": "FactuSync API key",
      "password": true
    }
  ],
  "servers": {
    "factusync": {
      "type": "http",
      "url": "https://factusync-api.jipsoft.com/mcp",
      "headers": {
        "Authorization": "Bearer ${input:factusync-api-key}"
      }
    }
  }
}
```

## Pi

Pi has had built-in MCP since 0.99. `pi mcp add` writes the entry to `~/.pi/agent/mcp.json` (or use
`.pi/mcp.json` in a project, which Pi reads only after the project is trusted). Pi expands `${VAR}`
in headers, so the file holds no key. `--exposure direct` declares the tools to the model like Pi's
own; the default, `codemode`, only reaches them from codemode scripts.

```bash
pi mcp add factusync --url https://factusync-api.jipsoft.com/mcp --bearer-token-env-var FACTUSYNC_API_KEY --exposure direct
```

Which writes:

```json
{
  "mcpServers": {
    "factusync": {
      "url": "https://factusync-api.jipsoft.com/mcp",
      "headers": {
        "Authorization": "Bearer ${FACTUSYNC_API_KEY}"
      },
      "exposure": "direct"
    }
  }
}
```

Check it with `pi mcp list`, which connects and prints the tools the key's scopes allow. Inside a
session, `/mcp` shows the status and `/reload` applies config changes.

Pi does not ask for approval before each tool call, and it only uses the `destructiveHint` on
`factusync_emit_document` in permission extensions. So show the user the draft preview and wait for
their approval before emitting, or have them install a permission extension.

## Agents without MCP

Scripts, Pi before 0.99 and any agent without MCP support use the CLI, which calls the same server:

```bash
npm install -g @jipsoft/factusync-cli   # or: npx -y @jipsoft/factusync-cli <command>
export FACTUSYNC_API_KEY=…              # from a secret store, never typed into a conversation
factusync context
```

After changing a client's config, restart the client (or reload its MCP servers) and check that the
`factusync_*` tools appear.
