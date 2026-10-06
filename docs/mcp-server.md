# Recordly AI agent control (MCP)

Recordly can expose its recorder to local AI tools over the Model Context Protocol, so an agent such as Claude Code or Codex can select a window, record a demo, and export the finished video with automatic zooms applied. If you allow it, the agent can also drive the window it records — open a web page, look at it, click, drag, type, press shortcuts and scroll — so a whole demo of any website or app needs nothing but Recordly. The connection is off by default, listens only on the loopback interface, and requires a token that is generated on your own computer. Nothing is sent anywhere: the agent and Recordly both run on your machine.

## Platform support

Recording works everywhere; driving the window is macOS-only for now.

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Record, pause, stop, export | Yes | Yes | Yes. Unattended on X11; on Wayland a person confirms the share dialog |
| Driving the window (`open_url`, `screenshot`, `find_elements`, input tools, `perform`) and its switch | Yes — see [macOS](#macos-available-now) | Not yet — planned, see [Windows](#windows-not-available-yet-planned) | Not yet — planned, X11 first, see [Linux](#linux-not-available-yet-planned) |
| The `record_demo` prompt | Plans a demo the agent drives itself | Plans a demo the user performs while Recordly records | Plans a demo the user performs while Recordly records |
| `list_sources` fields | `id`, `name`, `type`, `appName`, `pid`, `windowTitle`, `onScreen`, bounds; windows on every desktop | `id`, `name`, `type` | `id`, `name`, `type`; on Wayland only the **Screen** entry |
| How a window is captured | The display cropped to the window, so keep the window uncovered | The window itself, through Windows Graphics Capture | The screen entry `screen:linux-portal`, listed first (**Entire screen** on X11; **Screen (chosen in the system share dialog)** on Wayland) |

**Linux.** On X11 the **Entire screen** entry records with no prompt. On Wayland, `list_sources` returns only the **Screen (chosen in the system share dialog)** entry, marked `needsUser`, and `start_recording` opens the system share dialog, which a person must confirm — the agent is told to ask you, and the start waits up to 120 seconds for you to do it.

**WSL2.** Recordly listens on `127.0.0.1` on the Windows side. With WSL2's default NAT networking an agent running inside WSL cannot reach that address; set `networkingMode=mirrored` in `.wslconfig`, or run the agent natively on Windows.

## Turning it on

1. Open **Settings → Advanced → AI agent control (MCP)**.
2. Turn on **Let AI agents control Recordly**. Recordly generates a private token and starts listening; the panel then shows **Running at `http://127.0.0.1:43831/mcp`**.
3. Press **Copy setup command** and paste it into a terminal. That one command registers Recordly with Claude Code, token included. For other tools, use the configuration below.
4. On macOS, optionally turn on **Let agents use the mouse and keyboard**, which appears once the connection is on. Windows and Linux don't show it yet. It is off by default. Until you turn it on, an agent can record but not open pages or touch the window: `open_url` and every input tool refuse.

**Regenerate token** issues a new token and invalidates the old one. Every tool you have already configured stops working until you re-add it with the new token.

The address depends on the build, so that a packaged app and a development build can run side by side:

| Build | Address |
| --- | --- |
| Installed app (.dmg, .exe, AppImage) | `http://127.0.0.1:43831/mcp` |
| Development build (`npm run dev`) | `http://127.0.0.1:43832/mcp` |

Settings always shows the address the running app is actually using — prefer it over the table.

## What an agent can do

Two groups of tools — nine for recording on every platform, and ten more for driving the window on macOS — plus one prompt, [`record_demo`](#the-record_demo-prompt). The tools return plain JSON (`screenshot` also returns an image) and refuse with an explanatory message instead of opening a dialog, so an agent never leaves a prompt waiting for a human to click something.

### Recording

| Tool | What it does | Arguments |
| --- | --- | --- |
| `get_status` | Recorder state (`idle`, `starting`, `countdown`, `recording`, `paused`, `stopping`, `finalizing`), the selected source, the path of the last recording, macOS permission status, and the state and progress of the last export. Read-only. | — |
| `list_sources` | Lists capturable screens and windows with their `id`, `name` and `type`. On macOS, windows on every desktop are listed, not just the current one, each with its `appName`, `pid`, `windowTitle`, `onScreen` flag and bounds, so two windows of the same app can be told apart. On Wayland it returns only the **Screen** entry. Read-only. | — |
| `select_source` | Chooses what to record, by exact `id` or by a case-insensitive substring of the source or app name. Refuses if nothing matches or several things do, listing the candidates. Raises the window. On macOS, if the window is on another desktop, macOS switches to that desktop, and the tool waits until the window is on screen. | `id`, `name` (one of) |
| `start_recording` | Starts capture and returns once it is genuinely running, after the countdown. Refuses if no source is selected (on Linux it records the screen entry instead), screen-recording permission is missing, the window is on another desktop or minimized, or a recording is already running or still saving. On Wayland it waits up to 120 seconds for a person to confirm the system share dialog. | `countdownSeconds` (0–10, defaults to your setting) |
| `pause_recording` | Pauses the running recording. | — |
| `resume_recording` | Resumes a paused recording. | — |
| `stop_recording` | Stops and saves, returning the saved video path once it is written. The editor then opens with automatic zooms already applied. | — |
| `cancel_recording` | Discards the running recording, or aborts the countdown before capture starts. | — |
| `export_video` | Exports the last recording with no save dialog, using the editor's current look — automatic zooms, cursor smoothing, background and frame — and returns the saved path. A long export returns `{ "status": "still-exporting" }`; poll `get_status` until `export.state` is `done` or `failed`. Reports progress to clients that ask for it. | `outputPath`, `format` (`mp4`, `gif`), `quality` (`medium`, `good`, `high`, `source`), `overwrite` |

### Driving the window

These tools exist only on macOS for now. On Windows and Linux they aren't offered, so the agent never sees them; [Mouse and keyboard control](#mouse-and-keyboard-control) describes what is planned. `open_url` and the input tools — everything from `click` down — refuse while **Let agents use the mouse and keyboard** is off.

| Tool | What it does | Arguments |
| --- | --- | --- |
| `open_url` | Opens an `http` or `https` address in your default browser — the one you are already signed in to — and selects the window showing it, so the next step can be `screenshot`. Refused while recording; the agent navigates inside the page with `perform` instead. | `url` |
| `screenshot` | A picture of the selected window, exactly the pixels a recording would capture, plus `width` and `height` of the image and `scale`, the number of window points per image pixel. If part of the window is off screen it also returns `originX` and `originY`. Read-only. | — |
| `find_elements` | Finds buttons, links, fields and other controls in the selected window by visible text or accessibility role, and returns each one's `role`, `label` and frame (`x`, `y`, `width`, `height`) in window points. Apps that draw their own interface, such as canvas editors and games, may expose few elements; the agent then picks points off a screenshot. Read-only. | `text`, `role`, `limit` (all optional) |
| `click` | Glides the pointer to a point and clicks there. `count` 2 double-clicks and 3 triple-clicks, which selects a line or paragraph in most apps. Modifiers are held during the click, so `["cmd"]` makes a cmd-click; a modifier click needs the recorded window frontmost. | `x`, `y`, `button` (`left`, `right`, `middle`), `count` (1–3), `modifiers`, `durationMs` |
| `drag` | Glides to the start point, presses the button, holds, moves to the end point with easing and releases — to move or reorder items, resize a pane, draw, or select a range. Takes 900 ms unless `durationMs` says otherwise. Both points must be inside the window, and the button is always released, even when you take over. A drag with modifiers needs the recorded window frontmost. | `fromX`, `fromY`, `toX`, `toY`, `button`, `modifiers`, `durationMs` |
| `move_pointer` | Glides the pointer to a point without clicking, for hovering. | `x`, `y`, `durationMs` |
| `scroll` | Scrolls whatever is under a point, in pixels: positive `deltaY` scrolls down, positive `deltaX` scrolls right. Modifiers are held while it scrolls and need the recorded window frontmost; shift-scroll scrolls sideways in many apps. | `x`, `y`, `deltaY`, `deltaX`, `modifiers` |
| `type_text` | Types text into the focused field, a character at a time at a natural pace. Any text works — other languages, emoji, symbols — whatever your keyboard layout. A newline (`\n` or `\r\n`) presses Return and a tab (`\t`) presses Tab; nothing else is pressed, so end the text with `\n` to submit it. | `text` |
| `press_key` | Presses one key or shortcut, optionally several times in a row, about 35 ms apart. See [Keys and modifiers](#keys-and-modifiers). | `key`, `modifiers`, `repeat` (1–100) |
| `perform` | Runs a list of steps — `move`, `click`, `drag`, `scroll`, `type`, `key` and `wait` — back to back with exact timing. Up to 200 steps, waits of up to 30 seconds, and 10 minutes per call. | `steps` |

**Coordinates are window-relative points.** `0, 0` is the top-left corner of the selected window, whatever desktop or display it is on, and a point is the unit macOS uses for window sizes, not a screen pixel. `find_elements` already answers in points; for a spot picked off a screenshot, multiply its image pixel position by `scale`. Every target, including both ends of a drag, must fall inside the selected window, which Recordly re-measures before each step, so the pointer cannot wander onto anything else.

**Use `perform` while recording.** Each separate tool call waits for the agent to think, which shows up in the video as uneven pauses. One `perform` per scene — click, wait two or three seconds for the page to settle, type, scroll — keeps the pacing even. Each step takes the same arguments as the matching single tool, plus `action`; `wait` takes `ms`:

```json
{
  "steps": [
    { "action": "click", "x": 412, "y": 296 },
    { "action": "wait", "ms": 2500 },
    { "action": "click", "x": 640, "y": 118 },
    { "action": "type", "text": "Quarterly report\n" },
    { "action": "wait", "ms": 2000 },
    { "action": "key", "key": "down", "repeat": 3 },
    { "action": "key", "key": "s", "modifiers": ["cmd"] },
    { "action": "wait", "ms": 2000 },
    { "action": "drag", "fromX": 300, "fromY": 420, "toX": 300, "toY": 220, "durationMs": 900 },
    { "action": "move", "x": 520, "y": 380, "durationMs": 800 },
    { "action": "scroll", "x": 520, "y": 380, "deltaY": 480 }
  ]
}
```

**Clicks are real.** Recordly moves your actual pointer and posts actual clicks, so they reach the recording exactly like yours: the cursor glides, changes shape over links and fields, and the editor adds its automatic zooms where the agent clicked. Automatic zooms need a landscape window — at least 1.2 times as wide as it is tall.

**Keep the window in front and uncovered.** On macOS a recording is the display cropped to the window's frame, so anything on top of it — another window, a notification banner — ends up in the video. Recordly raises the window before recording and before every action, but don't drag other windows over it, and consider a Focus mode to hold back notifications.

A recording-only run is `list_sources` → `select_source` → `start_recording` → perform the demo → `stop_recording` → `export_video`. Recordly ships these instructions to the agent itself, so in practice you can just ask for the recording you want.

### Keys and modifiers

`press_key` and the `key` step of `perform` take a key name, an alias, or one character.

| Keys | Names | Also accepted |
| --- | --- | --- |
| Editing | `enter`, `tab`, `escape`, `backspace`, `delete`, `space` | `return`; `esc`; `del`, `forwarddelete`; `spacebar` |
| Arrows | `up`, `down`, `left`, `right` | `arrowup`, `uparrow`, and the same for the other three |
| Navigation | `home`, `end`, `pageup`, `pagedown` | `pgup`, `pgdn` |
| Punctuation keys | `minus`, `equal`, `leftbracket`, `rightbracket`, `backslash`, `semicolon`, `quote`, `comma`, `period`, `slash`, `grave` | `hyphen`, `dash`; `equals`; `apostrophe`; `backtick` |
| Function keys | `f1`–`f20` | — |
| Keypad | `keypad0`–`keypad9`, `keypaddecimal`, `keypadplus`, `keypadminus`, `keypadmultiply`, `keypaddivide`, `keypadenter`, `keypadequals`, `keypadclear` | — |
| Letters and digits | `a`–`z`, `0`–`9` | — |

Names ignore case, spaces, `_` and `-`, so `Page Up`, `page_up` and `pageup` are the same key. A single character is pressed with the key that types it on your current keyboard layout, and Recordly adds Shift or Option when the layout needs them: `?` works, and `A` means Shift-a. A character that isn't a single key on the layout — `é` on a US layout, for example — is typed as text when no modifiers are given; with modifiers it is refused. A key of `\n` or `\t` means `enter` or `tab`; other control characters are refused. A combined string such as `"cmd+c"` is refused too, with a hint to pass the modifiers separately.

`backspace` deletes the character before the caret; `delete` is forward delete, the ⌦ key (fn-Backspace on a laptop keyboard).

Modifiers are held down during a key press, click, drag or scroll, at most five at a time: `cmd` (also `command`, `meta`, `super`, `win`, `windows`), `shift`, `alt` (also `option`, `opt`), `ctrl` (also `control`) and `fn` (also `function`). `ctrl`, `alt`, `shift` and `cmd` are pressed as real modifier keys; `fn` is only a flag on the event. Key presses, typing and any action with modifiers go only to the recorded window, so they need it frontmost — if another window is in front, the tool refuses and the agent brings the window forward with `select_source` before trying again.

| Shortcut | Call |
| --- | --- |
| cmd-S | `{ "key": "s", "modifiers": ["cmd"] }` |
| cmd-shift-Z | `{ "key": "z", "modifiers": ["cmd", "shift"] }` |
| cmd-comma, an app's settings | `{ "key": ",", "modifiers": ["cmd"] }` |
| Right arrow five times | `{ "key": "right", "repeat": 5 }` |
| A question mark | `{ "key": "?" }` |
| Shift-Tab | `{ "key": "tab", "modifiers": ["shift"] }` |

To enter words, use `type_text` rather than one `press_key` per character.

## Recording a demo with only Recordly

With both switches on, an agent can produce a finished demo of any website or desktop app with no browser automation tool of its own. Ask for it in plain words, for example *"Record a demo of signing up at https://example.com and changing the profile photo, and save it to ~/Movies"*. The agent then works through these steps:

1. **`open_url`** with the page — or, for a desktop app, **`list_sources`** and **`select_source`**. A page opens in your default browser, already signed in, and its window becomes the selected source.
2. **`screenshot`** and **`find_elements`** to learn the screen and plan every target. Nothing is being recorded yet, so this can take as long as it needs.
3. **`start_recording`**, once the plan is ready.
4. **`perform`**, once per scene: the steps for that scene, with waits so a viewer can follow. Between scenes the agent takes another `screenshot` to check the result and find the next targets.
5. **`stop_recording`**. The editor opens with automatic zooms on every click.
6. **`export_video`** with the destination and format you asked for.

Keep your hands off the mouse and keyboard while it runs: touching either stops the agent (see [Mouse and keyboard control](#mouse-and-keyboard-control)). If you do take over, the agent asks you before carrying on from a fresh screenshot.

### The `record_demo` prompt

Recordly also offers an MCP prompt, `record_demo`, that hands the agent this plan step by step for whatever you want to show. Claude Code lists it as the slash command `/mcp__recordly__record_demo`, taking the arguments in this order, for example `/mcp__recordly__record_demo "signing up and changing the profile photo" https://example.com`. Other clients list it with their prompts.

| Argument | Required | What it is |
| --- | --- | --- |
| `goal` | Yes | What the demo should show, in plain words |
| `url` | No | The web page to start from |
| `app` | No | The desktop app or window to record, when it isn't a web page |
| `output_path` | No | Where to save the video: an absolute path ending in `.mp4` or `.gif` |

On macOS the plan has the agent drive the window itself. On Windows and Linux it is a recording-only plan: the agent selects the source and records while you perform the demo, and on Wayland it asks you to confirm the share dialog.

## Writing a good demo

These habits make a clean video of any app or site, whether you ask in plain words or use `record_demo`:

- **Tell one story.** One goal per video, split into a few scenes that each show one thing. Say in the request what the viewer should come away knowing.
- **Prepare the window.** Make it landscape — at least 1.2 times as wide as tall — so automatic zooms work, and keep it uncovered. Sign in, load any sample data, and close what you don't want seen before the agent starts.
- **Plan before recording.** The agent looks with `screenshot` and `find_elements` first, while nothing is recorded, and avoids steps with side effects — submitting, deleting — until the take.
- **One `perform` per scene, with room to breathe.** Waits of 1.5 to 3 seconds between beats and after anything that loads give viewers time to follow. A slower `durationMs` or a `move_pointer` before a click draws the eye to what matters.
- **Look again after every change.** Navigation, dialogs and scrolling move everything, so coordinates from an earlier screenshot are stale. The agent takes a new screenshot between scenes and checks that the last one did what it should.
- **Words with `type_text`, shortcuts with `press_key`.** Typed text appears at a natural pace in any language; shortcuts read as instant actions.
- **Recover, don't push on.** If a step fails, the steps before it have already happened; the agent looks at the screen and continues from there, or uses `cancel_recording` and starts the take again.

## Adding Recordly to your AI tool

Every example needs two values from the settings panel: the **address** and the **token**. Replace `YOUR_TOKEN` throughout.

### Claude Code

The **Copy setup command** button produces exactly this:

```bash
claude mcp add --scope user --transport http recordly http://127.0.0.1:43831/mcp \
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

### Mouse and keyboard control

Driving your mouse and keyboard is far more powerful than recording, so it has its own switch and its own limits. Today it exists only on macOS; on Windows and Linux it is planned, and the sections below say what is built and what is not.

#### macOS: available now

[Platform support](#platform-support): driving the window, its switch and every control tool are available on macOS today.

- **Let agents use the mouse and keyboard** is off by default and stored with the connection settings. While it is off, `open_url` and every input tool refuse; `screenshot` and `find_elements` still work.
- Recordly needs two macOS permissions: **Screen Recording**, to record and to take screenshots, and **Accessibility**, to post input and read controls for `find_elements`. macOS grants both to the app, not to the agent, and when one is missing the tools say so instead of failing silently.
- Input goes only into the selected window. Pointer targets must fall inside it, re-measured before every step, and typing and key presses go to it only while its app is frontmost — never to Recordly's own editor or to whatever happened to be in front. The window must also stay uncovered, because the recording is the display cropped to the window.
- You can always take back control. Moving the mouse, clicking, scrolling or pressing any key yourself stops the running action or `perform` at once, and pressing **Esc** does the same. The agent is told *stopped: the user took over*, and is instructed to ask you before continuing.
- Clicks are real posted events, not simulated inside a page, so the recording shows the cursor moving and the editor adds automatic zooms where the agent clicked.
- `open_url` accepts only `http` and `https` addresses.
- `perform` is capped at 200 steps, 30 seconds per wait and 10 minutes per call; a key may repeat at most 100 times.
- In a development build (`npm run dev`) macOS checks the Accessibility permission of the terminal app that started Recordly, not Recordly itself, so input fails there even when Recordly is allowed. Use the installed app to test agent control.

#### Windows: not available yet (planned)

[Platform support](#platform-support): on Windows, recording works today and driving the window does not.

Today the control tools aren't offered and the **Let agents use the mouse and keyboard** switch is hidden. Recording, export and every recording tool work.

The plan, not yet built:

- A native helper posts mouse and keyboard input with `SendInput`, typing text as Unicode characters through `KEYEVENTF_UNICODE`, so it is independent of the keyboard layout.
- `find_elements` reads controls through UI Automation.
- The helper handles foreground rules so it can raise the selected window before acting.
- Low-level mouse and keyboard hooks detect when you take over, as on macOS.

No special permission will be needed. One limitation will apply: Windows blocks input from a normal process into windows that run as administrator, so a Recordly that is not itself elevated will not be able to drive an elevated window.

#### Linux: not available yet (planned)

[Platform support](#platform-support): on Linux, recording works today and driving the window does not.

Today the control tools aren't offered and the switch is hidden. Recording works: unattended on X11, and on Wayland after a person confirms the system share dialog, as described above.

The plan, not yet built:

- **X11 first.** A helper will post input through XTest, read controls for `find_elements` through AT-SPI, and detect takeover through XInput2.
- **Wayland later.** Wayland blocks synthetic input by design; it needs the RemoteDesktop portal, which asks the user for permission in a dialog every session. Until that is supported, the control tools will refuse on Wayland with a clear message.

## Troubleshooting

**"Port 43831 is already in use."** Another program holds the port. Close it, then turn the setting off and on again.

**Every call returns `401`.** The token is wrong or missing. With Codex, check that `RECORDLY_MCP_TOKEN` is actually exported in the shell that starts it. If you pressed **Regenerate token**, re-add Recordly everywhere with the new one.

**Every call returns `403`.** The client is sending an `Origin` header, or reaching the app through a hostname other than `127.0.0.1` or `localhost`. Browser-based clients cannot connect by design.

**Tools refuse with a permission error.** macOS screen recording and accessibility permissions are granted to applications, not to agents. Open System Settings and grant them to Recordly, then try again.

**The agent cannot see Recordly at all.** Confirm the panel says *Running at …*, and that the port in your configuration matches it — an installed app and a development build use different ports.

**An agent inside WSL2 can't connect.** Recordly listens on `127.0.0.1` on Windows, which WSL2's default NAT networking does not share. Add `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig` and run `wsl --shutdown`, or run the agent natively on Windows.

**`start_recording` waits on Linux.** On Wayland, the system share dialog has to be confirmed by a person; the agent asks you to, and the start gives up after 120 seconds. On X11, the **Entire screen** entry records with no prompt.

**The agent has no `open_url`, `screenshot` or input tools.** On Windows and Linux they aren't offered yet (see [Mouse and keyboard control](#mouse-and-keyboard-control)); the agent can still record while you perform the demo.

**"The window is on another desktop or minimized."** On macOS, capture can only see windows on the current desktop. Un-minimize the window, or have the agent call `select_source` again, which switches to the window's desktop. If the same app has two windows, select by `id` and use `windowTitle` and `pid` from `list_sources` to pick the right one.

**Input tools say mouse and keyboard control is off.** Turn on **Let agents use the mouse and keyboard** under the connection switch. `open_url` refuses for the same reason.

**"Recordly can't post input."** Open **System Settings → Privacy & Security → Accessibility**, turn Recordly on, then quit and reopen it. In a development build (`npm run dev`) macOS checks the terminal app that started Recordly instead, so input fails even though Recordly itself is allowed — test agent control with the installed app.

**"Stopped: the user took over."** You moved the mouse, scrolled, clicked or pressed a key while the agent was acting, or pressed **Esc**. This is the safety stop working. Keep your hands off while a demo runs; the agent asks you before picking up again from a fresh `screenshot`.

**A key is refused as unknown.** Use a name from [Keys and modifiers](#keys-and-modifiers) or one character, and pass shortcuts as a key plus `modifiers` — `"cmd+c"` in one string is refused. A character that isn't on the current layout can't be combined with modifiers. For words and other scripts, `type_text` works whatever the layout.

**"Typing, keys and modifier clicks go only to the recorded window."** Another window is in front of the recorded one. The agent calls `select_source` again to bring it forward; if a dialog or another app keeps covering it, close that first.

**Other windows or notifications appear in the video.** On macOS the recording is the display cropped to the window, so whatever covers it is captured too. Keep the window frontmost and uncovered, and hold back notifications with a Focus mode. Windows captures the window itself, so this does not happen there.

**Agent clicks don't produce automatic zooms.** Automatic zooms need a landscape window; resize a tall window to be wider than it is high. Clicks sent through another tool, such as a browser automation server, never move the real pointer, so Recordly cannot see them — use Recordly's own `click` and `perform`.
