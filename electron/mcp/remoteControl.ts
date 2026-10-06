import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain, systemPreferences } from "electron";
import { isCursorCapturePaused } from "../ipc/cursor/telemetry";
import { getSources, selectSource, showRecordingHud } from "../ipc/register/sources";
import { countdownInProgress, currentVideoPath, selectedSource } from "../ipc/state";
import type { SelectedSource } from "../ipc/types";
import { closeCountdownWindow, getHudOverlayWindow } from "../windows";
import { recordingSignals } from "./signals";

export type RemoteRecordingState =
	| "idle"
	| "starting"
	| "countdown"
	| "recording"
	| "paused"
	| "stopping"
	| "finalizing";

export const MAX_COUNTDOWN_SECONDS = 10;
const SAVE_WINDOW_MS = 120_000;
const ACCESSIBILITY_MISSING =
	"Recordly does not have Accessibility permission (needed for cursor tracking). Ask the user " +
	"to enable Recordly in System Settings > Privacy & Security > Accessibility, then quit and " +
	"reopen Recordly.";

type MacPermissions = { screenRecording: string; accessibility: "granted" | "denied" };
type RawSource = {
	id: string;
	name: string;
	sourceType?: "screen" | "window";
	appName?: string;
	[key: string]: unknown;
};
type Listener = (...args: never[]) => void;
type Emitter = {
	on(event: string, listener: Listener): unknown;
	once(event: string, listener: Listener): unknown;
	removeListener(event: string, listener: Listener): unknown;
};
type Contents = Emitter & { send(channel: string, command: RemoteRecordingCommand): void };
type Hud = Emitter & { webContents: Contents; isDestroyed(): boolean };
type IpcListener = (event: { sender: unknown }, ...args: never[]) => void;
type Ipc = {
	on(channel: string, listener: IpcListener): unknown;
};

export type RemoteControlDeps = {
	getPermissions: () => MacPermissions | undefined;
	getSelectedSource: () => SelectedSource | null;
	getLastVideoPath: () => string | null;
	isCountdownActive: () => boolean;
	isCapturePaused: () => boolean;
	getHud: () => Hud | null;
	showHud: () => void;
	cancelCountdown: () => void;
	listSources: () => Promise<RawSource[]>;
	selectSource: (source: SelectedSource) => Promise<unknown>;
	ipc: Ipc;
	signals: typeof recordingSignals;
	createId: () => string;
	timeouts: { hudReadyMs: number; ackMs: number; startMs: number; stopMs: number };
};

function readMacPermissions(): MacPermissions | undefined {
	if (process.platform !== "darwin") return undefined;
	return {
		screenRecording: systemPreferences.getMediaAccessStatus("screen"),
		accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
	};
}

function findEditorWindow() {
	return (
		BrowserWindow.getAllWindows().find(
			(window) =>
				!window.isDestroyed() && window.webContents.getURL().includes("windowType=editor"),
		) ?? null
	);
}

const defaultDeps = (): RemoteControlDeps => ({
	getPermissions: readMacPermissions,
	getSelectedSource: () => selectedSource,
	getLastVideoPath: () => currentVideoPath,
	isCountdownActive: () => countdownInProgress,
	isCapturePaused: () => isCursorCapturePaused(),
	getHud: () => getHudOverlayWindow() as unknown as Hud | null,
	showHud: () => showRecordingHud(findEditorWindow()),
	cancelCountdown: () => closeCountdownWindow(),
	listSources: () =>
		getSources({
			types: ["screen", "window"],
			thumbnailSize: { width: 0, height: 0 },
		}) as Promise<RawSource[]>,
	selectSource: (source) => selectSource(source, { focusApp: false }),
	ipc: ipcMain as unknown as Ipc,
	signals: recordingSignals,
	createId: randomUUID,
	timeouts: { hudReadyMs: 10_000, ackMs: 5_000, startMs: 30_000, stopMs: 120_000 },
});

function summarize(source: RawSource) {
	return {
		id: source.id,
		name: source.name,
		type: source.sourceType ?? (source.id.startsWith("window:") ? "window" : "screen"),
		...(source.appName ? { appName: source.appName } : {}),
	};
}

function onMainFrameNavigation(contents: Contents, listener: () => void) {
	const handler = (_event: unknown, _url: unknown, isInPlace: boolean, isMainFrame: boolean) => {
		if (isMainFrame && !isInPlace) listener();
	};
	contents.on("did-start-navigation", handler);
	return () => contents.removeListener("did-start-navigation", handler);
}

type Pending = {
	id: string;
	action: RemoteRecordingAction;
	hud: Hud;
	done: Promise<string | null>;
	finish: (result: Error | string | null) => void;
};

export function createRemoteControl(overrides: Partial<RemoteControlDeps> = {}) {
	const deps = { ...defaultDeps(), ...overrides };
	let recording = false;
	let recordingHud: Hud | null = null;
	let stoppedAt: number | null = null;
	let closingHud: Hud | null = null;
	let pending: Pending | null = null;
	let hudReady: Promise<Hud> | null = null;
	let onHudReady: (() => void) | null = null;
	const readyContents = new WeakSet<object>();
	const watchedContents = new WeakSet<object>();

	function getState(): RemoteRecordingState {
		if (deps.isCountdownActive()) return "countdown";
		if (pending?.action === "stop") return "stopping";
		if (recording) return deps.isCapturePaused() ? "paused" : "recording";
		if (pending?.action === "start") return "starting";
		if (closingHud && !closingHud.isDestroyed()) return "finalizing";
		return "idle";
	}

	deps.ipc.on("remote-recording-ready", (event) => {
		const contents = event.sender as Contents;
		readyContents.add(contents);
		if (!watchedContents.has(contents)) {
			watchedContents.add(contents);
			const forget = () => readyContents.delete(contents);
			contents.on("destroyed", forget);
			contents.on("render-process-gone", forget);
			onMainFrameNavigation(contents, forget);
		}
		onHudReady?.();
	});

	deps.ipc.on("remote-recording-result", (event, result: RemoteCommandResult) => {
		const current = pending;
		if (!current || result?.id !== current.id || event.sender !== current.hud.webContents)
			return;
		if (!result.ok) {
			current.finish(
				new Error(result.error || `Recordly could not ${current.action} the recording.`),
			);
		} else if (current.action === "start") {
			current.finish(
				new Error("Recording did not start (it was cancelled or blocked in Recordly)."),
			);
		} else if (current.action !== "stop") {
			current.finish(null);
		}
	});

	deps.signals.on("videoPath", (path, sender) => {
		const hud = deps.getHud();
		if (!hud || sender !== hud.webContents) return;
		if (pending?.action === "stop") pending.finish(path);
		if (stoppedAt === null || Date.now() - stoppedAt > SAVE_WINDOW_MS) return;
		stoppedAt = null;
		closingHud = hud;
		hud.once("closed", () => {
			if (closingHud === hud) closingHud = null;
		});
	});

	const onRecordingHudClosed = () => {
		recording = false;
		recordingHud = null;
	};

	function send(
		hud: Hud,
		action: RemoteRecordingAction,
		timeoutMs: number,
		extra: Partial<RemoteRecordingCommand> = {},
	) {
		if (pending)
			throw new Error(`Recordly is still handling "${pending.action}". Try again shortly.`);
		const id = deps.createId();
		let finish!: Pending["finish"];
		const done = new Promise<string | null>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					finish(
						new Error(
							`Recordly did not confirm "${action}" within ${Math.round(timeoutMs / 1000)} s.`,
						),
					),
				timeoutMs,
			);
			const onGone = () =>
				finish(
					new Error(
						`The Recordly recording controls closed before confirming "${action}".`,
					),
				);
			hud.on("closed", onGone);
			hud.webContents.on("render-process-gone", onGone);
			const stopWatchingNavigation = onMainFrameNavigation(hud.webContents, onGone);
			finish = (result) => {
				clearTimeout(timer);
				hud.removeListener("closed", onGone);
				hud.webContents.removeListener("render-process-gone", onGone);
				stopWatchingNavigation();
				if (pending?.id === id) pending = null;
				if (result instanceof Error) reject(result);
				else resolve(result);
			};
		});
		pending = { id, action, hud, done, finish };
		hud.webContents.send("remote-recording-command", {
			...extra,
			id,
			action,
			expiresAt: Date.now() + timeoutMs,
		});
		return done;
	}

	function requireHud() {
		const hud = deps.getHud();
		if (!hud) throw new Error("The Recordly recording controls are not open.");
		return hud;
	}

	function ensureHud() {
		hudReady ??= new Promise<Hud>((resolve, reject) => {
			const timer = setTimeout(() => {
				onHudReady = null;
				reject(new Error("The Recordly recording controls did not become ready in time."));
			}, deps.timeouts.hudReadyMs);
			const check = () => {
				const hud = deps.getHud();
				if (!hud || !readyContents.has(hud.webContents)) return false;
				clearTimeout(timer);
				onHudReady = null;
				resolve(hud);
				return true;
			};
			if (check()) return;
			onHudReady = check;
			if (!deps.getHud()) deps.showHud();
		}).finally(() => {
			hudReady = null;
		});
		return hudReady;
	}

	function preflight() {
		if (!deps.getSelectedSource()) {
			throw new Error(
				"No capture source is selected. Call list_sources, then select_source.",
			);
		}
		const permissions = deps.getPermissions();
		if (permissions && permissions.screenRecording !== "granted") {
			throw new Error(
				"Recordly does not have Screen Recording permission. Ask the user to enable Recordly in " +
					"System Settings > Privacy & Security > Screen Recording, then quit and reopen Recordly.",
			);
		}
		if (permissions && permissions.accessibility !== "granted") {
			throw new Error(ACCESSIBILITY_MISSING);
		}
	}

	function getStatus() {
		const source = deps.getSelectedSource();
		return {
			state: getState(),
			selectedSource: source ? { id: source.id ?? null, name: source.name } : null,
			lastRecordingPath: deps.getLastVideoPath(),
			permissions: deps.getPermissions(),
		};
	}

	return {
		onRecordingStateChange(next: boolean) {
			if (recording && !next) stoppedAt = Date.now();
			if (next) {
				stoppedAt = null;
				const hud = deps.getHud();
				if (hud !== recordingHud) {
					recordingHud?.removeListener("closed", onRecordingHudClosed);
					recordingHud = hud;
					hud?.on("closed", onRecordingHudClosed);
				}
			}
			recording = next;
			if (next && pending?.action === "start") pending.finish(null);
		},
		getStatus,
		async listSources() {
			return (await deps.listSources()).map(summarize);
		},
		async selectSource({ id, name }: { id?: string; name?: string }) {
			const needle = name?.trim().toLowerCase();
			if (name !== undefined && !needle) throw new Error("The name must not be empty.");
			if (!id === !needle) throw new Error("Pass exactly one of id or name.");
			if (getState() !== "idle") throw new Error("The source cannot change while recording.");
			const sources = await deps.listSources();
			let matches = sources.filter((source) =>
				id
					? source.id === id
					: [source.name, source.appName].some((value) =>
							value?.toLowerCase().includes(needle ?? ""),
						),
			);
			const exact = matches.filter((source) => source.name.toLowerCase() === needle);
			if (matches.length > 1 && exact.length === 1) matches = exact;
			if (matches.length === 0) {
				throw new Error(
					`No capture source matches ${id ? `id "${id}"` : `"${name}"`}. Call list_sources to see what is available.`,
				);
			}
			if (matches.length > 1) {
				const candidates = matches
					.map((source) => `${source.name} (id: ${source.id})`)
					.join("; ");
				throw new Error(
					`${matches.length} sources match "${name}": ${candidates}. Use a more specific name or the id.`,
				);
			}
			const { thumbnail: _thumbnail, appIcon: _appIcon, ...source } = matches[0];
			if (
				source.id.startsWith("window:") &&
				deps.getPermissions()?.accessibility === "denied"
			) {
				throw new Error(ACCESSIBILITY_MISSING);
			}
			await deps.selectSource(source);
			return summarize(matches[0]);
		},
		async startRecording({ countdownSeconds }: { countdownSeconds?: number } = {}) {
			const state = getState();
			if (state === "recording" || state === "paused") {
				throw new Error(
					"A recording is already running. Call stop_recording or cancel_recording first.",
				);
			}
			if (state === "starting" || state === "countdown")
				throw new Error("A recording is already starting.");
			if (state === "stopping" || state === "finalizing") {
				throw new Error(
					"The previous recording is still being saved. Try again in a few seconds.",
				);
			}
			preflight();
			const hud = await ensureHud();
			const countdownMs = (countdownSeconds ?? MAX_COUNTDOWN_SECONDS) * 1000;
			await send(
				hud,
				"start",
				deps.timeouts.startMs + countdownMs,
				countdownSeconds === undefined ? {} : { countdownSeconds },
			);
			return getStatus();
		},
		async stopRecording() {
			const state = getState();
			if (state === "countdown") {
				throw new Error(
					"The countdown is still running. Call cancel_recording to abort it.",
				);
			}
			if (state === "stopping") throw new Error("The recording is already stopping.");
			if (state !== "recording" && state !== "paused")
				throw new Error("Recordly is not recording.");
			const videoPath = await send(requireHud(), "stop", deps.timeouts.stopMs);
			return { videoPath };
		},
		async pauseRecording() {
			const state = getState();
			if (state !== "recording") {
				throw new Error(
					state === "paused"
						? "The recording is already paused."
						: "Recordly is not recording.",
				);
			}
			await send(requireHud(), "pause", deps.timeouts.ackMs);
		},
		async resumeRecording() {
			if (getState() !== "paused") throw new Error("The recording is not paused.");
			await send(requireHud(), "resume", deps.timeouts.ackMs);
		},
		async cancelRecording() {
			if (getState() === "countdown") {
				const start = pending?.action === "start" ? pending.done : null;
				deps.cancelCountdown();
				await start?.catch(() => undefined);
				if (!recording) return;
			}
			const state = getState();
			if (state === "starting")
				throw new Error("The recording is still starting. Try again in a moment.");
			if (state !== "recording" && state !== "paused")
				throw new Error("Recordly is not recording.");
			await send(requireHud(), "cancel", deps.timeouts.ackMs);
			stoppedAt = null;
		},
	};
}

export type RemoteControl = ReturnType<typeof createRemoteControl>;
