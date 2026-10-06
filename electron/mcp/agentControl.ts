import { app, shell } from "electron";
import { findNativeMacWindow, getWindowBoundsFromNativeSource } from "../ipc/cursor/bounds";
import { selectedSource } from "../ipc/state";
import { type SelectedSource, WINDOW_OFF_SCREEN_MESSAGE, type WindowBounds } from "../ipc/types";
import { getScreen, parseWindowId } from "../ipc/utils";
import { type AgentInput, agentInput } from "./agentInput";
import {
	AGENT_KEY_ALIASES,
	AGENT_KEY_NAMES,
	AGENT_MODIFIER_ALIASES,
	type AgentButton,
	type AgentCommand,
	type AgentEvent,
	type AgentModifier,
	type AgentResults,
	type AgentWindow,
} from "./agentProtocol";
import type { RemoteControl } from "./remoteControl";
import { captureWindow, type WindowShot } from "./screenshot";

export type AgentStep =
	| { action: "move"; x: number; y: number; durationMs?: number }
	| {
			action: "click";
			x: number;
			y: number;
			button?: AgentButton;
			count?: 1 | 2 | 3;
			modifiers?: string[];
			durationMs?: number;
	  }
	| {
			action: "drag";
			fromX: number;
			fromY: number;
			toX: number;
			toY: number;
			button?: AgentButton;
			modifiers?: string[];
			durationMs?: number;
	  }
	| {
			action: "scroll";
			x: number;
			y: number;
			deltaY: number;
			deltaX?: number;
			modifiers?: string[];
	  }
	| { action: "type"; text: string }
	| { action: "key"; key: string; modifiers?: string[]; repeat?: number }
	| { action: "wait"; ms: number };

export const AGENT_LIMITS = { steps: 200, waitMs: 30_000, totalMs: 600_000 };
const MOVE_MS = 700;
const CLICK_MS = 600;
const SCROLL_MS = 600;
const DRAG_MS = 900;
const KEY_REPEAT_MS = 35;
const KEY_REPEAT_MAX = 100;
const TYPE_CPS = 25;
const SETTLE_MS = 250;
const OPEN_URL_WAIT_MS = 5000;
const POLL_MS = 250;
const FIND_LIMIT = 30;

export const TAKEOVER_MESSAGE = "Stopped: the user took over the mouse or keyboard.";
const TAKEOVER_CAUSES: Record<AgentEvent["kind"], string> = {
	move: "the mouse moved",
	button: "a mouse button was pressed",
	scroll: "the mouse or trackpad scrolled",
	key: "a key was pressed",
};
const MAC_ONLY = "Mouse and keyboard control is available on macOS only for now.";
const POST_EVENTS_MISSING =
	"Recordly is not allowed to post mouse and keyboard input. Ask the user to enable Recordly in " +
	"System Settings > Privacy & Security > Accessibility, then quit and reopen Recordly. When " +
	"Recordly runs from `npm run dev`, macOS checks the terminal app's Accessibility permission " +
	"instead: use the installed app, or grant Accessibility to that terminal.";
const NO_WINDOW =
	"Select a window first (open_url, or list_sources then select_source). Mouse and keyboard " +
	"control works on windows, not whole screens.";
const KNOWN_BROWSERS = [
	"com.google.Chrome",
	"com.apple.Safari",
	"org.mozilla.firefox",
	"com.microsoft.edgemac",
	"com.brave.Browser",
	"company.thebrowser.Browser",
	"com.operasoftware.Opera",
	"com.vivaldi.Vivaldi",
	"org.chromium.Chromium",
];
const BROWSER_NOT_FOUND =
	"The page opened, but Recordly could not find the browser window. Call list_sources, then " +
	"select_source.";

type TargetWindow = { pid: number; windowId: number; frame: WindowBounds };
type Post = <C extends AgentCommand>(command: C) => Promise<AgentResults[C["cmd"]]>;

export type AgentControlDeps = {
	input: Pick<AgentInput, "request" | "events">;
	platform: NodeJS.Platform;
	ownPid: number;
	getSelectedSource: () => SelectedSource | null;
	findWindow: (sourceId: string) => Promise<{ pid?: number; frame: WindowBounds | null } | null>;
	capture: (frame: WindowBounds) => Promise<WindowShot>;
	openExternal: (url: string) => Promise<void>;
	getBrowserName: (url: string) => string;
	getDisplays: () => WindowBounds[];
	sleep: (ms: number) => Promise<void>;
};

const defaultDeps = (): AgentControlDeps => ({
	input: agentInput,
	platform: process.platform,
	ownPid: process.pid,
	getSelectedSource: () => selectedSource,
	findWindow: async (sourceId) => {
		const entry = await findNativeMacWindow(sourceId, { maxAgeMs: 250 });
		return entry && { pid: entry.pid, frame: getWindowBoundsFromNativeSource(entry) };
	},
	capture: captureWindow,
	openExternal: (url) => shell.openExternal(url, { activate: true }),
	getBrowserName: (url) => app.getApplicationNameForProtocol(url),
	getDisplays: () =>
		getScreen()
			.getAllDisplays()
			.map((display) => display.bounds),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const normalizeAppName = (name: string) =>
	name
		.replace(/\.app$/i, "")
		.trim()
		.toLowerCase();

const isKnownBrowser = (bundleId: string | null) =>
	bundleId !== null &&
	KNOWN_BROWSERS.some((known) => bundleId === known || bundleId.startsWith(`${known}.`));

const MODIFIERS = new Map(Object.entries(AGENT_MODIFIER_ALIASES));
const KEY_NAMES = new Set<string>(AGENT_KEY_NAMES);
const KEY_ALIASES = new Map<string, string>(Object.entries(AGENT_KEY_ALIASES));
const CONTROL_KEYS = new Map([
	["\n", "enter"],
	["\r", "enter"],
	["\r\n", "enter"],
	["\t", "tab"],
]);

type Segmenter = { segment(text: string): Iterable<unknown> };
const graphemes: Segmenter = new (
	Intl as unknown as { Segmenter: new () => Segmenter }
).Segmenter();

function isOneGrapheme(text: string) {
	const segments = graphemes.segment(text)[Symbol.iterator]();
	return !segments.next().done && segments.next().done === true;
}

export function normalizeModifiers(modifiers: readonly string[] = []): AgentModifier[] {
	const result = new Set<AgentModifier>();
	for (const name of modifiers) {
		const modifier = MODIFIERS.get(String(name).trim().toLowerCase());
		if (!modifier) {
			throw new Error(
				`Unknown modifier "${name}". Use one of: ${[...MODIFIERS.keys()].join(", ")}.`,
			);
		}
		result.add(modifier);
	}
	return [...result];
}

export function normalizeKey(key: string) {
	const raw = String(key);
	const control = CONTROL_KEYS.get(raw);
	if (control) return control;
	if (isOneGrapheme(raw) && !/\p{Cc}/u.test(raw)) return raw;
	const name = raw
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
	if (KEY_NAMES.has(name)) return name;
	const alias = KEY_ALIASES.get(name);
	if (alias) return alias;
	const hint = /.\+./.test(raw)
		? ` Pass modifiers separately, e.g. key "c" with modifiers ["cmd"].`
		: "";
	throw new Error(
		`Unknown key "${key}". Use a key name (enter, tab, escape, backspace, delete, space, up, down, ` +
			"left, right, home, end, pageup, pagedown, f1–f20, keypad0–keypad9, keypadenter, minus, " +
			`slash, …) or one character such as "a", "?" or "é". To enter text, use type_text.${hint}`,
	);
}

function checkStep(step: AgentStep) {
	if ("modifiers" in step) normalizeModifiers(step.modifiers);
	if (step.action === "click" && ![undefined, 1, 2, 3].includes(step.count)) {
		throw new Error("A click's count must be 1, 2 or 3.");
	}
	if (step.action === "key") {
		normalizeKey(step.key);
		const repeat = step.repeat ?? 1;
		if (!Number.isInteger(repeat) || repeat < 1 || repeat > KEY_REPEAT_MAX) {
			throw new Error(`A key's repeat must be a whole number from 1 to ${KEY_REPEAT_MAX}.`);
		}
	}
}

const needsFrontmost = (step: AgentStep) =>
	step.action === "type" ||
	step.action === "key" ||
	("modifiers" in step && (step.modifiers?.length ?? 0) > 0);

function pointsOf(step: AgentStep) {
	switch (step.action) {
		case "move":
		case "click":
		case "scroll":
			return [step];
		case "drag":
			return [
				{ x: step.fromX, y: step.fromY },
				{ x: step.toX, y: step.toY },
			];
		default:
			return [];
	}
}

function stepDurationMs(step: AgentStep) {
	switch (step.action) {
		case "move":
			return step.durationMs ?? MOVE_MS;
		case "click":
			return step.durationMs ?? CLICK_MS;
		case "drag":
			return step.durationMs ?? DRAG_MS;
		case "scroll":
			return SCROLL_MS;
		case "type":
			return (step.text.length / TYPE_CPS) * 1000;
		case "key":
			return (step.repeat ?? 1) * KEY_REPEAT_MS;
		case "wait":
			return step.ms;
	}
}

function checkLimits(steps: AgentStep[]) {
	if (steps.length === 0 || steps.length > AGENT_LIMITS.steps) {
		throw new Error(`perform takes 1 to ${AGENT_LIMITS.steps} steps.`);
	}
	if (steps.some((step) => step.action === "wait" && step.ms > AGENT_LIMITS.waitMs)) {
		throw new Error(`A wait step may last at most ${AGENT_LIMITS.waitMs / 1000} s.`);
	}
	steps.forEach(checkStep);
	const totalMs = steps.reduce((sum, step) => sum + stepDurationMs(step), 0);
	if (totalMs > AGENT_LIMITS.totalMs) {
		throw new Error(
			"A perform call may run at most 10 minutes. Split the demo into shorter scenes.",
		);
	}
}

export function createAgentControl(
	remote: Pick<RemoteControl, "getStatus" | "listSources" | "selectSource">,
	overrides: Partial<AgentControlDeps> = {},
) {
	const deps = { ...defaultDeps(), ...overrides };
	const { input } = deps;
	let busy = false;

	async function exclusive<T>(run: () => Promise<T>) {
		if (busy) throw new Error("Another action is still running.");
		busy = true;
		try {
			return await run();
		} finally {
			busy = false;
		}
	}

	function toGlobal({ frame }: TargetWindow, { x, y }: { x: number; y: number }) {
		if (!(x >= 0 && y >= 0 && x < frame.width && y < frame.height)) {
			throw new Error(
				`Point (${x}, ${y}) is outside the selected window (${Math.round(frame.width)} × ` +
					`${Math.round(frame.height)} points). Use window-relative points from screenshot or find_elements.`,
			);
		}
		const point = { x: frame.x + x, y: frame.y + y };
		const onDisplay = deps
			.getDisplays()
			.some(
				(display) =>
					point.x >= display.x &&
					point.y >= display.y &&
					point.x < display.x + display.width &&
					point.y < display.y + display.height,
			);
		if (!onDisplay) {
			throw new Error(
				`Point (${x}, ${y}) is off screen. Move the window fully onto a display, then try again.`,
			);
		}
		return point;
	}

	function requireMac() {
		if (deps.platform !== "darwin") throw new Error(MAC_ONLY);
	}

	async function requireTarget(): Promise<TargetWindow> {
		const source = deps.getSelectedSource();
		const windowId = parseWindowId(source?.id);
		if (!source?.id || !windowId) throw new Error(NO_WINDOW);
		const found = await deps.findWindow(source.id);
		if (!found?.frame) throw new Error(WINDOW_OFF_SCREEN_MESSAGE);
		const pid = found.pid ?? source.pid;
		if (!pid) {
			throw new Error(
				"Recordly could not tell which app owns the selected window. Call select_source again.",
			);
		}
		if (pid === deps.ownPid) {
			throw new Error("Recordly cannot control its own windows. Select another window.");
		}
		return { pid, windowId, frame: found.frame };
	}

	async function raise(target: TargetWindow) {
		await input.request({
			cmd: "raise",
			pid: target.pid,
			windowId: target.windowId,
			frame: target.frame,
		});
		await deps.sleep(SETTLE_MS);
	}

	async function requireFrontmost(target: TargetWindow) {
		const { window } = await input.request({ cmd: "frontmost_window" });
		if (window?.pid !== target.pid) {
			throw new Error(
				"Typing, keys and modifier clicks go only to the recorded window, and another app is in front of it now.",
			);
		}
	}

	async function runStep(step: AgentStep, start: TargetWindow, post: Post) {
		if (needsFrontmost(step)) await requireFrontmost(start);
		switch (step.action) {
			case "wait":
				return deps.sleep(step.ms);
			case "type":
				return post({ cmd: "type", text: step.text, cps: TYPE_CPS });
			case "key":
				return post({
					cmd: "key",
					key: normalizeKey(step.key),
					modifiers: normalizeModifiers(step.modifiers),
					repeat: step.repeat ?? 1,
				});
		}
		const target = await requireTarget();
		const [point, end] = pointsOf(step).map((each) => toGlobal(target, each));
		switch (step.action) {
			case "move":
				return post({ cmd: "move", ...point, ms: step.durationMs ?? MOVE_MS });
			case "click":
				return post({
					cmd: "click",
					...point,
					ms: step.durationMs ?? CLICK_MS,
					button: step.button ?? "left",
					count: step.count ?? 1,
					modifiers: normalizeModifiers(step.modifiers),
				});
			case "drag":
				return post({
					cmd: "drag",
					fromX: point.x,
					fromY: point.y,
					toX: end.x,
					toY: end.y,
					ms: step.durationMs ?? DRAG_MS,
					button: step.button ?? "left",
					modifiers: normalizeModifiers(step.modifiers),
				});
			case "scroll":
				return post({
					cmd: "scroll",
					...point,
					ms: SCROLL_MS,
					dx: step.deltaX ?? 0,
					dy: step.deltaY,
					modifiers: normalizeModifiers(step.modifiers),
				});
		}
	}

	async function preflightInput() {
		requireMac();
		const { postEvents } = await input.request({ cmd: "preflight" });
		if (!postEvents) throw new Error(POST_EVENTS_MISSING);
	}

	async function runSteps(steps: AgentStep[]) {
		await preflightInput();
		const start = await requireTarget();
		for (const step of steps) for (const point of pointsOf(step)) toGlobal(start, point);
		await raise(start);
		const { window } = await input.request({ cmd: "frontmost_window" });
		if (window?.pid !== start.pid) {
			throw new Error("Recordly couldn't bring the window to the front.");
		}
		let stopped = false;
		let tookOver = false;
		let cause: string | undefined;
		const takeover = () =>
			new Error(
				cause ? `${TAKEOVER_MESSAGE} Recordly noticed that ${cause}.` : TAKEOVER_MESSAGE,
			);
		let abort!: () => void;
		const aborted = new Promise<never>((_, reject) => {
			abort = () => reject(takeover());
		});
		aborted.catch(() => undefined);
		const onUserInput = (event: AgentEvent) => {
			if (!tookOver) cause = event.escape ? "Esc was pressed" : TAKEOVER_CAUSES[event.kind];
			tookOver = true;
			stopped = true;
			abort();
		};
		const post: Post = (command) => {
			if (stopped) return Promise.reject(takeover());
			return input.request(command);
		};
		await input.request({ cmd: "arm" });
		input.events.on("user-input", onUserInput);
		try {
			for (const step of steps) {
				if (stopped) throw takeover();
				await Promise.race([runStep(step, start, post), aborted]);
			}
		} catch (error) {
			if (tookOver || (error instanceof Error && error.message === "user-input")) {
				throw takeover();
			}
			throw error;
		} finally {
			stopped = true;
			input.events.off("user-input", onUserInput);
			await input.request({ cmd: "disarm" }).catch(() => undefined);
		}
		return { performed: steps.length };
	}

	async function perform(steps: AgentStep[]) {
		checkLimits(steps);
		return exclusive(() => runSteps(steps));
	}

	async function findElements({
		text,
		role,
		limit,
	}: {
		text?: string;
		role?: string;
		limit?: number;
	}) {
		requireMac();
		const target = await requireTarget();
		const { elements, truncated } = await input.request({
			cmd: "find",
			pid: target.pid,
			windowId: target.windowId,
			frame: target.frame,
			text,
			role,
			limit: limit ?? FIND_LIMIT,
		});
		return {
			elements: elements.map((element) => ({
				...element,
				x: element.x - target.frame.x,
				y: element.y - target.frame.y,
			})),
			truncated,
		};
	}

	async function screenshot() {
		requireMac();
		const target = await requireTarget();
		await raise(target).catch(() => undefined);
		return deps.capture(target.frame);
	}

	async function selectWindow(windowId: number) {
		const listed = await remote.listSources();
		const match = listed.find((source) => parseWindowId(source.id) === windowId);
		if (!match) throw new Error(BROWSER_NOT_FOUND);
		return remote.selectSource({ id: match.id });
	}

	async function openUrl(url: string) {
		requireMac();
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("Pass a full http(s) URL, e.g. https://example.com.");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`Only http and https URLs can be opened, not ${parsed.protocol}`);
		}
		if (remote.getStatus().state !== "idle") {
			throw new Error(
				"open_url cannot switch windows while recording. Navigate inside the page with perform instead.",
			);
		}
		return exclusive(() => openInBrowser(parsed.href));
	}

	async function openInBrowser(url: string) {
		const browser = normalizeAppName(deps.getBrowserName(url));
		const isBrowser = (window: AgentWindow | null): window is AgentWindow =>
			window !== null &&
			window.pid !== deps.ownPid &&
			(browser
				? normalizeAppName(window.appName) === browser
				: isKnownBrowser(window.bundleId));
		await deps.openExternal(url);
		let candidate: number | null = null;
		for (let waited = 0; waited < OPEN_URL_WAIT_MS; waited += POLL_MS) {
			await deps.sleep(POLL_MS);
			const { window } = await input.request({ cmd: "frontmost_window" });
			if (isBrowser(window) && window.windowId === candidate) {
				return { url, source: await selectWindow(window.windowId) };
			}
			candidate = isBrowser(window) ? window.windowId : null;
		}
		throw new Error(BROWSER_NOT_FOUND);
	}

	return { preflightInput, perform, findElements, screenshot, openUrl };
}

export type AgentControl = ReturnType<typeof createAgentControl>;
