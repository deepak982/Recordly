import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { AgentControl, AgentStep, PerformOptions } from "./agentControl";
import type { AgentSupport } from "./agentPlatform";
import { AGENT_KEY_ALIASES, AGENT_KEY_NAMES, AGENT_MODIFIER_ALIASES } from "./agentProtocol";
import { MAX_COUNTDOWN_SECONDS, type RemoteControl } from "./remoteControl";
import type { RemoteExport } from "./remoteExport";
import type { RemoteReview } from "./reviewRecording";

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

const INPUT_NOTE =
	"Uses the real mouse and keyboard: Recordly raises the selected window first, and on macOS it must " +
	"stay frontmost and uncovered.";

const INPUT_HELP =
	`${INPUT_NOTE} Errors and what to do: 'the user took over' — the user moved the ` +
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
	"clicks, smooth cursor). On macOS it drives the recorded window with the real mouse and keyboard, " +
	"so a demo of any website or desktop app needs no other browser or input tool.\n\n" +
	"Workflow for any demo:\n" +
	"1. Target: open_url for a web page, or list_sources → select_source for an app. Keep the window " +
	"landscape (at least 1.2 × as wide as tall) so zooms work, and uncovered.\n" +
	"2. Plan while nothing is recorded: learn the screen with find_elements and screenshot, and aim " +
	"with targets {text, role?, index?}, found when each step runs, instead of coordinates. For a " +
	"control with no label, screenshot a region of about 300 × 200 points around it and use origin + " +
	"pixel × scale. perform with dryRun: true checks the current page's targets. Avoid side effects " +
	"while exploring.\n" +
	"3. move_pointer to where the first scene starts, then start_recording.\n" +
	"4. perform per scene or per flow: targets and waitFor let one call cross pages. Leave timing to " +
	"Recordly; it glides naturally and holds each result after a click or Enter. Screenshot when you " +
	"need to check a result. By default the time between calls is cut from the video, so verify " +
	"calmly. Give perform a title only when the user wants captions.\n" +
	"5. stop_recording, review_recording to check the contact sheet, then export_video.\n\n" +
	"Coordinates are window-relative points; (0,0) is the window's top-left.\n\n" +
	"Errors: 'the user took over' → stop and ask the user. 'Mouse and keyboard control is off' → ask " +
	`the user to turn on ${CONTROL_SWITCH}. Missing permission → ask the user to grant it in System ` +
	"Settings and reopen Recordly. Window closed, covered or on another desktop → list_sources, " +
	"select_source, screenshot. A failed step ('Step n') leaves the earlier steps done: screenshot and " +
	"continue, or cancel_recording and start over. Never retry blindly; act only inside the selected " +
	"window.";

const LINUX_ACCESSIBILITY =
	"Browsers and Electron apps list their controls only when started with ACCESSIBILITY_ENABLED=1; " +
	"otherwise aim with region screenshots.";

function controlInstructions(platform: NodeJS.Platform) {
	if (platform === "darwin") return MAC_INSTRUCTIONS;
	const linux = platform === "linux";
	const text = MAC_INSTRUCTIONS.replace(
		"On macOS it drives the recorded window",
		linux
			? "On Linux it records the whole screen and drives the window you choose"
			: "On Windows it drives the recorded window",
	)
		.replace(
			"Missing permission → ask the user to grant it in System Settings and reopen Recordly. ",
			"",
		)
		.replace(
			"Coordinates are window-relative points; (0,0) is the window's top-left.",
			`Coordinates are window-relative points; (0,0) is the window's top-left. Shortcuts use ctrl (cmd is the ${linux ? "Super" : "Windows"} key).`,
		);
	return linux
		? text
				.replace(
					"or list_sources → select_source for an app. Keep the window " +
						"landscape (at least 1.2 × as wide as tall) so zooms work, and uncovered.",
					"or list_sources → select_source with an app window's id. Keep it uncovered.",
				)
				.replace("\n\nErrors:", ` ${LINUX_ACCESSIBILITY}\n\nErrors:`)
		: text;
}

const INSTRUCTIONS =
	"Recordly records the screen and turns recordings into polished demo videos (automatic zoom on " +
	"clicks, smooth cursor). It cannot move the mouse or type on this platform, so the user (or another " +
	"tool) performs the demo. Flow for any demo: list_sources → select_source → agree the steps with the " +
	"user → start_recording → the user performs the demo → stop_recording (returns the saved video path " +
	"and opens the editor) → review_recording → export_video. On Linux with Wayland, the user must pick the screen in the " +
	"system share dialog after start_recording. Call get_status at any time. Tools refuse with a clear " +
	"message instead of showing dialogs; relay permission errors to the user.";

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const coordinate = (description: string) => z.number().min(0).describe(description);
const target = (description: string) =>
	z
		.object({
			text: z
				.string()
				.trim()
				.min(1)
				.max(200)
				.describe("Part of the element's label or text, any case"),
			role: z
				.string()
				.min(1)
				.max(40)
				.optional()
				.describe("Kind of element, e.g. button, link, textfield, checkbox, tab, menuitem"),
			index: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Which match, 0-based, top to bottom, when several are visible"),
		})
		.optional()
		.describe(description);
const TARGET_HELP =
	"An element found on screen when the step runs, instead of x and y; scrolled into view if needed";
const point = {
	x: coordinate("Window-relative x in points (0 = the window's left edge)").optional(),
	y: coordinate("Window-relative y in points (0 = the window's top edge)").optional(),
	target: target(TARGET_HELP),
};
const durationMs = (description: string) =>
	z.number().int().min(0).max(10_000).optional().describe(description);
const glideMs = durationMs(
	"How long the pointer glides there, in ms; leave it out to let Recordly pace it by distance",
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
	fromX: coordinate("Window-relative x where the button goes down").optional(),
	fromY: coordinate("Window-relative y where the button goes down").optional(),
	from: target("Element where the button goes down, instead of fromX and fromY"),
	toX: coordinate("Window-relative x where the button is released").optional(),
	toY: coordinate("Window-relative y where the button is released").optional(),
	to: target("Element where the button is released, instead of toX and toY"),
	button,
	modifiers,
	durationMs: durationMs("How long the drag takes, in ms; leave it out to pace it by distance"),
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
	into: target("Field to click into before typing"),
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

const waitForArgs = {
	text: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.optional()
		.describe("Wait until an element with this text is on screen"),
	role: z.string().trim().min(1).max(40).optional().describe("Kind of element to wait for"),
	gone: z.boolean().optional().describe("Wait until the element disappears instead"),
	settled: z
		.boolean()
		.optional()
		.describe("Wait until nothing on screen changes (instead of text or role)"),
	timeoutMs: z
		.number()
		.int()
		.positive()
		.max(30_000)
		.optional()
		.describe("Give up after this long (default 10000); settled carries on instead of failing"),
};

const WAIT_FOR_RULE =
	"Wait for an element (text and/or role, optionally gone: true) or for settled: true, not both";
const waitForValid = (value: { text?: string; role?: string; gone?: boolean; settled?: boolean }) =>
	(value.text !== undefined || value.role !== undefined) !== (value.settled === true) &&
	!(value.settled === true && value.gone === true);

type PointFields = { x?: number; y?: number; target?: unknown };
const onePoint = (
	value: PointFields,
	x: keyof PointFields,
	y: keyof PointFields,
	t: keyof PointFields,
) =>
	(value[x] !== undefined && value[y] !== undefined) !== (value[t] !== undefined) &&
	(value[x] === undefined) === (value[y] === undefined);
const POINT_OR_TARGET = "Give either x and y or a target, not both";
const DRAG_RULE = "Give each end of the drag as coordinates or a target, not both";
const dragEndsValid = (value: {
	fromX?: number;
	fromY?: number;
	from?: unknown;
	toX?: number;
	toY?: number;
	to?: unknown;
}) =>
	onePoint({ x: value.fromX, y: value.fromY, target: value.from }, "x", "y", "target") &&
	onePoint({ x: value.toX, y: value.toY, target: value.to }, "x", "y", "target");
const pointStep = <A extends string, T extends z.ZodRawShape>(action: A, args: T) =>
	z
		.object({ action: z.literal(action), ...args })
		.refine((value) => onePoint(value as PointFields, "x", "y", "target"), POINT_OR_TARGET);

const stepSchema = z.discriminatedUnion("action", [
	pointStep("move", moveArgs),
	pointStep("click", clickArgs),
	z.object({ action: z.literal("drag"), ...dragArgs }).refine(dragEndsValid, DRAG_RULE),
	pointStep("scroll", scrollArgs),
	z.object({ action: z.literal("type"), ...typeArgs }),
	z.object({ action: z.literal("key"), ...keyArgs }),
	z.object({
		action: z.literal("wait"),
		ms: z.number().int().min(0).max(30_000).describe("Pause in ms (at most 30000)"),
	}),
	z.object({ action: z.literal("waitFor"), ...waitForArgs }).refine(waitForValid, WAIT_FOR_RULE),
]);

type DemoArgs = { goal: string; url?: string; app?: string; output_path?: string };

function demoPrompt(
	platform: NodeJS.Platform,
	control: boolean,
	{ goal, url, app, output_path }: DemoArgs,
) {
	const exportStep = `Call stop_recording, then review_recording to check the contact sheet, then export_video${output_path ? ` with outputPath "${output_path}"` : ""}.`;
	const linux = platform === "linux";
	if (control) {
		const target = url
			? `Call open_url with ${url}.`
			: app
				? linux
					? `Call list_sources and select_source with the id of ${app}'s window; Recordly records the whole screen and drives that window.`
					: `Call list_sources and select_source for ${app} (by id if it has several windows).`
				: "Pick what the goal needs: open_url for a web page, or list_sources then select_source " +
					`${linux ? "with an app window's id" : "for an app"}. Ask the user if it is unclear.`;
		const keep = linux
			? "Make sure nothing covers it."
			: "Make sure the window is landscape (at least 1.2 × as wide as tall, so automatic zooms " +
				"work) and nothing covers it.";
		return [
			`Record a demo video with Recordly that shows: ${goal}`,
			"",
			`1. Target. ${target} ${keep}`,
			"2. Plan before recording. Learn the screen with find_elements and screenshot, then write a " +
				"short list of scenes: what the viewer should see, and the steps. Aim with targets {text, " +
				"role?, index?} found when each step runs, not coordinates; for a control with no label, " +
				"screenshot a region of about 300 × 200 points around it and use origin + pixel × scale. " +
				"Check the first scene with perform dryRun: true. Avoid side effects such as submitting or " +
				"deleting while exploring.",
			"3. Call move_pointer to where the first scene starts, then start_recording.",
			"4. Call perform per scene, or once for a whole flow: targets and waitFor let it cross pages. " +
				"Leave out durations and waits; Recordly paces the motion and holds each result after a " +
				"click or Enter. Screenshot between calls when you need to check the result; the time " +
				"between calls is cut by default. Add a perform title only if the user asked for captions " +
				"or a step-by-step tutorial.",
			`5. ${exportStep}`,
			"6. Tell the user the saved path and what the video shows.",
			"",
			"If a tool says the user took over, stop and ask the user. If a step fails, screenshot, recover " +
				"as the error says and redo the scene; if the take is ruined, cancel_recording and start " +
				"over. Act only inside the selected window.",
			...(platform === "darwin" ? [] : ["Use ctrl, not cmd, for shortcuts."]),
			...(linux ? [LINUX_ACCESSIBILITY] : []),
		].join("\n");
	}
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
		support,
		review,
	}: {
		agent: AgentControl;
		isControlEnabled: () => boolean;
		platform?: NodeJS.Platform;
		support: AgentSupport;
		review: RemoteReview;
	},
) {
	const mac = platform === "darwin";
	const control = support.supported;
	const linuxControl = control && platform === "linux";
	const server = new McpServer(
		{ name: "recordly", version },
		{ instructions: control ? controlInstructions(platform) : INSTRUCTIONS },
	);

	async function perform(steps: AgentStep[], options?: PerformOptions) {
		if (!isControlEnabled()) throw new Error(CONTROL_OFF);
		return textResult(await agent.perform(steps, options));
	}

	server.registerPrompt(
		"record_demo",
		{
			title: "Record a demo",
			description:
				"Step-by-step plan for recording a demo video of any website or app and exporting it" +
				(control
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
					content: { type: "text" as const, text: demoPrompt(platform, control, args) },
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
					: linuxControl
						? " A window id (window:N:0 from list_sources, or N) chooses the window the mouse and " +
							"keyboard tools act on; Recordly keeps recording the whole screen."
						: control
							? " The mouse and keyboard tools act on this window only."
							: ""),
			inputSchema: z.object({
				id: z.string().min(1).optional().describe("Exact source id from list_sources"),
				name: z.string().min(1).optional().describe("Name substring of the window or app"),
			}),
		},
		async (args) =>
			textResult(
				linuxControl && args.id && /^(window:)?\d+/.test(args.id)
					? await agent.chooseWindow(args.id)
					: await remote.selectSource(args),
			),
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

	server.registerTool(
		"review_recording",
		{
			description:
				"Check the edited video before export_video, after stop_recording, while the editor shows " +
				"the latest recording. Returns a contact sheet (up to 9 tiles, left to right, top to " +
				"bottom: the start, the last frame before each cut, the end) and a summary: each tile's " +
				"time and label, raw and final duration, time removed, cuts, zooms, captions, scenes, " +
				"failed scenes and the longest still stretch left. If a tile shows something wrong (an error, the wrong page, a covered window), tell " +
				"the user and offer to record that part again; otherwise call export_video.",
			inputSchema: z.object({}),
		},
		async (_args, ctx) => {
			const { image, summary } = await review.reviewRecording({ signal: ctx.mcpReq.signal });
			return {
				content: [
					{ type: "image" as const, data: image.data, mimeType: image.mimeType },
					{ type: "text" as const, text: JSON.stringify(summary, null, 2) },
				],
			};
		},
	);

	if (!control) return server;

	server.registerTool(
		"open_url",
		{
			description:
				"Open an http(s) URL in the user's default browser (their own signed-in profile), wait for " +
				"its window and select it as the capture source, ready for screenshot. Use it to start any " +
				"web demo. Refused while recording: navigate inside the page with perform instead (click a " +
				`link, or ${mac ? "cmd" : "ctrl"}+l, type the address, enter). Needs ` +
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
				`Find controls in the selected window through ${mac ? "macOS Accessibility" : platform === "win32" ? "UI Automation" : "AT-SPI"}: buttons, links, text ` +
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
			inputSchema: z
				.object(clickArgs)
				.refine((value) => onePoint(value, "x", "y", "target"), POINT_OR_TARGET),
		},
		async (args) => perform([{ action: "click", ...args }]),
	);

	server.registerTool(
		"drag",
		{
			description:
				"Drag from (fromX, fromY) or a from target to (toX, toY) or a to target: glide to the start, " +
				"press, hold, move with easing, release, paced by distance. Use it to move or reorder " +
				"items, resize panes, draw or select a range. Both points must be inside the window. The button is always released, even when " +
				"the user takes over. Modifiers are held for the whole drag and need the recorded window " +
				`frontmost. ${POINT_HELP} ${INPUT_HELP}`,
			inputSchema: z.object(dragArgs).refine(dragEndsValid, DRAG_RULE),
		},
		async (args) => perform([{ action: "drag", ...args }]),
	);

	server.registerTool(
		"move_pointer",
		{
			description:
				"Glide the real pointer to a point without clicking: hover to reveal menus or tooltips, or " +
				`guide the viewer's eye. ${POINT_HELP} ${INPUT_HELP}`,
			inputSchema: z
				.object(moveArgs)
				.refine((value) => onePoint(value, "x", "y", "target"), POINT_OR_TARGET),
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
			inputSchema: z
				.object(scrollArgs)
				.refine((value) => onePoint(value, "x", "y", "target"), POINT_OR_TARGET),
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
				`its app is frontmost. ${KEY_REFERENCE} ${INPUT_NOTE} Errors are explained in click's ` +
				"description; 'the user took over' means stop and ask the user.",
			inputSchema: z.object(keyArgs),
		},
		async (args) => perform([{ action: "key", ...args }]),
	);

	server.registerTool(
		"wait_for",
		{
			description:
				"Wait in the selected window until an element appears (text and/or role), disappears " +
				"(gone: true) or the screen stops changing (settled: true). Use after open_url or anything " +
				"slow, before planning the next targets. Element waits fail at timeoutMs (default 10000); " +
				`settled carries on. Logged as waiting, which Recordly shortens in the video. ${INPUT_NOTE}`,
			inputSchema: z.object(waitForArgs).refine(waitForValid, WAIT_FOR_RULE),
		},
		async (args) => perform([{ action: "waitFor", ...args }]),
	);

	server.registerTool(
		"perform",
		{
			description:
				"Run one scene or a whole flow: steps executed back to back with exact timing (separate " +
				"calls split a scene into many cuts). Steps take the matching tool's fields plus action: " +
				"move {x, y | target}, click {x, y | target, button?, count?, modifiers?}, drag {fromX, " +
				"fromY | from, toX, toY | to}, scroll {x, y | target, deltaY, deltaX?}, type {text, into?}, " +
				"key {key, modifiers?, repeat?}, wait {ms}, waitFor {text?, role?, gone?, settled?, " +
				"timeoutMs?}. A target {text, role?, index?} is found on screen when its step runs (waiting " +
				"up to 5 s, scrolling it into view), so one perform can cross pages; prefer it to " +
				"coordinates. Leave out durationMs and waits: Recordly glides at a natural speed and, after " +
				"a click or Enter, waits for the screen to settle and holds the result for reading; pace " +
				"(brisk, normal, relaxed) scales that. A wait or waitFor right after one replaces that hold: " +
				"use wait only for longer reading and waitFor only for slow content. dryRun checks the " +
				"current page's targets without acting and returns dryRun: [{index (1-based, as in 'Step " +
				"n'), found, …}]; then: 'elements' returns the visible controls afterwards. title becomes an " +
				"on-screen caption: set it only when the user wants captions. Limits: 1–200 steps, waits " +
				"up to 30000 ms, 10 minutes per call. A failure says 'Step n (action)': the earlier steps " +
				"have run, so screenshot and continue from there. Returns " +
				`{ performed, durationMs }. ${POINT_HELP} ${INPUT_NOTE} 'the user took over' means stop and ` +
				"ask the user; other errors are explained in click's description.",
			inputSchema: z.object({
				steps: z.array(stepSchema).min(1).max(200),
				title: z
					.string()
					.trim()
					.min(1)
					.max(80)
					.optional()
					.describe("Scene caption, only when the user asks for captions or a tutorial"),
				pace: z
					.enum(["brisk", "normal", "relaxed"])
					.optional()
					.describe(
						"How fast Recordly glides and how long it holds results; defaults to normal",
					),
				dryRun: z
					.boolean()
					.optional()
					.describe("Only check that the current page's targets can be found; no input"),
				then: z
					.literal("elements")
					.optional()
					.describe("Also return the visible controls after the last step"),
			}),
		},
		async ({ steps, ...options }) =>
			perform(
				steps,
				Object.values(options).some((value) => value !== undefined) ? options : undefined,
			),
	);

	return server;
}
