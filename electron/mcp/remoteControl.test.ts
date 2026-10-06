import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: {}, ipcMain: {}, systemPreferences: {} }));
vi.mock("../ipc/cursor/telemetry", () => ({}));
vi.mock("../ipc/register/sources", () => ({}));
vi.mock("../ipc/state", () => ({}));
vi.mock("../windows", () => ({}));

import type { SelectedSource } from "../ipc/types";
import { createRemoteControl, type RemoteControlDeps } from "./remoteControl";

const SOURCES = [
	{
		id: "screen:1",
		name: "Screen 1 (Primary)",
		sourceType: "screen" as const,
		thumbnail: "data:",
	},
	{ id: "window:1", name: "Docs", appName: "Google Chrome", sourceType: "window" as const },
	{
		id: "window:2",
		name: "Slack",
		appName: "Slack",
		sourceType: "window" as const,
		appIcon: "data:",
	},
	{ id: "window:3", name: "Mail", appName: "Google Chrome", sourceType: "window" as const },
	{
		id: "window:4",
		name: "Google Chrome",
		appName: "Google Chrome",
		sourceType: "window" as const,
	},
];

async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function createHud() {
	const send = vi.fn();
	const webContents = Object.assign(new EventEmitter(), { send });
	return Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false });
}

type FakeHud = ReturnType<typeof createHud>;

function setup(overrides: Partial<RemoteControlDeps> = {}, { ready = true } = {}) {
	const ipc = new EventEmitter();
	const signals = new EventEmitter<{ videoPath: [path: string, sender: unknown] }>();
	const hud = createHud();
	const state = {
		countdown: false,
		paused: false,
		hud: hud as FakeHud | null,
		source: { id: "screen:1", name: "Screen 1" } as SelectedSource | null,
	};
	let nextId = 0;
	const deps = {
		getPermissions: () => ({ screenRecording: "granted", accessibility: "granted" as const }),
		getSelectedSource: () => state.source,
		getLastVideoPath: () => null,
		isCountdownActive: () => state.countdown,
		isCapturePaused: () => state.paused,
		getHud: () => state.hud,
		showHud: vi.fn(),
		cancelCountdown: vi.fn(),
		listSources: async () => SOURCES,
		selectSource: vi.fn(async () => undefined),
		ipc,
		signals,
		createId: () => `cmd-${++nextId}`,
		timeouts: { hudReadyMs: 1000, ackMs: 1000, startMs: 1000, stopMs: 1000 },
		...overrides,
	} satisfies Partial<RemoteControlDeps>;
	const remote = createRemoteControl(deps);
	const markReady = (target: FakeHud = hud) =>
		ipc.emit("remote-recording-ready", { sender: target.webContents });
	if (ready) markReady();
	const commands = () =>
		hud.webContents.send.mock.calls.map(([, command]) => command as RemoteRecordingCommand);
	const lastCommand = () => commands().at(-1);
	const ack = (result: Omit<RemoteCommandResult, "id">, sender: unknown = hud.webContents) =>
		ipc.emit("remote-recording-result", { sender }, { id: lastCommand()?.id, ...result });
	const savePath = (path: string, sender: unknown = hud.webContents) =>
		signals.emit("videoPath", path, sender);
	return { remote, ipc, hud, state, deps, markReady, commands, lastCommand, ack, savePath };
}

async function startRecording(fixture: ReturnType<typeof setup>) {
	const started = fixture.remote.startRecording({ countdownSeconds: 0 });
	await flush();
	fixture.remote.onRecordingStateChange(true);
	await started;
}

afterEach(() => vi.useRealTimers());

describe("start_recording", () => {
	it("refuses without a source or macOS permissions, before touching the HUD", async () => {
		const noSource = setup();
		noSource.state.source = null;
		await expect(noSource.remote.startRecording()).rejects.toThrow(/select_source/);

		const noScreen = setup({
			getPermissions: () => ({ screenRecording: "denied", accessibility: "granted" }),
		});
		await expect(noScreen.remote.startRecording()).rejects.toThrow(/Screen Recording/);

		const noAccessibility = setup({
			getPermissions: () => ({ screenRecording: "granted", accessibility: "denied" }),
		});
		await expect(noAccessibility.remote.startRecording()).rejects.toThrow(/Accessibility/);

		for (const { commands, deps } of [noSource, noScreen, noAccessibility]) {
			expect(commands()).toHaveLength(0);
			expect(deps.showHud).not.toHaveBeenCalled();
		}
	});

	it("resolves once capture runs, carrying the countdown override and an expiry", async () => {
		vi.useFakeTimers({ now: 50_000 });
		const { remote, lastCommand } = setup();
		const started = remote.startRecording({ countdownSeconds: 2 });
		await flush();
		expect(lastCommand()).toEqual({
			id: "cmd-1",
			action: "start",
			countdownSeconds: 2,
			expiresAt: 50_000 + 1000 + 2000,
		});
		expect(remote.getStatus().state).toBe("starting");
		remote.onRecordingStateChange(true);
		await expect(started).resolves.toMatchObject({ state: "recording" });
	});

	it("rejects with the HUD's error ack and ignores acks from other windows", async () => {
		const { remote, ack } = setup();
		const started = remote.startRecording();
		await flush();
		ack({ ok: false, error: "spoofed" }, {});
		ack({ ok: false, error: "Failed to start recording: boom" });
		await expect(started).rejects.toThrow("Failed to start recording: boom");
		expect(remote.getStatus().state).toBe("idle");
	});

	it("treats a start that ends without capture as not started", async () => {
		const { remote, ack } = setup();
		const started = remote.startRecording();
		await flush();
		ack({ ok: true });
		await expect(started).rejects.toThrow(/did not start/);
	});

	it("times out after the countdown plus the start budget", async () => {
		vi.useFakeTimers();
		const { remote } = setup();
		const started = remote.startRecording({ countdownSeconds: 2 });
		const outcome = expect(started).rejects.toThrow(/did not confirm "start"/);
		await vi.advanceTimersByTimeAsync(2999);
		expect(remote.getStatus().state).toBe("starting");
		await vi.advanceTimersByTimeAsync(1);
		await outcome;
		expect(remote.getStatus().state).toBe("idle");
	});

	it("refuses while recording or still starting", async () => {
		const { remote } = setup();
		const started = remote.startRecording();
		await flush();
		await expect(remote.startRecording()).rejects.toThrow(/already starting/);
		remote.onRecordingStateChange(true);
		await started;
		await expect(remote.startRecording()).rejects.toThrow(/already running/);
	});
});

describe("HUD readiness", () => {
	it("opens a HUD once for concurrent starts and waits for its remote listener", async () => {
		const fixture = setup({}, { ready: false });
		const { remote, hud, state, deps, markReady, commands } = fixture;
		state.hud = null;
		const first = remote.startRecording();
		const second = remote.startRecording();
		await flush();
		expect(deps.showHud).toHaveBeenCalledOnce();
		state.hud = hud;
		await flush();
		expect(commands()).toHaveLength(0);
		markReady();
		await expect(second).rejects.toThrow(/still handling "start"/);
		expect(commands()).toHaveLength(1);
		remote.onRecordingStateChange(true);
		await first;
	});

	it("waits for an existing HUD that is still loading, without reopening it", async () => {
		const { remote, deps, markReady, commands } = setup({}, { ready: false });
		const started = remote.startRecording();
		await flush();
		expect(deps.showHud).not.toHaveBeenCalled();
		expect(commands()).toHaveLength(0);
		markReady();
		await flush();
		expect(commands()).toHaveLength(1);
		remote.onRecordingStateChange(true);
		await started;
	});

	it.each([
		[
			"reloads",
			(hud: FakeHud) => hud.webContents.emit("did-start-navigation", {}, "", false, true),
		],
		["crashes", (hud: FakeHud) => hud.webContents.emit("render-process-gone")],
	])("forgets readiness when the HUD %s, then times out", async (_, lose) => {
		vi.useFakeTimers();
		const { remote, hud, commands } = setup();
		hud.webContents.emit("did-start-navigation", {}, "", true, true);
		hud.webContents.emit("did-start-navigation", {}, "", false, false);
		lose(hud);
		const started = remote.startRecording();
		const outcome = expect(started).rejects.toThrow(/did not become ready/);
		await vi.advanceTimersByTimeAsync(1000);
		await outcome;
		expect(commands()).toHaveLength(0);
	});
});

describe("HUD dying mid-command", () => {
	it.each([
		["closes", (hud: FakeHud) => hud.emit("closed")],
		["crashes", (hud: FakeHud) => hud.webContents.emit("render-process-gone")],
		[
			"navigates",
			(hud: FakeHud) => hud.webContents.emit("did-start-navigation", {}, "", false, true),
		],
	])("settles a pending command when the HUD %s", async (_, kill) => {
		const { remote, hud } = setup();
		const started = remote.startRecording();
		await flush();
		kill(hud);
		await expect(started).rejects.toThrow(/closed before confirming "start"/);
		expect(remote.getStatus().state).toBe("idle");
		expect(hud.listenerCount("closed")).toBe(0);
		expect(hud.webContents.listenerCount("render-process-gone")).toBe(1);
	});

	it("drops the recording state when the recording HUD closes, without stacking listeners", async () => {
		const fixture = setup();
		await startRecording(fixture);
		fixture.remote.onRecordingStateChange(true);
		expect(fixture.hud.listenerCount("closed")).toBe(1);
		fixture.hud.emit("closed");
		expect(fixture.remote.getStatus().state).toBe("idle");
	});
});

describe("stop_recording", () => {
	it("reports stopping, returns the path, then blocks a start until the HUD closes", async () => {
		const fixture = setup();
		const { remote, hud, lastCommand, savePath } = fixture;
		await startRecording(fixture);
		const stopped = remote.stopRecording();
		expect(lastCommand()?.action).toBe("stop");
		expect(remote.getStatus().state).toBe("stopping");
		remote.onRecordingStateChange(false);
		expect(remote.getStatus().state).toBe("stopping");
		savePath("/rec/recording-1.mp4");
		await expect(stopped).resolves.toEqual({ videoPath: "/rec/recording-1.mp4" });

		expect(remote.getStatus().state).toBe("finalizing");
		await expect(remote.startRecording()).rejects.toThrow(/still being saved/);
		hud.emit("closed");
		expect(remote.getStatus().state).toBe("idle");
	});

	it("ignores paths reported by other windows", async () => {
		const fixture = setup();
		await startRecording(fixture);
		const stopped = fixture.remote.stopRecording();
		fixture.remote.onRecordingStateChange(false);
		fixture.savePath("/editor/opened.mp4", {});
		expect(fixture.remote.getStatus().state).toBe("stopping");
		fixture.savePath("/rec/recording-2.mp4");
		await expect(stopped).resolves.toEqual({ videoPath: "/rec/recording-2.mp4" });
	});

	it("rejects with a finalize failure ack, and refuses when not recording", async () => {
		const fixture = setup();
		await expect(fixture.remote.stopRecording()).rejects.toThrow(/not recording/);
		await startRecording(fixture);
		const stopped = fixture.remote.stopRecording();
		fixture.ack({ ok: true });
		fixture.ack({ ok: false, error: "The recording captured no video data" });
		await expect(stopped).rejects.toThrow("The recording captured no video data");
	});
});

describe("pause / resume", () => {
	it("resolve only on the HUD ack and refuse in the wrong state", async () => {
		const fixture = setup();
		const { remote, state, ack, lastCommand } = fixture;
		await expect(remote.pauseRecording()).rejects.toThrow(/not recording/);
		await startRecording(fixture);
		await expect(remote.resumeRecording()).rejects.toThrow(/not paused/);

		let settled = false;
		const paused = remote.pauseRecording().then(() => {
			settled = true;
		});
		expect(lastCommand()?.action).toBe("pause");
		await flush();
		expect(settled).toBe(false);
		ack({ ok: true });
		await paused;
		state.paused = true;
		expect(remote.getStatus().state).toBe("paused");
		await expect(remote.pauseRecording()).rejects.toThrow(/already paused/);

		const resumed = remote.resumeRecording();
		expect(lastCommand()?.action).toBe("resume");
		ack({ ok: false, error: "Recordly could not resume the recording." });
		await expect(resumed).rejects.toThrow("could not resume");
	});
});

describe("cancel_recording", () => {
	it("aborts a countdown through cancel-countdown, never the HUD's cancelRecording", async () => {
		const { remote, state, deps, commands, ack } = setup();
		const started = remote.startRecording({ countdownSeconds: 3 });
		const startOutcome = expect(started).rejects.toThrow(/did not start/);
		await flush();
		state.countdown = true;
		const cancelled = remote.cancelRecording();
		expect(deps.cancelCountdown).toHaveBeenCalledOnce();
		state.countdown = false;
		ack({ ok: true });
		await cancelled;
		await startOutcome;
		expect(commands().map((command) => command.action)).toEqual(["start"]);
	});

	it("cancels the capture when the countdown had already finished", async () => {
		const { remote, state, commands, ack } = setup();
		const started = remote.startRecording({ countdownSeconds: 3 });
		await flush();
		state.countdown = true;
		const cancelled = remote.cancelRecording();
		state.countdown = false;
		remote.onRecordingStateChange(true);
		await started;
		await flush();
		expect(commands().map((command) => command.action)).toEqual(["start", "cancel"]);
		ack({ ok: true });
		await cancelled;
	});

	it("sends cancel while recording and does not mark the HUD as closing", async () => {
		const fixture = setup();
		await startRecording(fixture);
		const cancelled = fixture.remote.cancelRecording();
		expect(fixture.lastCommand()?.action).toBe("cancel");
		fixture.remote.onRecordingStateChange(false);
		fixture.ack({ ok: true });
		await cancelled;
		fixture.savePath("/somewhere/opened-later.mp4");
		expect(fixture.remote.getStatus().state).toBe("idle");
	});
});

describe("select_source", () => {
	it("matches a name case-insensitively and strips image data", async () => {
		const { remote, deps } = setup();
		await expect(remote.selectSource({ name: "slack" })).resolves.toEqual({
			id: "window:2",
			name: "Slack",
			type: "window",
			appName: "Slack",
		});
		expect(deps.selectSource).toHaveBeenCalledWith({
			id: "window:2",
			name: "Slack",
			appName: "Slack",
			sourceType: "window",
		});
	});

	it("errors on zero or several matches, listing candidates", async () => {
		const { remote, deps } = setup();
		await expect(remote.selectSource({ name: "Figma" })).rejects.toThrow(/No capture source/);
		const many = remote.selectSource({ name: "o" });
		await expect(many).rejects.toThrow(/sources match/);
		await expect(many).rejects.toThrow(/window:1.*window:3/);
		expect(deps.selectSource).not.toHaveBeenCalled();
	});

	it("prefers a single exact name match among several", async () => {
		const { remote } = setup();
		await expect(remote.selectSource({ name: "google chrome" })).resolves.toMatchObject({
			id: "window:4",
		});
	});

	it("rejects an empty or whitespace-only name", async () => {
		const { remote, deps } = setup();
		await expect(remote.selectSource({ name: "   " })).rejects.toThrow(/must not be empty/);
		await expect(remote.selectSource({ name: "" })).rejects.toThrow(/must not be empty/);
		expect(deps.selectSource).not.toHaveBeenCalled();
	});

	it("refuses a window without Accessibility instead of triggering the macOS prompt", async () => {
		const { remote, deps } = setup({
			getPermissions: () => ({ screenRecording: "granted", accessibility: "denied" }),
		});
		await expect(remote.selectSource({ name: "slack" })).rejects.toThrow(/Accessibility/);
		expect(deps.selectSource).not.toHaveBeenCalled();
		await expect(remote.selectSource({ id: "screen:1" })).resolves.toMatchObject({
			type: "screen",
		});
	});

	it("selects by exact id and lists sources without thumbnails", async () => {
		const { remote } = setup();
		await expect(remote.selectSource({ id: "screen:1" })).resolves.toMatchObject({
			type: "screen",
		});
		const listed = await remote.listSources();
		expect(listed).toHaveLength(SOURCES.length);
		expect(JSON.stringify(listed)).not.toContain("data:");
	});
});
