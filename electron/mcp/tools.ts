import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { AgentControl, AgentStep } from "./agentControl";
import { AGENT_KEY_ALIASES, AGENT_KEY_NAMES, AGENT_MODIFIER_ALIASES } from "./agentProtocol";
import { MAX_COUNTDOWN_SECONDS, type RemoteControl } from "./remoteControl";
import type { RemoteExport } from "./remoteExport";

const CONTROL_SWITCH = "'Let agents use the mouse and keyboard' in Recordly Settings → Advanced";
const CONTROL_OFF = `Mouse and keyboard control is off. Ask the user to turn on ${CONTROL_SWITCH}, then try again.`;

const withAliases = (names: readonly string[], aliases: Record<string, string>) =>
	names
		.map((name) => {
			const others = Object.keys(aliases).filter(
				(alias) => alias !== name && aliases[alias] === name,
			);
			return others.length > 0 ? `${name} (${others.join("/")})` : name;
		})
		.join(", ");

const MODIFIERS = withAliases(
	[...new Set(Object.values(AGENT_MODIFIER_ALIASES))],
	AGENT_MODIFIER_ALIASES,
);
const NAMED_KEYS = withAliases(
	AGENT_KEY_NAMES.filter((name) => name.length > 1 && !/^(f|keypad)\d+$/.test(name)),
	AGENT_KEY_ALIASES,
);

const KEY_REFERENCE =
	"key is a key name, an alias or one character. " +
	`Named keys (case, spaces, _ and - ignored; aliases in brackets): ${NAMED_KEYS}, f1–f20, keypad0–keypad9. ` +
	"One character is pressed with the key that types it on the user's current keyboard layout, adding " +
	'shift or option when the layout needs them: "?" works, and "A" means shift+a. A character that is ' +
	'not a single key on the layout (e.g. "é" on a US layout) is typed as text, and refused when ' +
	'modifiers are given. "\\n" and "\\t" mean enter and tab; other control characters are refused. ' +
	"backspace deletes before the caret; delete is forward delete. " +
	`Modifiers: ${MODIFIERS} — ctrl, alt, shift and cmd are pressed as real modifier keys; fn is only a ` +
	'flag on the key event. A combined string such as "cmd+c" is refused: pass the modifiers separately. ' +
	'Examples: cmd+s = {"key":"s","modifiers":["cmd"]}; cmd+shift+z = {"key":"z","modifiers":["cmd","shift"]}; ' +
	'cmd+, = {"key":",","modifiers":["cmd"]}; right arrow 5 times = {"key":"right","repeat":5}; ' +
	'? = {"key":"?"}. repeat presses the key again about every 35 ms. To enter text, use type_text instead.';

const POINT_HELP =
	"Coordinates are window-relative points: (0,0) is the top-left corner of the selected window. Take " +
	"them from find_elements (aim at the centre: x + width/2, y + height/2) or from screenshot (point = " +
	"image pixel × scale, plus originX/originY when it reports them). A point outside the window is " +
	"refused: take a fresh screenshot and recompute it.";

const INPUT_HELP =
	"Uses the real mouse and keyboard: Recordly raises the selected window first, and on macOS it must " +
	"stay frontmost and uncovered. Errors and what to do: 'the user took over' — the user moved the " +
	"mouse, typed or pressed Esc; stop and ask the user before doing anything else. 'Mouse and keyboard " +
	`control is off' — ask the user to turn on ${CONTROL_SWITCH}. 'not allowed to post mouse and ` +
	"keyboard input' — ask the user to grant Recordly Accessibility permission in System Settings, then " +
	"reopen it. 'another app is in front' — typing, keys and actions with modifiers go only to the " +
	"recorded window, so call select_source again to bring it to the front (ask the user to close a " +
	"dialog or window that keeps covering it), then screenshot and retry. 'closed, minimized or on " +
	"another desktop' or 'Select a window first' — call list_sources, then select_source, then " +
	"screenshot again.";

const MAC_INSTRUCTIONS =
	"Recordly records the screen and turns recordings into polished demo videos (automatic zoom on " +
	"clicks, smooth cursor). On macOS it also drives the recorded window with the real mouse and " +
	"keyboard, so a demo of any website or desktop app needs no other browser or input tool.\n\n" +
	"Workflow for any demo:\n" +
	"1. Target: open_url { url } for a web page (opens the user's default, signed-in browser and selects " +
	"its window); for a desktop app, list_sources → select_source (by id when one app has several " +
	"windows). Keep the window landscape (at least 1.2 × as wide as tall) so automatic zooms work, and " +
	"uncovered: the recording is the screen area under the window.\n" +
	"2. Plan before recording: screenshot and find_elements to learn the screen; write a short list of " +
	"scenes (what the viewer should see, and the steps). Avoid side effects while exploring. Nothing is " +
	"recorded yet, so take your time.\n" +
	"3. start_recording.\n" +
	"4. One perform call per scene: its moves, clicks, drags, scrolls, typing and keys, with 1.5–3 s wait " +
	"steps between beats and after anything that loads, so viewers can follow. Coordinates change after " +
	"navigation, dialogs or scrolling: end the scene there, screenshot to verify the result and locate " +
	"the next targets, then continue.\n" +
	"5. stop_recording (returns the saved path; the editor opens with zooms applied), then export_video.\n\n" +
	"Coordinates are window-relative points, (0,0) = the selected window's top-left. find_elements " +
	"answers in points; for a screenshot pixel, point = pixel × scale.\n\n" +
	"Errors and recovery: 'the user took over' → stop and ask the user before continuing. 'Mouse and " +
	`keyboard control is off' → ask the user to turn on ${CONTROL_SWITCH}. Missing Accessibility or ` +
	"Screen Recording permission → ask the user to grant it in System Settings and reopen Recordly. " +
	"Window closed, minimized, on another desktop, or another app in front → list_sources, select_source, " +
	"screenshot. Point outside the window or off screen → fresh screenshot; ask the user to move the " +
	"window fully onto a display if needed. A failed scene has already run its earlier steps: screenshot, " +
	"recover, redo it, or cancel_recording and start over if the take is ruined. Other refusals say what " +
	"to fix; never retry blindly. Act only inside the selected window, never on Recordly itself. Call " +
	"get_status at any time; tools refuse with a message instead of showing dialogs.";

const INSTRUCTIONS =
	"Recordly records the screen and turns recordings into polished demo videos (automatic zoom on " +
	"clicks, smooth cursor). It cannot move the mouse or type on this platform, so the user (or another " +
	"tool) performs the demo. Flow for any demo: list_sources → select_source → agree the steps with the " +
	"user → start_recording → the user performs the demo → stop_recording (returns the saved video path " +
	"and opens the editor) → export_video. On Linux with Wayland, the user must pick the screen in the " +
	"system share dialog after start_recording. Call get_status at any time. Tools refuse with a clear " +
	"message instead of showing dialogs; relay permission errors to the user.";

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const coordinate = (description: string) => z.number().min(0).describe(description);
const point = {
	x: coordinate("Window-relative x in points (0 = the window's left edge)"),
	y: coordinate("Window-relative y in points (0 = the window's top edge)"),
};
const durationMs = (description: string) =>
	z.number().int().min(0).max(10_000).optional().describe(description);
const glideMs = durationMs(
	"How long the pointer glides to the point, in ms (default under a second)",
);
const button = z
	.enum(["left", "right", "middle"])
	.optional()
	.describe("Mouse button; defaults to left (right opens a context menu)");
const modifiers = z
	.array(z.string().min(1).max(16))
	.max(5)
	.optional()
	.describe(
		`Keys held down during the action: ${MODIFIERS}. Needs the recorded window frontmost.`,
	);

const moveArgs = { ...point, durationMs: glideMs };
const clickArgs = {
	...point,
	button,
	count: z
		.literal([1, 2, 3])
		.optional()
		.describe(
			"1 = click (default), 2 = double-click, 3 = triple-click (selects a line or paragraph in most apps)",
		),
	modifiers,
	durationMs: glideMs,
};
const dragArgs = {
	fromX: coordinate("Window-relative x where the button goes down"),
	fromY: coordinate("Window-relative y where the button goes down"),
	toX: coordinate("Window-relative x where the button is released"),
	toY: coordinate("Window-relative y where the button is released"),
	button,
	modifiers,
	durationMs: durationMs("How long the drag takes, in ms; defaults to 900"),
};
const scrollArgs = {
	...point,
	deltaY: z
		.number()
		.min(-100_000)
		.max(100_000)
		.describe("Pixels to scroll; positive scrolls down, negative up"),
	deltaX: z
		.number()
		.min(-100_000)
		.max(100_000)
		.optional()
		.describe("Pixels to scroll sideways; positive scrolls right"),
	modifiers,
};
const typeArgs = {
	text: z
		.string()
		.min(1)
		.describe("Text to type exactly as given; \\n or \\r\\n presses Return, \\t presses Tab"),
};
const keyArgs = {
	key: z
		.string()
		.min(1)
		.max(32)
		.describe(
			'Key name, alias or one character, e.g. enter, tab, escape, down, f5, a, /, ?; not "cmd+c" — use modifiers',
		),
	modifiers,
	repeat: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("How many times to press it, about 35 ms apart (default 1, at most 100)"),
};

const stepSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("move"), ...moveArgs }),
	z.object({ action: z.literal("click"), ...clickArgs }),
	z.object({ action: z.literal("drag"), ...dragArgs }),
	z.object({ action: z.literal("scroll"), ...scrollArgs }),
	z.object({ action: z.literal("type"), ...typeArgs }),
	z.object({ action: z.literal("key"), ...keyArgs }),
	z.object({
		action: z.literal("wait"),
		ms: z.number().int().min(0).max(30_000).describe("Pause in ms (at most 30000)"),
	}),
]);

type DemoArgs = { goal: string; url?: string; app?: string; output_path?: string };

function demoPrompt(platform: NodeJS.Platform, { goal, url, app, output_path }: DemoArgs) {
	const exportStep = `Call stop_recording, then export_video${output_path ? ` with outputPath "${output_path}"` : ""}.`;
	if (platform === "darwin") {
		const target = url
			? `Call open_url with ${url}.`
			: app
				? `Call list_sources and select_source for ${app} (by id if it has several windows).`
				: "Pick what the goal needs: open_url for a web page, or list_sources then select_source " +
					"for an app. Ask the user if it is unclear.";
		return [
			`Record a demo video with Recordly that shows: ${goal}`,
			"",
			`1. Target. ${target} Make sure the window is landscape (at least 1.2 × as wide as tall, so ` +
				"automatic zooms work) and nothing covers it.",
			"2. Plan before recording. Use screenshot and find_elements to learn the screen, then write a " +
				"short list of scenes: what the viewer should see, and the steps (click, type, key, scroll, " +
				"drag, wait). Locate the first scene's targets now. Avoid side effects such as submitting or " +
				"deleting while exploring.",
			"3. Call start_recording.",
			"4. For each scene, call perform once: its steps with 1.5–3 s waits between beats and after " +
				"anything that loads. Between scenes, screenshot to confirm the result and locate the next " +
				"targets — coordinates change after navigation or scrolling.",
			`5. ${exportStep}`,
			"6. Tell the user the saved path and what the video shows.",
			"",
			"If a tool says the user took over, stop and ask the user. If a step fails, screenshot, recover " +
				"as the error says and redo the scene; if the take is ruined, cancel_recording and start " +
				"over. Act only inside the selected window.",
		].join("\n");
	}
	const linux = platform === "linux";
	const target = [
		url ? `Make sure ${url} is open in a browser window (ask the user to open it).` : "",
		app ? `The app to record is ${app}.` : "",
		linux
			? "Call list_sources, then select_source with the first entry (the screen)."
			: "Call list_sources, then select_source for the window to record.",
	]
		.filter(Boolean)
		.join(" ");
	return [
		`Record a demo video with Recordly that shows: ${goal}`,
		"",
		"Recordly records and exports here but cannot move the mouse or type on this platform, so the user " +
			"performs the demo.",
		`1. Target. ${target}`,
		"2. Agree a short, ordered list of demo steps with the user.",
		`3. Call start_recording.${linux ? " On Wayland, ask the user to choose the screen in the system share dialog; recording starts once they do." : ""}`,
		"4. Let the user perform the demo and wait until they say it is done; get_status shows the recorder state.",
		`5. ${exportStep}`,
		"6. Tell the user the saved path.",
	].join("\n");
}

export function buildRecordlyMcpServer(
	remote: RemoteControl,
	remoteExport: RemoteExport,
	version: string,
	{
		agent,
		isControlEnabled,
		platform = process.platform,
	}: { agent: AgentControl; isControlEnabled: () => boolean; platform?: NodeJS.Platform },
) {
	const mac = platform === "darwin";
	const server = new McpServer(
		{ name: "recordly", version },
		{ instructions: mac ? MAC_INSTRUCTIONS : INSTRUCTIONS },
	);

	async function perform(steps: AgentStep[]) {
		if (!isControlEnabled()) throw new Error(CONTROL_OFF);
		return textResult(await agent.perform(steps));
	}

	server.registerPrompt(
		"record_demo",
		{
			title: "Record a demo",
			description:
				"Step-by-step plan for recording a demo video of any website or app and exporting it" +
				(mac
					? "; Recordly drives the window itself."
					: "; the user performs the demo while Recordly records."),
			argsSchema: z.object({
				goal: z
					.string()
					.min(1)
					.describe(
						"What the demo should show, e.g. signing up and changing the profile photo",
					),
				url: z.string().optional().describe("Web page to start from"),
				app: z
					.string()
					.optional()
					.describe("Desktop app or window to record instead of a web page"),
				output_path: z
					.string()
					.optional()
					.describe("Where to save the video: an absolute path ending in .mp4 or .gif"),
			}),
		},
		(args) => ({
			messages: [
				{
					role: "user" as const,
					content: { type: "text" as const, text: demoPrompt(platform, args) },
				},
			],
		}),
	);

	server.registerTool(
		"get_status",
		{
			description:
				"Current recorder state (idle, starting, countdown, recording, paused, stopping, " +
				"finalizing), the " +
				"selected capture source, the path of the last recording, macOS permission status, and " +
				"the state/progress of the last export.",
			annotations: { readOnlyHint: true },
		},
		async () => textResult({ ...remote.getStatus(), export: remoteExport.getStatus() }),
	);

	server.registerTool(
		"list_sources",
		{
			description: mac
				? "List capturable screens and windows, including windows on other desktops. Windows carry " +
					"appName, windowTitle, pid, onScreen and their x/y/width/height in screen points, so two " +
					"windows of one app can be told apart. Use an id or name with select_source."
				: "List capturable screens and windows (id, name, type). Use an id or name with " +
					"select_source. On Linux the first entry records the screen chosen by the system; " +
					"needsUser: true means a person must pick it in the share dialog.",
			annotations: { readOnlyHint: true },
		},
		async () => textResult(await remote.listSources()),
	);

	server.registerTool(
		"select_source",
		{
			description:
				"Choose what to record, by exact id or by a case-insensitive name substring (matched against " +
				"the source name and app name). Fails if no source or more than one matches, listing the " +
				"candidates; then retry with the id." +
				(mac
					? " Raises the window (switching desktop if needed) and waits up to 2 s until it is on " +
						"screen. The mouse and keyboard tools act on this window only."
					: ""),
			inputSchema: z.object({
				id: z.string().min(1).optional().describe("Exact source id from list_sources"),
				name: z.string().min(1).optional().describe("Name substring of the window or app"),
			}),
		},
		async (args) => textResult(await remote.selectSource(args)),
	);

	server.registerTool(
		"start_recording",
		{
			description:
				"Start recording the selected source. Returns once capture is actually running (after the " +
				"countdown). Refuses if " +
				(platform === "linux"
					? "a recording is already running or still being saved; with no source selected it records the screen entry."
					: "no source is selected, permissions are missing, or a recording is already running or still being saved.") +
				(mac
					? " If the window is closed, minimized or on another desktop, call select_source again."
					: "") +
				(platform === "linux"
					? " On Wayland a person must confirm the system share dialog first; until then " +
						"get_status reports starting."
					: ""),
			inputSchema: z.object({
				countdownSeconds: z
					.number()
					.int()
					.min(0)
					.max(MAX_COUNTDOWN_SECONDS)
					.optional()
					.describe("Countdown before capture starts; defaults to the user's setting"),
			}),
		},
		async (args) => textResult(await remote.startRecording(args)),
	);

	server.registerTool(
		"pause_recording",
		{ description: "Pause the running recording." },
		async () => {
			await remote.pauseRecording();
			return textResult({ state: "paused" });
		},
	);

	server.registerTool(
		"resume_recording",
		{ description: "Resume a paused recording." },
		async () => {
			await remote.resumeRecording();
			return textResult({ state: "recording" });
		},
	);

	server.registerTool(
		"stop_recording",
		{
			description:
				"Stop and save the recording. Returns the saved video path once it is written; the editor " +
				"then opens with automatic zooms applied.",
		},
		async () => textResult(await remote.stopRecording()),
	);

	server.registerTool(
		"cancel_recording",
		{
			description:
				"Discard the running recording, or abort the countdown before capture starts. Use it to " +
				"throw away a ruined take before starting again.",
			annotations: { destructiveHint: true },
		},
		async () => {
			await remote.cancelRecording();
			return textResult({ cancelled: true });
		},
	);

	server.registerTool(
		"export_video",
		{
			description:
				"Export the last recording to a video file with no dialog, using the editor's current look " +
				"(automatic zooms, cursor, background). Waits for the editor to finish loading, then returns " +
				'the saved path. A very long export returns { status: "still-exporting" } — then poll ' +
				"get_status until export.state is done or failed.",
			inputSchema: z.object({
				outputPath: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Absolute path ending in .mp4 or .gif; defaults to the recordings folder",
					),
				format: z.enum(["mp4", "gif"]).optional().describe("Defaults to mp4"),
				quality: z
					.enum(["medium", "good", "high", "source"])
					.optional()
					.describe("Defaults to good"),
				overwrite: z
					.boolean()
					.optional()
					.describe("Replace an existing file at outputPath"),
			}),
		},
		async (args, ctx) => {
			const { state, lastRecordingPath } = remote.getStatus();
			if (state !== "idle" && state !== "finalizing") {
				throw new Error(
					`Recordly is ${state}. Finish with stop_recording before calling export_video.`,
				);
			}
			const progressToken = ctx.mcpReq._meta?.progressToken;
			const onProgress =
				progressToken === undefined
					? undefined
					: (progress: number) =>
							void ctx.mcpReq
								.notify({
									method: "notifications/progress",
									params: { progressToken, progress, total: 100 },
								})
								.catch(() => undefined);
			return textResult(
				await remoteExport.exportVideo(
					{ ...args, videoPath: lastRecordingPath },
					{ signal: ctx.mcpReq.signal, onProgress },
				),
			);
		},
	);

	if (!mac) return server;

	server.registerTool(
		"open_url",
		{
			description:
				"Open an http(s) URL in the user's default browser (their own signed-in profile), wait for " +
				"its window and select it as the capture source, ready for screenshot. Use it to start any " +
				"web demo. Refused while recording: navigate inside the page with perform instead (click a " +
				"link, or cmd+l, type the address, enter). Needs " +
				`${CONTROL_SWITCH}. If it cannot find the browser window, call list_sources, then ` +
				"select_source.",
			inputSchema: z.object({ url: z.string().min(1).describe("Full http(s) URL") }),
		},
		async ({ url }) => {
			if (!isControlEnabled()) throw new Error(CONTROL_OFF);
			return textResult(await agent.openUrl(url));
		},
	);

	server.registerTool(
		"screenshot",
		{
			description:
				"See the selected window: raises it, then returns a JPEG of exactly the screen area a " +
				"recording captures (long edge at most 1568 px), plus width, height and scale — window " +
				"points per image pixel, so point = pixel × scale. If part of the window is off screen it " +
				"also returns originX/originY: point = origin + pixel × scale. Not part of the video. Take " +
				"a fresh one after anything that changes the view (navigation, dialogs, scrolling, " +
				"resizing); older coordinates are stale. If the window is closed, minimized or on another " +
				"desktop, call list_sources, then select_source. To aim precisely at a small target (an " +
				"icon, list row, toggle) that find_elements does not list, screenshot a region around it " +
				"(e.g. 300 × 200 points): the image then shows only that rectangle, clamped to the window, " +
				"at up to the display's full resolution, and returns originX/originY — use point = origin + " +
				"pixel × scale.",
			inputSchema: z.object({
				region: z
					.object({
						x: z
							.number()
							.describe("Window-relative x of the region's left edge, in points"),
						y: z
							.number()
							.describe("Window-relative y of the region's top edge, in points"),
						width: z.number().positive().describe("Region width in points"),
						height: z.number().positive().describe("Region height in points"),
					})
					.optional()
					.describe("Zoom into this rectangle of the window; omit for the whole window"),
			}),
		},
		async ({ region }) => {
			const { data, mimeType, width, height, scale, originX, originY } =
				await agent.screenshot(region);
			const offset = region !== undefined || originX !== 0 || originY !== 0;
			const info = offset
				? {
						width,
						height,
						scale,
						originX,
						originY,
						hint: `${region ? "Only the region is shown." : "Part of the window is off screen."} Window point = (originX + pixel x × scale, originY + pixel y × scale).`,
					}
				: {
						width,
						height,
						scale,
						hint: "Window point = image pixel × scale. Pass window points to click, drag, move_pointer, scroll and perform.",
					};
			return {
				content: [
					{ type: "image" as const, data, mimeType },
					{ type: "text" as const, text: JSON.stringify(info) },
				],
			};
		},
	);

	server.registerTool(
		"find_elements",
		{
			description:
				"Find controls in the selected window through macOS Accessibility: buttons, links, text " +
				"fields, checkboxes, menus and labelled text. Filter by visible text and/or role. Returns " +
				"{ elements: [{role, label, x, y, width, height}], truncated } in window-relative points; " +
				"click the centre (x + width/2, y + height/2). More precise than reading a screenshot, but " +
				"some apps (canvas-based, games, custom-drawn UIs) expose few or no elements — then pick " +
				"points from screenshot. Read-only; works while the mouse and keyboard switch is off.",
			annotations: { readOnlyHint: true },
			inputSchema: z.object({
				text: z
					.string()
					.min(1)
					.optional()
					.describe("Case-insensitive text in the label, e.g. Save"),
				role: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Accessibility role, e.g. AXButton, AXLink, AXTextField, AXTextArea, AXCheckBox, " +
							"AXPopUpButton, AXMenuItem, AXStaticText",
					),
				limit: z.number().int().min(1).max(200).optional().describe("Defaults to 30"),
			}),
		},
		async (args) => textResult(await agent.findElements(args)),
	);

	server.registerTool(
		"click",
		{
			description:
				"Glide the real pointer to a point and click it; the recording zooms in on clicks. count 2 " +
				"double-clicks and 3 triple-clicks (selects a line or paragraph in most apps); button right " +
				'opens a context menu; modifiers are held during the click (e.g. ["cmd"] for cmd+click), ' +
				`which needs the recorded window frontmost. ${POINT_HELP} ${INPUT_HELP}`,
			inputSchema: z.object(clickArgs),
		},
		async (args) => perform([{ action: "click", ...args }]),
	);

	server.registerTool(
		"drag",
		{
			description:
				"Drag from (fromX, fromY) to (toX, toY): glide to the start, press, hold, move with easing, " +
				"release (900 ms by default). Use it to move or reorder items, resize panes, draw or select " +
				"a range. Both points must be inside the window. The button is always released, even when " +
				"the user takes over. Modifiers are held for the whole drag and need the recorded window " +
				`frontmost. ${POINT_HELP} ${INPUT_HELP}`,
			inputSchema: z.object(dragArgs),
		},
		async (args) => perform([{ action: "drag", ...args }]),
	);

	server.registerTool(
		"move_pointer",
		{
			description:
				"Glide the real pointer to a point without clicking: hover to reveal menus or tooltips, or " +
				`guide the viewer's eye. ${POINT_HELP} ${INPUT_HELP}`,
			inputSchema: z.object(moveArgs),
		},
		async (args) => perform([{ action: "move", ...args }]),
	);

	server.registerTool(
		"scroll",
		{
			description:
				"Move the pointer to a point and smoothly scroll whatever is under it (the page, a list, a " +
				"panel) by pixels: positive deltaY scrolls down, negative up; deltaX scrolls sideways. " +
				"shift+scroll scrolls sideways in many apps; modifiers need the recorded window frontmost. " +
				"Content moves, so screenshot again before targeting anything it scrolled. " +
				`${POINT_HELP} ${INPUT_HELP}`,
			inputSchema: z.object(scrollArgs),
		},
		async (args) => perform([{ action: "scroll", ...args }]),
	);

	server.registerTool(
		"type_text",
		{
			description:
				"Type text into the focused field of the selected window at a natural typing pace — any " +
				"language, emoji or symbol, whatever the keyboard layout. \\n (or \\r\\n) presses Return and \\t " +
				"presses Tab; nothing else is pressed, so add \\n to submit. Click the field first. Typing goes only " +
				"to the selected window while its app is frontmost. For shortcuts and special keys use " +
				`press_key. ${INPUT_HELP}`,
			inputSchema: z.object(typeArgs),
		},
		async (args) => perform([{ action: "type", ...args }]),
	);

	server.registerTool(
		"press_key",
		{
			description:
				"Press one key or shortcut in the selected window, optionally several times; sent only while " +
				`its app is frontmost. ${KEY_REFERENCE} ${INPUT_HELP}`,
			inputSchema: z.object(keyArgs),
		},
		async (args) => perform([{ action: "key", ...args }]),
	);

	server.registerTool(
		"perform",
		{
			description:
				"Run one scene of the demo: ordered steps executed back to back with exact timing, so the " +
				"video is smoothly paced (separate tool calls leave uneven pauses while you think). Each " +
				"step takes the fields of the matching single tool plus action: move {x, y, durationMs?}, " +
				"click {x, y, button?, count?, modifiers?, durationMs?}, drag {fromX, fromY, toX, toY, " +
				"button?, modifiers?, durationMs?}, scroll {x, y, deltaY, deltaX?, modifiers?}, type " +
				"{text}, key {key, modifiers?, repeat?} (key names as in press_key), wait {ms}. Put 1500–" +
				"3000 ms waits between beats and after anything that loads, so viewers can follow. Limits: " +
				"1–200 steps, waits up to 30000 ms, 10 minutes per call. If a step navigates or opens a " +
				"dialog, end the scene there and screenshot before the next one. If a step fails, the " +
				"earlier steps have already run: screenshot to see the state and continue from there. " +
				`Returns { performed }. ${POINT_HELP} ${INPUT_HELP}`,
			inputSchema: z.object({ steps: z.array(stepSchema).min(1).max(200) }),
		},
		async ({ steps }) => perform(steps),
	);

	return server;
}
