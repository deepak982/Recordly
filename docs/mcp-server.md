# Recordly AI agent control (MCP)

Recordly can expose its recorder to local AI tools over the Model Context Protocol, so an agent such as Claude Code or Codex can select a window, record a demo, and export the finished video with automatic zooms applied. The connection is off by default, listens only on the loopback interface, and requires a token that is generated on your own computer. Nothing is sent anywhere: the agent and Recordly both run on your machine.

## Turning it on

1. Open **Settings → Advanced → AI agent control (MCP)**.
2. Turn on **Let AI agents control Recordly**. Recordly generates a private token and starts listening; the panel then shows **Running at `http://127.0.0.1:43831/mcp`**.
3. Press **Copy setup command** and paste it into a terminal. That one command registers Recordly with Claude Code, token included. For other tools, use the configuration below.

**Regenerate token** issues a new token and invalidates the old one. Every tool you have already configured stops working until you re-add it with the new token.

The address depends on the build, so that a packaged app and a development build can run side by side:

| Build | Address |
| --- | --- |
| Installed app (.dmg, .exe, AppImage) | `http://127.0.0.1:43831/mcp` |
| Development build (`npm run dev`) | `http://127.0.0.1:43832/mcp` |

Settings always shows the address the running app is actually using — prefer it over the table.

## What an agent can do

Nine tools. They return plain JSON and refuse with an explanatory message instead of opening a dialog, so an agent never leaves a prompt waiting for a human to click something.

| Tool | What it does | Arguments |
| --- | --- | --- |
| `get_status` | Recorder state (`idle`, `starting`, `countdown`, `recording`, `paused`, `stopping`, `finalizing`), the selected source, the path of the last recording, macOS permission status, and the state and progress of the last export. Read-only. | — |
| `list_sources` | Lists capturable screens and windows with their `id`, `name`, `type` and `appName`. Read-only. | — |
| `select_source` | Chooses what to record, by exact `id` or by a case-insensitive substring of the source or app name. Refuses if nothing matches or several things do, listing the candidates. Raises the window without stealing focus. | `id`, `name` (one of) |
| `start_recording` | Starts capture and returns once it is genuinely running, after the countdown. Refuses if no source is selected, screen-recording permission is missing, or a recording is already running or still saving. | `countdownSeconds` (0–10, defaults to your setting) |
| `pause_recording` | Pauses the running recording. | — |
| `resume_recording` | Resumes a paused recording. | — |
| `stop_recording` | Stops and saves, returning the saved video path once it is written. The editor then opens with automatic zooms already applied. | — |
| `cancel_recording` | Discards the running recording, or aborts the countdown before capture starts. | — |
| `export_video` | Exports the last recording with no save dialog, using the editor's current look — automatic zooms, cursor smoothing, background and frame — and returns the saved path. A long export returns `{ "status": "still-exporting" }`; poll `get_status` until `export.state` is `done` or `failed`. Reports progress to clients that ask for it. | `outputPath`, `format` (`mp4`, `gif`), `quality` (`medium`, `good`, `high`, `source`), `overwrite` |

A typical run is `list_sources` → `select_source` → `start_recording` → perform the demo → `stop_recording` → `export_video`. Recordly ships these instructions to the agent itself, so in practice you can just ask for the recording you want.

## Adding Recordly to your AI tool

Every example needs two values from the settings panel: the **address** and the **token**. Replace `YOUR_TOKEN` throughout.

### Claude Code

The **Copy setup command** button produces exactly this:

```bash
claude mcp add --transport http recordly http://127.0.0.1:43831/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

To write it by hand instead, add this to `~/.claude.json` for every project, or to a project's `.mcp.json` to share it with a repository:

```json
{
  "mcpServers": {
    "recordly": {
      "type": "http",
      "url": "http://127.0.0.1:43831/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

### Codex CLI

Codex reads the token from an environment variable rather than from its configuration file:

```bash
export RECORDLY_MCP_TOKEN=YOUR_TOKEN
codex mcp add recordly --url http://127.0.0.1:43831/mcp \
  --bearer-token-env-var RECORDLY_MCP_TOKEN
```

That writes the following to `~/.codex/config.toml`, which you can also add by hand:

```toml
[mcp_servers.recordly]
url = "http://127.0.0.1:43831/mcp"
bearer_token_env_var = "RECORDLY_MCP_TOKEN"
```

Export `RECORDLY_MCP_TOKEN` from your shell profile, or Codex will start the server without credentials and every call will fail with `401`.

### Other clients that speak streamable HTTP

Most MCP clients accept a URL and a set of headers. The shape of the file differs but the two values do not:

```json
{
  "mcpServers": {
    "recordly": {
      "url": "http://127.0.0.1:43831/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

Some clients name the field `httpUrl` or require `"type": "http"` alongside the URL; check your client's documentation for which of the two it expects.

### Clients that only speak stdio

A client that can only launch a command can reach Recordly through the `mcp-remote` bridge. Pass `--transport http-only`, because Recordly serves streamable HTTP and has no SSE endpoint:

```json
{
  "mcpServers": {
    "recordly": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:43831/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization: Bearer YOUR_TOKEN"
      ]
    }
  }
}
```

## How the connection is secured

Anything able to reach the port can start a recording of your screen, so the server is deliberately narrow:

- It binds `127.0.0.1` only, so nothing outside this computer can reach it, and it stays closed until you turn the setting on.
- Every request must carry `Authorization: Bearer <token>`, compared in constant time. Anything else gets `401`.
- The `Host` header must be `127.0.0.1` or `localhost` at the expected port, which blocks DNS rebinding.
- Requests carrying an `Origin` header are refused with `403`. This is why a web page cannot drive Recordly even though the port is local — only a local process can.
- Only the `/mcp` path answers; everything else is `404`. Bodies over 1 MB are rejected with `413`.
- The token lives in `mcp-server.json` in Recordly's user-data folder, written with `0600` permissions, and never in the shared application settings.

Treat the token like a password. If you paste it somewhere public, press **Regenerate token**.

## Troubleshooting

**"Port 43831 is already in use."** Another program holds the port. Close it, then turn the setting off and on again.

**Every call returns `401`.** The token is wrong or missing. With Codex, check that `RECORDLY_MCP_TOKEN` is actually exported in the shell that starts it. If you pressed **Regenerate token**, re-add Recordly everywhere with the new one.

**Every call returns `403`.** The client is sending an `Origin` header, or reaching the app through a hostname other than `127.0.0.1` or `localhost`. Browser-based clients cannot connect by design.

**Tools refuse with a permission error.** macOS screen recording and accessibility permissions are granted to applications, not to agents. Open System Settings and grant them to Recordly, then try again.

**The agent cannot see Recordly at all.** Confirm the panel says *Running at …*, and that the port in your configuration matches it — an installed app and a development build use different ports.
