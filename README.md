# lua-mcp (Pi extension)

Bridges the `lua` MCP stdio server into Pi as LLM-callable tools.

## What it provides

- Tools advertised by the MCP server via `tools/list` (for example `lua_runLuaScript` and `lua_runMutatingLuaScript`)
- Mutating tools get an approval prompt via MCP elicitation
- Session ID reuse (auto-injects `session_id` unless you override)
- Adds `initialize.instructions` from the MCP server to the model context (appended to the system prompt)

## Install location

This extension can be installed at any location under `~/.pi/agent/extensions/`. The extension name is automatically calculated from the directory name.

For example:
- `~/.pi/agent/extensions/lua-connector/index.ts` (extension name: `lua-connector`)
- `~/.pi/agent/extensions/lua-mcp/index.ts` (extension name: `lua-mcp`)

The config file is always named `config.json` and should be placed in the same directory as `index.ts`.

## Config

Create a config file named `config.json` in the extension directory.

For example, if installed at `~/.pi/agent/extensions/lua-connector/`, create `~/.pi/agent/extensions/lua-connector/config.json`:

```json
{
  "command": [
    "/Users/misha/Documents/lua-mcp/target/release/lua-mcp",
    "mcp",
    "--logs-dir",
    "/Users/misha/Documents/lua-mcp/logs"
  ],
  "environment": {
    "JIRA_BASE_URL": "https://five9inc.atlassian.net",
    "JIRA_EMAIL": "mikhail.egorov@five9.com",
    "JIRA_API_TOKEN": "{file:~/Code/perm/mejt}",
    "CONFLUENCE_BASE_URL": "https://five9inc.atlassian.net"
  }
}
```

The `{file:...}` syntax is supported; the file content is read and injected into the MCP process environment.

You can override the config path with:

```bash
pi -e ~/.pi/agent/extensions/lua-connector/index.ts --lua-config /path/to/custom-config.json
```

(If you run Pi normally, it auto-discovers the extension; you don't need `-e`.)

## Commands

- `/lua-session` – show current `session_id`
- `/lua-restart` – restart the MCP process (drops in-memory state)

## Events

This extension emits an inter-extension event on Pi's event bus when a mutating approval prompt is shown/resolved:

- Event name: `lua:elicitation`
- Payload (best-effort):
  - `phase`: `"create"` | `"resolve"`
  - `requestId`: JSON-RPC request id (number|string|null)
  - `message`: (create only) the elicitation text without the code preview
  - `hasCodePreview`: (create only) boolean
  - `decision`: (resolve only) `"approve"` | `"reject"` | `"cancel"`

Example listener (e.g. in a notify extension):

```ts
export default function (pi) {
  pi.events.on("lua:elicitation", (ev) => {
    if (ev?.phase === "create") {
      // trigger terminal/native notification here
    }
  });
}
```

## Notes

- This extension spawns the configured Lua MCP command as a child process and keeps it running for the lifetime of the Pi session.
- Tool names are read from the MCP server with `tools/list`; they are not hardcoded in the extension.
- Mutating tool calls may trigger an approval dialog via MCP `elicitation/create` (custom overlay with Lua syntax highlighting).
- Tool calls render Lua code with syntax highlighting in the Pi TUI.
