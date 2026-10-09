import path from "node:path";
import { BrowserWindow } from "electron";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

export type RecordingSummary = {
	path: string;
	name: string;
	sizeBytes: number;
	modifiedAt: string;
};

type Validation = { fileSizeBytes: number; durationSeconds: number | null };

export type RemoteRecordingsWiring = {
	/** Focuses the editor window, creating one when the app has none. */
	openEditorWindow: () => { created: boolean } | Promise<{ created: boolean }>;
	/** Settles only once an editor renderer reports a fully loaded recording. */
	waitForEditorState: (opts?: { signal?: AbortSignal }) => Promise<{ videoPath: string }>;
	isExporting: () => boolean;
};

export type RemoteRecordingsDeps = RemoteRecordingsWiring & {
	list: () => Promise<{ path: string; name: string; bytes: number; createdAt: number }[]>;
	setRemoved: (paths: string[], removed: boolean) => Promise<void>;
	validate: (videoPath: string) => Promise<Validation>;
	/** Returns true only when this was the take still being captured, telemetry and all. */
	activate: (videoPath: string) => Promise<{ usedLiveCapture: boolean }>;
	isCapturing: () => Promise<boolean>;
	currentRecordingPath: () => Promise<string | null>;
};

async function defaultActivate(videoPath: string) {
	const [state, mac, session, manager, utils] = await Promise.all([
		import("../ipc/state"),
		import("../ipc/recording/mac"),
		import("../ipc/project/session"),
		import("../ipc/project/manager"),
		import("../ipc/utils"),
	]);
	// recoverNativeMacCaptureOutput finalizes whatever the capture state points at, with this same
	// precedence, so it may only run when that is this exact file.
	const diagnostics = state.lastNativeCaptureDiagnostics;
	const captureTarget =
		state.nativeCaptureTargetPath ??
		(diagnostics?.backend === "mac-screencapturekit" ? diagnostics.outputPath : null);
	if (
		process.platform === "darwin" &&
		captureTarget &&
		path.resolve(captureTarget) === videoPath
	) {
		const recovered = await mac.recoverNativeMacCaptureOutput();
		if (recovered?.success && recovered.path && path.resolve(recovered.path) === videoPath) {
			return { usedLiveCapture: true };
		}
	}
	const resolved = (await session.resolveRecordingSession(videoPath)) ?? {
		videoPath,
		webcamPath: null,
		timeOffsetMs: 0,
	};
	state.setCurrentVideoPath(videoPath);
	state.setCurrentProjectPath(null);
	utils.approveUserPath(videoPath);
	state.setCurrentRecordingSession(resolved);
	await manager.replaceApprovedSessionLocalReadPaths([resolved.videoPath, resolved.webcamPath]);
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send("recording-session-changed", resolved);
	}
	return { usedLiveCapture: false };
}

const defaultDeps = (): Omit<RemoteRecordingsDeps, keyof RemoteRecordingsWiring> => ({
	list: async () => (await import("../ipc/recording/library")).listRecordings(),
	setRemoved: async (paths, removed) =>
		(await import("../ipc/recording/library")).setRecordingsRemoved(paths, removed),
	validate: async (videoPath) =>
		(await import("../ipc/recording/diagnostics")).validateRecordedVideo(videoPath),
	activate: defaultActivate,
	isCapturing: async () => {
		const state = await import("../ipc/state");
		return (
			state.nativeScreenRecordingActive ||
			state.windowsNativeCaptureActive ||
			state.ffmpegScreenRecordingActive
		);
	},
	currentRecordingPath: async () => {
		const state = await import("../ipc/state");
		return state.currentRecordingSession?.videoPath ?? state.currentVideoPath ?? null;
	},
});

function requireAbsolute(filePath: string, what: string) {
	if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
		throw new Error(`${what} must be an absolute path: ${filePath}`);
	}
	return path.resolve(filePath);
}

export function createRemoteRecordings(
	wiring: RemoteRecordingsWiring,
	overrides: Partial<RemoteRecordingsDeps> = {},
) {
	const deps = { ...defaultDeps(), ...wiring, ...overrides };

	async function recoverRecording(filePath: string) {
		const videoPath = requireAbsolute(filePath, "path");
		if (!VIDEO_EXTENSIONS.has(path.extname(videoPath).toLowerCase())) {
			throw new Error(
				`${path.basename(videoPath)} is not a video Recordly can open (.mp4, .mov, .webm, .mkv or .m4v).`,
			);
		}
		if (await deps.isCapturing()) {
			throw new Error(
				"Recordly is still recording. Call stop_recording first, then recover_recording.",
			);
		}
		if (deps.isExporting()) {
			throw new Error(
				"An export is running. Wait for it to finish before recovering: switching the recording now would pull the video out from under the export.",
			);
		}
		let validation: Validation;
		try {
			validation = await deps.validate(videoPath);
		} catch (error) {
			const message =
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? `There is no file at ${videoPath}.`
					: `Recordly cannot play ${videoPath}: ${(error as Error).message}`;
			throw new Error(message);
		}
		const { usedLiveCapture } = await deps.activate(videoPath);
		return {
			path: videoPath,
			sizeBytes: validation.fileSizeBytes,
			durationSeconds: validation.durationSeconds,
			telemetrySaved: usedLiveCapture,
			note: usedLiveCapture
				? "Recovered the unfinished capture, including its cursor data. An open editor switches to it and drops what it held, unsaved edits included."
				: "It is now the current recording. An open editor switches to it and drops what it held, unsaved edits included, so call project.save first if you need them. It has no new cursor data unless a .cursor.json already sits next to it. If no editor is open, call open_editor; then review_recording or export_video.",
		};
	}

	async function listRecordings(): Promise<{ recordings: RecordingSummary[] }> {
		const entries = await deps.list();
		return {
			recordings: [...entries]
				.sort((a, b) => b.createdAt - a.createdAt)
				.map((entry) => ({
					path: entry.path,
					name: entry.name,
					sizeBytes: entry.bytes,
					modifiedAt: new Date(entry.createdAt).toISOString(),
				})),
		};
	}

	async function newestRecordingPath() {
		const { recordings } = await listRecordings();
		const newest = recordings[0];
		if (!newest) {
			throw new Error(
				"There are no recordings yet, so there is nothing to open. Record one first, or pass open_editor the path to a video.",
			);
		}
		return newest.path;
	}

	async function openEditor({
		path: filePath,
		signal,
	}: {
		path?: string;
		signal?: AbortSignal;
	} = {}) {
		if (filePath !== undefined && typeof filePath !== "string") {
			throw new Error("open_editor: path must be an absolute path to a recording.");
		}
		const current = filePath === undefined ? await deps.currentRecordingPath() : null;
		let recovered: Awaited<ReturnType<typeof recoverRecording>> | null = null;
		let target: string;
		if (current) {
			target = path.resolve(current);
		} else {
			recovered = await recoverRecording(filePath ?? (await newestRecordingPath()));
			target = recovered.path;
		}
		const { created } = await deps.openEditorWindow();
		const opened = {
			path: target,
			windowCreated: created,
			...(recovered ? { recoveredNote: recovered.note } : {}),
		};
		try {
			const state = await deps.waitForEditorState({ signal });
			const showing = path.resolve(state.videoPath);
			return {
				...opened,
				editorReady: true,
				showing,
				note:
					showing === target
						? "The editor is open with this recording loaded, so get_editor_state and the edit tools will answer."
						: `The editor is open and answering, but it is showing ${showing}, not ${target}. Call open_editor again with the path you want.`,
			};
		} catch (error) {
			return {
				...opened,
				editorReady: false,
				note: `Recordly opened the editor window, but the editor never reported a loaded recording: ${(error as Error).message} Only the window is guaranteed. Call get_editor_state again once ${path.basename(target)} has finished loading.`,
			};
		}
	}

	return {
		recoverRecording,
		listRecordings,
		openEditor,

		async deleteRecording(filePath: string) {
			const target = requireAbsolute(filePath, "path");
			await deps.setRemoved([target], true);
			return {
				path: target,
				removed: true,
				note: "Moved to Recordly's trash, not deleted for good. restore_recording brings it back until the next removal or until Recordly quits; after that it is in the system Trash.",
			};
		},

		async restoreRecording(filePath: string) {
			const target = requireAbsolute(filePath, "path");
			await deps.setRemoved([target], false);
			return { path: target, removed: false };
		},
	};
}

export type RemoteRecordings = ReturnType<typeof createRemoteRecordings>;
