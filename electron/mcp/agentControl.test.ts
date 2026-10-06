import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, shell: {} }));
vi.mock("../ipc/cursor/bounds", () => ({}));
vi.mock("../ipc/state", () => ({}));
vi.mock("../ipc/utils", () => ({
	parseWindowId: (id?: string) => {
		const match = id?.match(/^window:(\d+)/);
		return match ? Number(match[1]) : null;
	},
}));
vi.mock("./agentInput", () => ({ agentInput: {} }));
vi.mock("./screenshot", () => ({ captureWindow: vi.fn() }));

import {
	type AgentControlDeps,
	type AgentStep,
	createAgentControl,
	TAKEOVER_MESSAGE,
} from "./agentControl";
import type { AgentCommand } from "./agentProtocol";

const FRAME = { x: 100, y: 50, width: 800, height: 600 };
const CHROME = {
	pid: 42,
	windowId: 7,
	title: "Docs",
	appName: "Google Chrome",
	bundleId: "com.google.Chrome",
	...FRAME,
};

type Handler = (command: AgentCommand) => unknown;

async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function setup(overrides: Partial<AgentControlDeps> = {}, handlers: Record<string, Handler> = {}) {
	const all: Record<string, Handler> = {
		preflight: () => ({ postEvents: true, accessibility: true }),
		frontmost_window: () => ({ window: CHROME }),
		raise: () => ({ raised: true }),
		...handlers,
	};
	const commands: AgentCommand[] = [];
	const events = new EventEmitter();
	const request = vi.fn(async (command: AgentCommand) => {
		commands.push(command);
		return all[command.cmd]?.(command) ?? {};
	});
	const remote = {
		getStatus: vi.fn(() => ({ state: "idle" })),
		listSources: vi.fn(async () => [
			{ id: "screen:1", name: "Screen 1", type: "screen" },
			{ id: "window:9:0", name: "Google Chrome — Example", type: "window" },
		]),
		selectSource: vi.fn(async ({ id }: { id?: string }) => ({ id, type: "window" })),
	};
	const deps = {
		input: { request, events } as unknown as AgentControlDeps["input"],
		platform: "darwin" as const,
		ownPid: 1,
		getSelectedSource: () => ({ id: "window:7:0", name: "Docs", pid: 42 }),
		findWindow: vi.fn(async () => ({ pid: 42, frame: FRAME })),
		capture: vi.fn(async () => ({
			data: "aGk=",
			mimeType: "image/jpeg" as const,
			width: 800,
			height: 600,
			scale: 1,
			originX: 0,
			originY: 0,
		})),
		openExternal: vi.fn(async () => undefined),
		getBrowserName: () => "Google Chrome.app",
		getDisplays: () => [{ x: 0, y: 0, width: 3000, height: 2000 }],
		sleep: async () => undefined,
		...overrides,
	};
	const agent = createAgentControl(remote as never, deps);
	const names = () => commands.map((command) => command.cmd);
	const count = (cmd: string) => names().filter((name) => name === cmd).length;
	return { agent, deps, remote, events, commands, names, count };
}

describe("perform", () => {
	it("raises the window, then runs window-relative steps as global points between arm and disarm", async () => {
		const { agent, commands } = setup();
		await expect(
			agent.perform([
				{ action: "move", x: 10, y: 20 },
				{ action: "click", x: 5, y: 5, count: 2 },
				{ action: "wait", ms: 100 },
				{ action: "scroll", x: 1, y: 2, deltaY: 300 },
				{ action: "type", text: "hi" },
				{ action: "key", key: "enter" },
			]),
		).resolves.toEqual({ performed: 6 });
		expect(commands).toEqual([
			{ cmd: "preflight" },
			{ cmd: "raise", pid: 42, windowId: 7, frame: FRAME },
			{ cmd: "frontmost_window" },
			{ cmd: "arm" },
			{ cmd: "move", x: 110, y: 70, ms: 700 },
			{ cmd: "click", x: 105, y: 55, ms: 600, button: "left", count: 2, modifiers: [] },
			{ cmd: "scroll", x: 101, y: 52, ms: 600, dx: 0, dy: 300, modifiers: [] },
			{ cmd: "frontmost_window" },
			{ cmd: "type", text: "hi", cps: 25 },
			{ cmd: "frontmost_window" },
			{ cmd: "key", key: "enter", modifiers: [], repeat: 1 },
			{ cmd: "disarm" },
		]);
	});

	it("refuses a point outside the window before raising or posting anything", async () => {
		const { agent, names } = setup();
		await expect(
			agent.perform([
				{ action: "move", x: 10, y: 10 },
				{ action: "click", x: 800, y: 10 },
			]),
		).rejects.toThrow(/outside the selected window/);
		expect(names()).toEqual(["preflight"]);
	});

	it("re-checks fresh bounds on every pointer step", async () => {
		const findWindow = vi
			.fn()
			.mockResolvedValueOnce({ pid: 42, frame: FRAME })
			.mockResolvedValueOnce({ pid: 42, frame: FRAME })
			.mockResolvedValue({ pid: 42, frame: { ...FRAME, width: 100 } });
		const { agent, names, count } = setup({ findWindow });
		await expect(
			agent.perform([
				{ action: "move", x: 10, y: 10 },
				{ action: "move", x: 500, y: 10 },
			]),
		).rejects.toThrow(/outside the selected window/);
		expect(count("move")).toBe(1);
		expect(names().at(-1)).toBe("disarm");
	});

	it.each([
		["type", { action: "type" as const, text: "secret" }],
		["key", { action: "key" as const, key: "enter" }],
	])("refuses %s while another app is frontmost", async (cmd, step) => {
		const { agent, count } = setup(
			{},
			{
				frontmost_window: vi
					.fn()
					.mockReturnValueOnce({ window: CHROME })
					.mockReturnValue({ window: { ...CHROME, pid: 99 } }),
			},
		);
		await expect(agent.perform([step])).rejects.toThrow(/another app is in front/);
		expect(count(cmd)).toBe(0);
		expect(count("arm")).toBe(1);
		expect(count("disarm")).toBe(1);
	});

	it("stops at once when the user takes over mid-sequence, and disarms", async () => {
		const { agent, events, count } = setup({
			sleep: (ms) => (ms === 5000 ? new Promise(() => undefined) : Promise.resolve()),
		});
		const running = agent.perform([
			{ action: "click", x: 10, y: 10 },
			{ action: "wait", ms: 5000 },
			{ action: "click", x: 20, y: 20 },
		]);
		await flush();
		expect(count("click")).toBe(1);
		events.emit("user-input", { event: "user-input", kind: "move", escape: false });
		events.emit("user-input", { event: "user-input", kind: "key", escape: false });
		await expect(running).rejects.toThrow(
			`${TAKEOVER_MESSAGE} Recordly noticed that the mouse moved.`,
		);
		expect(count("click")).toBe(1);
		expect(count("disarm")).toBe(1);
		expect(events.listenerCount("user-input")).toBe(0);
	});

	it("posts nothing when the user takes over while a step is still looking up the window", async () => {
		let release!: (value: unknown) => void;
		const findWindow = vi
			.fn()
			.mockResolvedValueOnce({ pid: 42, frame: FRAME })
			.mockReturnValueOnce(
				new Promise((resolve) => {
					release = resolve;
				}),
			);
		const { agent, events, count } = setup({ findWindow });
		const running = agent.perform([{ action: "click", x: 10, y: 10 }]);
		await flush();
		expect(findWindow).toHaveBeenCalledTimes(2);
		events.emit("user-input", { event: "user-input", kind: "move", escape: false });
		await expect(running).rejects.toThrow(TAKEOVER_MESSAGE);
		release({ pid: 42, frame: FRAME });
		await flush();
		expect(count("click")).toBe(0);
		expect(count("disarm")).toBe(1);
	});

	it("runs one action at a time", async () => {
		const { agent, events } = setup({
			sleep: (ms) => (ms === 5000 ? new Promise(() => undefined) : Promise.resolve()),
		});
		const first = agent.perform([{ action: "wait", ms: 5000 }]);
		await flush();
		await expect(agent.perform([{ action: "wait", ms: 1 }])).rejects.toThrow(
			"Another action is still running.",
		);
		await expect(agent.openUrl("https://example.com")).rejects.toThrow(
			"Another action is still running.",
		);
		events.emit("user-input", { event: "user-input", kind: "key", escape: true });
		await expect(first).rejects.toThrow("Recordly noticed that Esc was pressed.");
		await expect(agent.perform([{ action: "wait", ms: 1 }])).resolves.toEqual({ performed: 1 });
	});

	it("fails before arming when the window did not come to the front", async () => {
		const { agent, count } = setup(
			{},
			{ frontmost_window: () => ({ window: { ...CHROME, pid: 99 } }) },
		);
		await expect(agent.perform([{ action: "wait", ms: 1 }])).rejects.toThrow(
			"Recordly couldn't bring the window to the front.",
		);
		expect(count("arm")).toBe(0);
	});

	it("refuses points that land off every display, and Recordly's own windows", async () => {
		const offDisplay = setup({ getDisplays: () => [{ x: 0, y: 0, width: 500, height: 500 }] });
		await expect(
			offDisplay.agent.perform([{ action: "click", x: 450, y: 10 }]),
		).rejects.toThrow(/off screen/);
		expect(offDisplay.count("raise")).toBe(0);

		const own = setup({ findWindow: async () => ({ pid: 1, frame: FRAME }) });
		await expect(own.agent.perform([{ action: "wait", ms: 1 }])).rejects.toThrow(
			/its own windows/,
		);
		expect(own.count("raise")).toBe(0);
	});

	it("maps a helper user-input error to the takeover message", async () => {
		const { agent, count } = setup(
			{},
			{
				click: () => {
					throw new Error("user-input");
				},
			},
		);
		await expect(agent.perform([{ action: "click", x: 1, y: 1 }])).rejects.toThrow(
			TAKEOVER_MESSAGE,
		);
		expect(count("arm")).toBe(count("disarm"));
	});

	it("keeps arm and disarm balanced when a step or arm itself fails", async () => {
		const failing = setup(
			{},
			{
				move: () => {
					throw new Error("boom");
				},
			},
		);
		await expect(failing.agent.perform([{ action: "move", x: 1, y: 1 }])).rejects.toThrow(
			"boom",
		);
		expect([failing.count("arm"), failing.count("disarm")]).toEqual([1, 1]);

		const noTap = setup(
			{},
			{
				arm: () => {
					throw new Error("tap failed");
				},
			},
		);
		await expect(noTap.agent.perform([{ action: "wait", ms: 1 }])).rejects.toThrow(
			"tap failed",
		);
		expect([noTap.count("arm"), noTap.count("disarm")]).toEqual([1, 0]);
	});

	it.each([
		["too many steps", Array.from({ length: 201 }, () => ({ action: "wait" as const, ms: 1 }))],
		["no steps", []],
		["a wait over 30 s", [{ action: "wait" as const, ms: 30_001 }]],
		[
			"more than 10 minutes",
			Array.from({ length: 21 }, () => ({ action: "wait" as const, ms: 30_000 })),
		],
	])("refuses %s before touching the helper", async (_, steps) => {
		const { agent, commands } = setup();
		await expect(agent.perform(steps)).rejects.toThrow();
		expect(commands).toHaveLength(0);
	});
});

describe("keyboard and mouse details", () => {
	const keyOf = async (step: AgentStep) => {
		const { agent, commands } = setup();
		await agent.perform([step]);
		return commands.find((command) => command.cmd === "key");
	};

	it("normalises modifier aliases case-insensitively and drops duplicates", async () => {
		await expect(
			keyOf({
				action: "key",
				key: "z",
				modifiers: ["Command", "OPTION", " control ", "Shift", "function", "cmd", "meta"],
			}),
		).resolves.toEqual({
			cmd: "key",
			key: "z",
			modifiers: ["cmd", "alt", "ctrl", "shift", "fn"],
			repeat: 1,
		});
	});

	it("refuses an unknown modifier before touching the helper, listing the valid names", async () => {
		const { agent, commands } = setup();
		const outcome = agent.perform([{ action: "click", x: 1, y: 1, modifiers: ["hyper"] }]);
		await expect(outcome).rejects.toThrow(
			/Unknown modifier "hyper"\. Use one of: cmd, command/,
		);
		await expect(
			agent.perform([{ action: "key", key: "a", modifiers: ["constructor"] }]),
		).rejects.toThrow(/Unknown modifier/);
		expect(commands).toHaveLength(0);
	});

	it.each([
		["Return", "enter"],
		["ESC", "escape"],
		["ArrowUp", "up"],
		["Page_Down", "pagedown"],
		["page up", "pageup"],
		["F12", "f12"],
		["F20", "f20"],
		["Forward-Delete", "delete"],
		["Backspace", "backspace"],
		["keypad-enter", "keypadenter"],
		["Backtick", "grave"],
		["\n", "enter"],
		["\r\n", "enter"],
		["\t", "tab"],
		["?", "?"],
		["A", "A"],
		["a", "a"],
		[" ", " "],
		["-", "-"],
		["é", "é"],
		["e\u0301", "e\u0301"],
		["€", "€"],
		["👍🏽", "👍🏽"],
	])("sends key %j as %j", async (key, sent) => {
		await expect(keyOf({ action: "key", key })).resolves.toMatchObject({ key: sent });
	});

	it.each([
		["a word", "hello", /Unknown key "hello".*type_text/],
		["a shortcut string", "cmd+c", /Pass modifiers separately/],
		["an empty key", "", /Unknown key ""/],
		["a control character", "\u0007", /Unknown key/],
		["two characters", "ab", /Unknown key "ab"/],
	])("refuses %s before touching the helper", async (_, key, message) => {
		const { agent, commands } = setup();
		await expect(agent.perform([{ action: "key", key }])).rejects.toThrow(message);
		expect(commands).toHaveLength(0);
	});

	it("passes key repeat through and refuses repeats outside 1 to 100", async () => {
		await expect(keyOf({ action: "key", key: "down", repeat: 100 })).resolves.toMatchObject({
			repeat: 100,
		});
		for (const repeat of [0, 101, 2.5]) {
			const { agent, commands } = setup();
			await expect(agent.perform([{ action: "key", key: "down", repeat }])).rejects.toThrow(
				/repeat must be a whole number from 1 to 100/,
			);
			expect(commands).toHaveLength(0);
		}
	});

	it("sends triple clicks with modifiers and refuses other counts", async () => {
		const { agent, commands } = setup();
		await agent.perform([
			{ action: "click", x: 5, y: 5, count: 3, modifiers: ["Shift"], button: "right" },
		]);
		expect(commands.find((command) => command.cmd === "click")).toEqual({
			cmd: "click",
			x: 105,
			y: 55,
			ms: 600,
			button: "right",
			count: 3,
			modifiers: ["shift"],
		});
		const bad = setup();
		await expect(
			bad.agent.perform([{ action: "click", x: 5, y: 5, count: 4 as 3 }]),
		).rejects.toThrow(/count must be 1, 2 or 3/);
		expect(bad.commands).toHaveLength(0);
	});

	it("drags between two window points as global points", async () => {
		const { agent, commands } = setup();
		await agent.perform([
			{ action: "drag", fromX: 10, fromY: 20, toX: 300, toY: 400, modifiers: ["alt"] },
			{
				action: "drag",
				fromX: 1,
				fromY: 1,
				toX: 2,
				toY: 2,
				durationMs: 50,
				button: "middle",
			},
		]);
		expect(commands.filter((command) => command.cmd === "drag")).toEqual([
			{
				cmd: "drag",
				fromX: 110,
				fromY: 70,
				toX: 400,
				toY: 450,
				ms: 900,
				button: "left",
				modifiers: ["alt"],
			},
			{
				cmd: "drag",
				fromX: 101,
				fromY: 51,
				toX: 102,
				toY: 52,
				ms: 50,
				button: "middle",
				modifiers: [],
			},
		]);
	});

	it.each([
		["the start outside the window", { fromX: -1, fromY: 10, toX: 10, toY: 10 }, /outside/],
		["the end outside the window", { fromX: 10, fromY: 10, toX: 10, toY: 600 }, /outside/],
		["the end off every display", { fromX: 10, fromY: 10, toX: 700, toY: 10 }, /off screen/],
	])("refuses a drag with %s before raising", async (_, points, message) => {
		const { agent, names } = setup({
			getDisplays: () => [{ x: 0, y: 0, width: 600, height: 2000 }],
		});
		await expect(agent.perform([{ action: "drag", ...points }])).rejects.toThrow(message);
		expect(names()).toEqual(["preflight"]);
	});

	it("re-checks both drag endpoints against fresh bounds", async () => {
		const findWindow = vi
			.fn()
			.mockResolvedValueOnce({ pid: 42, frame: FRAME })
			.mockResolvedValue({ pid: 42, frame: { ...FRAME, height: 100 } });
		const { agent, count, names } = setup({ findWindow });
		await expect(
			agent.perform([{ action: "drag", fromX: 10, fromY: 10, toX: 10, toY: 300 }]),
		).rejects.toThrow(/outside the selected window/);
		expect(count("drag")).toBe(0);
		expect(names().at(-1)).toBe("disarm");
	});

	it("stops a drag at once when the user takes over, and disarms so the helper releases", async () => {
		const { agent, events, count, names } = setup(
			{},
			{ drag: () => new Promise(() => undefined) },
		);
		const running = agent.perform([{ action: "drag", fromX: 1, fromY: 1, toX: 50, toY: 50 }]);
		await flush();
		expect(count("drag")).toBe(1);
		events.emit("user-input", { event: "user-input", kind: "move", escape: false });
		await expect(running).rejects.toThrow(TAKEOVER_MESSAGE);
		expect(names().at(-1)).toBe("disarm");
	});

	it("checks the window is in front for modifier clicks, drags and scrolls, but not plain ones", async () => {
		const plain = setup();
		await plain.agent.perform([
			{ action: "click", x: 1, y: 1 },
			{ action: "drag", fromX: 1, fromY: 1, toX: 2, toY: 2, modifiers: [] },
			{ action: "scroll", x: 1, y: 1, deltaY: 10 },
		]);
		expect(plain.count("frontmost_window")).toBe(1);

		for (const step of [
			{ action: "click" as const, x: 1, y: 1, modifiers: ["cmd"] },
			{ action: "drag" as const, fromX: 1, fromY: 1, toX: 2, toY: 2, modifiers: ["alt"] },
			{ action: "scroll" as const, x: 1, y: 1, deltaY: 10, modifiers: ["shift"] },
		]) {
			const behind = setup(
				{},
				{
					frontmost_window: vi
						.fn()
						.mockReturnValueOnce({ window: CHROME })
						.mockReturnValue({ window: { ...CHROME, pid: 99 } }),
				},
			);
			await expect(behind.agent.perform([step])).rejects.toThrow(/another app is in front/);
			expect(behind.count(step.action)).toBe(0);
			expect(behind.count("disarm")).toBe(1);
		}
	});

	it("passes tabs and newlines in typed text to the helper unchanged", async () => {
		const { agent, commands } = setup();
		await agent.perform([{ action: "type", text: "a\tb\r\nc\nd" }]);
		expect(commands.find((command) => command.cmd === "type")).toEqual({
			cmd: "type",
			text: "a\tb\r\nc\nd",
			cps: 25,
		});
	});

	it("budgets drags and key repeats against the 10 minute limit", async () => {
		const { agent, commands } = setup();
		await expect(
			agent.perform(
				Array.from({ length: 21 }, () => ({
					action: "drag" as const,
					fromX: 1,
					fromY: 1,
					toX: 2,
					toY: 2,
					durationMs: 30_000,
				})),
			),
		).rejects.toThrow(/10 minutes/);
		expect(commands).toHaveLength(0);
	});
});

describe("preflight and target checks", () => {
	it("refuses outside macOS and explains missing input permission", async () => {
		await expect(setup({ platform: "win32" }).agent.preflightInput()).rejects.toThrow(
			/macOS only/,
		);
		const denied = setup({}, { preflight: () => ({ postEvents: false, accessibility: true }) });
		await expect(denied.agent.perform([{ action: "wait", ms: 1 }])).rejects.toThrow(
			/npm run dev/,
		);
		expect(denied.count("arm")).toBe(0);
	});

	it("needs a selected window that is on this desktop", async () => {
		const screen = setup({ getSelectedSource: () => ({ id: "screen:1", name: "Screen" }) });
		await expect(screen.agent.findElements({})).rejects.toThrow(/Select a window first/);
		const gone = setup({ findWindow: async () => null });
		await expect(gone.agent.screenshot()).rejects.toThrow(/another desktop/);
	});
});

describe("findElements and screenshot", () => {
	it("passes the window to the helper and returns window-relative frames", async () => {
		const { agent, commands } = setup(
			{},
			{
				find: () => ({
					elements: [
						{ role: "AXButton", label: "Save", x: 150, y: 80, width: 40, height: 20 },
					],
					truncated: false,
				}),
			},
		);
		await expect(agent.findElements({ text: "save" })).resolves.toEqual({
			elements: [{ role: "AXButton", label: "Save", x: 50, y: 30, width: 40, height: 20 }],
			truncated: false,
		});
		expect(commands).toEqual([
			{
				cmd: "find",
				pid: 42,
				windowId: 7,
				frame: FRAME,
				text: "save",
				role: undefined,
				limit: 30,
			},
		]);
	});

	it("raises the window before capturing its frame", async () => {
		const { agent, deps, names } = setup();
		await expect(agent.screenshot()).resolves.toMatchObject({ width: 800, scale: 1 });
		expect(names()).toEqual(["raise"]);
		expect(deps.capture).toHaveBeenCalledWith(FRAME);
	});
});

describe("openUrl", () => {
	it("refuses non-http URLs and refuses while recording", async () => {
		const { agent, deps, remote } = setup();
		await expect(agent.openUrl("file:///etc/passwd")).rejects.toThrow(/http and https/);
		await expect(agent.openUrl("not a url")).rejects.toThrow(/full http/);
		remote.getStatus.mockReturnValue({ state: "recording" });
		await expect(agent.openUrl("https://example.com")).rejects.toThrow(/while recording/);
		expect(deps.openExternal).not.toHaveBeenCalled();
	});

	it("waits for a stable browser window in front and selects it by its listed id", async () => {
		const frontmost = [
			{ ...CHROME, pid: 5, windowId: 3, appName: "Terminal" },
			{ ...CHROME, pid: 1, windowId: 4, appName: "Recordly" },
			{ ...CHROME, windowId: 9 },
			{ ...CHROME, windowId: 9 },
		];
		const { agent, deps, remote } = setup(
			{},
			{ frontmost_window: () => ({ window: frontmost.shift() ?? null }) },
		);
		await expect(agent.openUrl("https://example.com")).resolves.toEqual({
			url: "https://example.com/",
			source: { id: "window:9:0", type: "window" },
		});
		expect(deps.openExternal).toHaveBeenCalledWith("https://example.com/");
		expect(remote.selectSource).toHaveBeenCalledWith({ id: "window:9:0" });
	});

	it("accepts only known browsers when the default browser is unknown", async () => {
		const terminal = {
			...CHROME,
			windowId: 3,
			appName: "Terminal",
			bundleId: "com.apple.Terminal",
		};
		const frontmost = [
			terminal,
			terminal,
			{ ...CHROME, windowId: 9 },
			{ ...CHROME, windowId: 9 },
		];
		const { agent, remote } = setup(
			{ getBrowserName: () => "" },
			{ frontmost_window: () => ({ window: frontmost.shift() ?? null }) },
		);
		await agent.openUrl("https://example.com");
		expect(remote.selectSource).toHaveBeenCalledWith({ id: "window:9:0" });
	});

	it("gives up after about 5 s without a browser window", async () => {
		const { agent, remote } = setup({}, { frontmost_window: () => ({ window: null }) });
		await expect(agent.openUrl("https://example.com")).rejects.toThrow(/could not find/);
		expect(remote.selectSource).not.toHaveBeenCalled();
	});
});
