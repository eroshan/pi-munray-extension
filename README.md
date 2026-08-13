# pi-munray-extension

Bridges an MCP stdio server into Pi as LLM-callable tools.

## What it provides

- Tools advertised by the MCP server via `tools/list` (as advertised by the server)
- Mutating tools get an approval prompt via MCP elicitation
- Session ID reuse (auto-injects `session_id` unless you override)
- Adds `initialize.instructions` from the MCP server to the model context (appended to the system prompt)

## Install location

This extension can be installed at any location under `~/.pi/agent/extensions/`. The extension name is automatically calculated from the directory name.

For example:
- `~/.pi/agent/extensions/pi-munray-extension/index.ts` (extension name: `pi-munray-extension`)

Runtime configuration is stored at `~/.pi/agent/pi-munray-extension.conf`, outside the extension directory. On first use, the extension creates it from the repository's `pi-munray-extension.conf.template` without replacing an existing file.

## Config

On first use, edit the generated config to set the MCP executable path. The template is JSON with `//` comments; its service-specific environment block remains commented as an example. Uncomment and customize it only if needed.

```jsonc
{
  "command": ["/path/to/your/mcp-server", "mcp"]

  // Add a comma above, then uncomment and customize this optional block:
  // ,
  // "environment": {
  //   "SERVICE_BASE_URL": "https://service.example.com",
  //   "SERVICE_API_TOKEN": "{file:~/.config/service-api-token}"
  // }
}
```

The `{file:...}` syntax is supported; the file content is read and injected into the MCP process environment.

You can override the config path with:

```bash
pi -e ~/.pi/agent/extensions/pi-munray-extension/index.ts --munray-config /path/to/custom-config.conf
```

(If you run Pi normally, it auto-discovers the extension; you don't need `-e`.)

## Commands

- `/munray-session` – show current `session_id`
- `/munray-restart` – restart the MCP process (drops in-memory state)

## Events

This extension emits an inter-extension event on Pi's event bus when a mutating approval prompt is shown/resolved:

- Event name: `munray:elicitation`
- Payload (best-effort):
  - `phase`: `"create"` | `"resolve"`
  - `requestId`: JSON-RPC request id (number|string|null)
  - `message`: (create only) the elicitation text without the code preview
  - `hasCodePreview`: (create only) boolean
  - `decision`: (resolve only) `"approve"` | `"reject"` | `"cancel"`

Example listener (e.g. in a notify extension):

```ts
export default function (pi) {
  pi.events.on("munray:elicitation", (ev) => {
    if (ev?.phase === "create") {
      // trigger terminal/native notification here
    }
  });
}
```

## Notes

- This extension spawns the configured MCP command as a child process and keeps it running for the lifetime of the Pi session.
- Tool names are read from the MCP server with `tools/list`; they are not hardcoded in the extension.
- Mutating tool calls may trigger an approval dialog via MCP `elicitation/create` (custom overlay with code preview).
- Tool calls render code previews in the Pi TUI.
