# Recordly AI agent control (MCP)

Recordly can expose its recorder to local AI tools over the Model Context Protocol, so an agent such as Claude Code or Codex can select a window, record a demo, and export the finished video with automatic zooms applied. If you allow it, the agent can also drive the window it records — open a web page, look at it, click, drag, type, press shortcuts and scroll — so a whole demo of any website or app needs nothing but Recordly. The connection is off by default, listens only on the loopback interface, and requires a token that is generated on your own computer. Nothing is sent anywhere: the agent and Recordly both run on your machine.

## Platform support

Recording works everywhere; driving the window works on macOS, Windows and Linux with X11.

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Record, pause, stop, export | Yes | Yes | Yes. Unattended on X11; on Wayland a person confirms the share dialog |
| Driving the window (`open_url`, `screenshot`, `find_elements`, input tools, `perform`) and its switch | Yes — see [macOS](#macos) | Yes — see [Windows](#windows) | Yes on X11 — see [Linux](#linux); not yet on Wayland |
| The `record_demo` prompt | Plans a demo the agent drives itself | Plans a demo the agent drives itself | On X11, a demo the agent drives itself; on Wayland, one the user performs while Recordly records |
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

Two groups of tools — ten for recording and reviewing on every platform, and eleven more for driving the window on macOS — plus one prompt, [`record_demo`](#the-record_demo-prompt). The tools return plain JSON (`screenshot` and `review_recording` also return an image) and refuse with an explanatory message instead of opening a dialog, so an agent never leaves a prompt waiting for a human to click something.

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
| `review_recording` | Checks the edited video before export, once the editor shows the latest recording: a contact sheet of up to nine frames (the start, the last frame before each cut and the end, left to right and top to bottom) and a summary — each frame's time and label, raw and final duration, time removed, cuts, zooms, captions, scenes, failed scenes and the longest still stretch left. | — |
| `export_video` | Exports the last recording with no save dialog, using the editor's current look — automatic zooms, cursor smoothing, background and frame — and returns the saved path. A long export returns `{ "status": "still-exporting" }`; poll `get_status` until `export.state` is `done` or `failed`. Reports progress to clients that ask for it. | `outputPath`, `format` (`mp4`, `gif`), `quality` (`medium`, `good`, `high`, `source`), `overwrite` |

### Driving the window

These tools are offered on macOS, Windows and Linux with X11. On Wayland they aren't offered, so the agent never sees them; [Mouse and keyboard control](#mouse-and-keyboard-control) describes each platform. `open_url` and the input tools — everything from `click` down — refuse while **Let agents use the mouse and keyboard** is off.

| Tool | What it does | Arguments |
| --- | --- | --- |
| `open_url` | Opens an `http` or `https` address in your default browser — the one you are already signed in to — and selects the window showing it, so the next step can be `screenshot`. Refused while recording; the agent navigates inside the page with `perform` instead. | `url` |
| `screenshot` | A picture of the selected window, exactly the pixels a recording would capture, plus `width` and `height` of the image and `scale`, the number of window points per image pixel. If part of the window is off screen it also returns `originX` and `originY`. With `region`, it shows only that rectangle of the window at up to the display's full resolution, for aiming at small controls, and always returns `originX` and `originY`: window point = origin + image pixel × `scale`. Read-only. | `region` (optional: `x`, `y`, `width`, `height` in window points) |
| `find_elements` | Finds buttons, links, fields and other controls in the selected window by visible text or accessibility role, and returns each one's `role`, `label` and frame (`x`, `y`, `width`, `height`) in window points. Apps that draw their own interface, such as canvas editors and games, may expose few elements; the agent then picks points off a screenshot. Read-only. | `text`, `role`, `limit` (all optional) |
| `click` | Glides the pointer to a point — or to a `target`, an element found by its text when the step runs — and clicks there. `count` 2 double-clicks and 3 triple-clicks, which selects a line or paragraph in most apps. Modifiers are held during the click, so `["cmd"]` makes a cmd-click; a modifier click needs the recorded window frontmost. | `x`, `y` or `target`, `button` (`left`, `right`, `middle`), `count` (1–3), `modifiers`, `durationMs` |
| `drag` | Glides to the start point, presses the button, holds, moves to the end point with easing and releases — to move or reorder items, resize a pane, draw, or select a range. Its speed follows the distance unless `durationMs` says otherwise. Each end can be a point or an element (`from`, `to`), and both must be inside the window, and the button is always released, even when you take over. A drag with modifiers needs the recorded window frontmost. | `fromX`, `fromY` or `from`, `toX`, `toY` or `to`, `button`, `modifiers`, `durationMs` |
| `move_pointer` | Glides the pointer to a point or element without clicking, for hovering. | `x`, `y` or `target`, `durationMs` |
| `scroll` | Scrolls whatever is under a point, in pixels: positive `deltaY` scrolls down, positive `deltaX` scrolls right. Modifiers are held while it scrolls and need the recorded window frontmost; shift-scroll scrolls sideways in many apps. | `x`, `y` or `target`, `deltaY`, `deltaX`, `modifiers` |
| `type_text` | Types text into the focused field, a character at a time at a natural pace. Any text works — other languages, emoji, symbols — whatever your keyboard layout. A newline (`\n` or `\r\n`) presses Return and a tab (`\t`) presses Tab; nothing else is pressed, so end the text with `\n` to submit it. With `into`, it first clicks that field. | `text`, `into` |
| `press_key` | Presses one key or shortcut, optionally several times in a row, about 35 ms apart. See [Keys and modifiers](#keys-and-modifiers). | `key`, `modifiers`, `repeat` (1–100) |
| `wait_for` | Waits until an element appears (`text`, `role`), disappears (`gone`), or the screen stops changing (`settled`). Element waits fail after `timeoutMs` (10 seconds by default); `settled` carries on. | `text`, `role`, `gone`, `settled`, `timeoutMs` |
| `perform` | Runs a list of steps — `move`, `click`, `drag`, `scroll`, `type`, `key`, `wait` and `waitFor` — back to back with exact timing. Targets let one call cross several pages. Left without durations, Recordly glides at a natural speed and, after a click or Enter, waits for the screen to settle and holds the result for reading; `pace` makes that brisk, normal or relaxed. `dryRun` checks the current page's targets without acting and reports each step, numbered from 1 like `Step n`, and `then: "elements"` returns the visible controls afterwards. Up to 200 steps, waits of up to 30 seconds, and 10 minutes per call. An optional `title` names the scene and becomes an on-screen caption. A failed step's message starts with `Step n`. | `steps`, `title`, `pace`, `dryRun`, `then` (all but `steps` optional) |

**Targets are found when the step runs.** A target is `{ "text": …, "role": …, "index": … }`: part of the element's label or text in any case, optionally its kind (`button`, `link`, `textfield`, `checkbox`, `tab`, `menuitem` and so on) and, when several match, which one counting from 0 top to bottom. Recordly waits up to 5 seconds for it to appear, scrolls it into view if it is hidden below or above, and refuses with the candidates when it is ambiguous. Because the element is looked up at that moment, one `perform` can click a link, land on the next page and carry on there.

**Coordinates are window-relative points.** `0, 0` is the top-left corner of the selected window, whatever desktop or display it is on, and a point is the unit macOS uses for window sizes, not a screen pixel. `find_elements` already answers in points; for a spot picked off a screenshot, multiply its image pixel position by `scale`. Every target, including both ends of a drag, must fall inside the selected window, which Recordly re-measures before each step, so the pointer cannot wander onto anything else.

**Use `perform` while recording.** Each separate tool call waits for the agent to think. Recordly cuts that time from the video, but a scene split across many calls turns into many small cuts. One `perform` per scene — click, wait two seconds or so for the page to settle, type, scroll — keeps the motion continuous and the pacing even. Each step takes the same arguments as the matching single tool, plus `action`; `wait` takes `ms`:

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
2. **`screenshot`** and **`find_elements`** to learn the screen and plan every target, then `perform` with `dryRun` to check the first scene's targets. Nothing is being recorded yet, so this can take as long as it needs.
3. **`move_pointer`** to where the first scene begins, then **`start_recording`**, once the plan is ready.
4. **`perform`**, once per scene or once for a whole flow, aimed at targets. Recordly paces the motion and holds each result for reading. Between calls the agent takes another `screenshot` when it needs to check the result.
5. **`stop_recording`**. The editor opens with the agent's thinking time already cut and zooms on its clicks (see [Automatic edits](#automatic-edits-for-agent-recordings)).
6. **`review_recording`** to check the contact sheet and summary, then **`export_video`** with the destination and format you asked for.

Keep your hands off the mouse and keyboard while it runs: touching either stops the agent (see [Mouse and keyboard control](#mouse-and-keyboard-control)). If you do take over, the agent asks you before carrying on from a fresh screenshot.

### The `record_demo` prompt

Recordly also offers an MCP prompt, `record_demo`, that hands the agent this plan step by step for whatever you want to show. Claude Code lists it as the slash command `/mcp__recordly__record_demo`, taking the arguments in this order, for example `/mcp__recordly__record_demo "signing up and changing the profile photo" https://example.com`. Other clients list it with their prompts.

| Argument | Required | What it is |
| --- | --- | --- |
| `goal` | Yes | What the demo should show, in plain words |
| `url` | No | The web page to start from |
| `app` | No | The desktop app or window to record, when it isn't a web page |
| `output_path` | No | Where to save the video: an absolute path ending in `.mp4` or `.gif` |

Where driving the window is available, the plan has the agent drive it itself. On Wayland it is a recording-only plan: the agent selects the source and records while you perform the demo, and asks you to confirm the share dialog.

## Writing a good demo

These habits make a clean video of any app or site, whether you ask in plain words or use `record_demo`:

- **Tell one story.** One goal per video, split into a few scenes that each show one thing. Say in the request what the viewer should come away knowing.
- **Prepare the window.** Make it landscape — at least 1.2 times as wide as tall — so automatic zooms work, and keep it uncovered. Sign in, load any sample data, and close what you don't want seen before the agent starts.
- **Plan before recording.** The agent looks with `screenshot` and `find_elements` first, while nothing is recorded, and avoids steps with side effects — submitting, deleting — until the take.
- **Aim by text.** Targets name the element to click, so the click lands on its centre wherever the page puts it. For a control with no label, the agent screenshots a small region around it (about 300 × 200 points), which comes back at the display's full resolution, instead of guessing from the whole-window image.
- **Start with the cursor in place.** The agent moves the pointer to where the first scene begins before `start_recording`, so the video does not open with the cursor somewhere else.
- **Leave the timing to Recordly.** Glides follow the distance, each click or Enter waits for the screen to settle and then holds the result for reading, and the pointer rests on the target briefly before pressing so the drawn cursor is on it when the click lands. A `wait` or `waitFor` straight after a click replaces that hold, so the agent adds a `wait` only for longer reading time and a `waitFor` only for slow content.
- **Captions only when you want them.** Ask for captions or a step-by-step tutorial and the agent gives each scene a `title`, shown at the bottom of the video as the scene starts.
- **Check the result before exporting.** `review_recording` shows the edited video as a contact sheet, so the agent can spot an error page or a covered window and offer to record that part again.
- **Words with `type_text`, shortcuts with `press_key`.** Typed text appears at a natural pace in any language; shortcuts read as instant actions.
- **Recover, don't push on.** If a step fails, the steps before it have already happened; the agent looks at the screen and continues from there, or uses `cancel_recording` and starts the take again.

## Automatic edits for agent recordings

While an agent drives the window, Recordly notes what it does and when. When the recording opens in the editor, Recordly uses those notes to edit it:

- **Thinking time is cut.** The time between the agent's tool calls — while it looks at the screen and decides the next step — is removed, as is the wait before the first action. A short lead and tail are kept around every action so the cuts don't feel abrupt.
- **Waiting is shortened.** A window coming to the front shrinks to a brief beat.
- **Actions and reading time stay.** Every movement, click, scroll, keystroke and the agent's own `wait` steps are kept in full.
- **Zooms follow the actions.** Each click zooms in from the moment the pointer heads for it until the result has been on screen, close clicks share one zoom, and nothing zooms on a large target or while scrolling.
- **An interrupted take is removed.** If you take over during a scene and the agent redoes it, the interrupted attempt is cut. When a step fails, the steps before it stay, since the agent carries on from there.

The edits are ordinary clips, zooms and captions on the timeline, so you can change or undo any of them, and `export_video` exports them. Recordings you make yourself are not affected. To turn this off, clear **Tighten agent recordings** in the editor settings.

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

Driving your mouse and keyboard is far more powerful than recording, so it has its own switch and its own limits. It works on macOS, Windows and Linux with X11; the sections below describe each platform.

#### Every platform

- **Let agents use the mouse and keyboard** is off by default and stored with the connection settings. While it is off, `open_url` and every input tool refuse; `screenshot` and `find_elements` still work.
- Input goes only into the selected window. Pointer targets must fall inside it, re-measured before every step, and typing and key presses go to it only while its app is frontmost — never to Recordly's own editor or to whatever happened to be in front.
- You can always take back control. Moving the mouse, clicking, scrolling or pressing any key yourself stops the running action or `perform` at once, and pressing **Esc** does the same. A pointer drift of a few points, such as a hand resting on the trackpad, does not count, and neither do two fingers resting on it without scrolling. The agent is told *stopped: the user took over*, along with what Recordly noticed, and is instructed to ask you before continuing.
- Clicks are real posted events, not simulated inside a page, so the recording shows the cursor moving and the editor adds automatic zooms where the agent clicked.
- `open_url` accepts only `http` and `https` addresses.
- `perform` is capped at 200 steps, 30 seconds per wait and 10 minutes per call; a key may repeat at most 100 times.

#### macOS

- Recordly needs two macOS permissions: **Screen Recording**, to record and to take screenshots, and **Accessibility**, to post input and read controls for `find_elements`. macOS grants both to the app, not to the agent, and when one is missing the tools say so instead of failing silently.
- The window must stay uncovered, because the recording is the display cropped to the window.
- In a development build (`npm run dev`) macOS checks the Accessibility permission of the terminal app that started Recordly, not Recordly itself, so input fails there even when Recordly is allowed. Use the installed app to test agent control.

#### Windows

[Platform support](#platform-support): driving the window works on Windows with the same tools and the same switch.

- A native helper posts input with `SendInput` and tags every event, so Recordly can tell its own input from yours. Text is typed as Unicode characters, so any language and emoji work whatever the keyboard layout; single-character keys follow the layout of the window in front.
- `find_elements` and targets read controls through UI Automation. Roles come back as UI Automation names such as `Button`, `Edit` and `Heading`; the role names used on macOS are accepted too. Browsers built on Chromium expose their page to UI Automation once Recordly asks for it, which the first lookup in a window does. Text inside rich-edit documents, such as Notepad's page, is not searchable.
- The helper works with the foreground rules to raise the selected window, restoring it if it is minimized.
- Low-level mouse and keyboard hooks detect when you take over, with the same tolerance as on macOS.
- No special permission is needed. Windows blocks input from a normal process into windows that run as administrator, so the tools refuse an elevated window with a clear message unless Recordly itself runs elevated.
- `cmd` is the Windows key here: shortcuts use `ctrl`, for example `{"key":"c","modifiers":["ctrl"]}`.
- The recording captures the window itself, but clicks land wherever the window is on screen, so keep it in front and uncovered while the agent acts.

#### Linux

[Platform support](#platform-support): on Linux, driving the window works on X11. On Wayland it is refused with a clear message, and recording works as described above.

- A native helper posts input through XTest and detects takeover through XInput2. XTest events can't carry a tag, so the helper keeps a short record of what it just posted and treats any other input as yours, with the same tolerance as on macOS.
- `find_elements` and targets read controls through AT-SPI, the Linux accessibility bus, which most desktops run. Chromium-based browsers and Electron apps join it only when started with `ACCESSIBILITY_ENABLED=1`, for example `ACCESSIBILITY_ENABLED=1 google-chrome`; otherwise the agent aims with region screenshots instead.
- The whole screen is recorded. `open_url`, or `select_source` with a window's `id`, picks the window the agent acts on; the recording stays on the screen. With no window picked, the control tools refuse rather than type into whatever is in front.
- A window manager that follows the EWMH standard raises the selected window; GNOME, KDE, Xfce, Cinnamon and most others do.
- No special permission is needed.
- `cmd` is the Super key here: shortcuts use `ctrl`, for example `{"key":"c","modifiers":["ctrl"]}`.
- **Wayland later.** Wayland blocks synthetic input by design; it needs the RemoteDesktop portal, which asks the user for permission in a dialog every session. Until that is supported, **Let agents use the mouse and keyboard** is turned off there with the reason shown, and the control tools aren't offered.

## Troubleshooting

**"Port 43831 is already in use."** Another program holds the port. Close it, then turn the setting off and on again.

**Every call returns `401`.** The token is wrong or missing. With Codex, check that `RECORDLY_MCP_TOKEN` is actually exported in the shell that starts it. If you pressed **Regenerate token**, re-add Recordly everywhere with the new one.

**Every call returns `403`.** The client is sending an `Origin` header, or reaching the app through a hostname other than `127.0.0.1` or `localhost`. Browser-based clients cannot connect by design.

**Tools refuse with a permission error.** macOS screen recording and accessibility permissions are granted to applications, not to agents. Open System Settings and grant them to Recordly, then try again.

**The agent cannot see Recordly at all.** Confirm the panel says *Running at …*, and that the port in your configuration matches it — an installed app and a development build use different ports.

**An agent inside WSL2 can't connect.** Recordly listens on `127.0.0.1` on Windows, which WSL2's default NAT networking does not share. Add `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig` and run `wsl --shutdown`, or run the agent natively on Windows.

**`start_recording` waits on Linux.** On Wayland, the system share dialog has to be confirmed by a person; the agent asks you to, and the start gives up after 120 seconds. On X11, the **Entire screen** entry records with no prompt.

**The agent has no `open_url`, `screenshot` or input tools.** They aren't offered on Wayland, or while the Recordly build lacks its mouse and keyboard helper for this platform (see [Mouse and keyboard control](#mouse-and-keyboard-control)); the agent can still record while you perform the demo. On Linux, check that the session is X11.

**`find_elements` finds nothing in a browser on Linux.** Chromium-based browsers and Electron apps join the accessibility bus only when started with `ACCESSIBILITY_ENABLED=1`. Quit the browser and start it that way, or let the agent aim with region screenshots.

**"The window is on another desktop or minimized."** On macOS, capture can only see windows on the current desktop. Un-minimize the window, or have the agent call `select_source` again, which switches to the window's desktop. If the same app has two windows, select by `id` and use `windowTitle` and `pid` from `list_sources` to pick the right one.

**Input tools say mouse and keyboard control is off.** Turn on **Let agents use the mouse and keyboard** under the connection switch. `open_url` refuses for the same reason.

**"Recordly can't post input."** Open **System Settings → Privacy & Security → Accessibility**, turn Recordly on, then quit and reopen it. In a development build (`npm run dev`) macOS checks the terminal app that started Recordly instead, so input fails even though Recordly itself is allowed — test agent control with the installed app.

**"Stopped: the user took over."** You moved the mouse, scrolled, clicked or pressed a key while the agent was acting, or pressed **Esc**. The message ends with what Recordly noticed, such as *the mouse moved* or *a key was pressed*. Typing in another app, such as replying to the agent while a demo runs, counts too. This is the safety stop working. Keep your hands off while a demo runs; the agent asks you before picking up again from a fresh `screenshot`.

**A key is refused as unknown.** Use a name from [Keys and modifiers](#keys-and-modifiers) or one character, and pass shortcuts as a key plus `modifiers` — `"cmd+c"` in one string is refused. A character that isn't on the current layout can't be combined with modifiers. For words and other scripts, `type_text` works whatever the layout.

**"Typing, keys and modifier clicks go only to the recorded window."** Another window is in front of the recorded one. The agent calls `select_source` again to bring it forward; if a dialog or another app keeps covering it, close that first.

**Other windows or notifications appear in the video.** On macOS the recording is the display cropped to the window, so whatever covers it is captured too. Keep the window frontmost and uncovered, and hold back notifications with a Focus mode. Windows captures the window itself, so this does not happen there.

**Agent clicks don't produce automatic zooms.** Automatic zooms need a landscape window; resize a tall window to be wider than it is high. Clicks sent through another tool, such as a browser automation server, never move the real pointer, so Recordly cannot see them — use Recordly's own `click` and `perform`.
