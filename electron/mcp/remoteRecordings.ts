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

export type RemoteRecordingsDeps = {
	list: () => Promise<{ path: string; name: string; bytes: number; createdAt: number }[]>;
	setRemoved: (paths: string[], removed: boolean) => Promise<void>;
	validate: (videoPath: string) => Promise<Validation>;
	/** Returns true only when this was the take still being captured, telemetry and all. */
	activate: (videoPath: string) => Promise<{ usedLiveCapture: boolean }>;
	isCapturing: () => Promise<boolean>;
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

const defaultDeps = (): RemoteRecordingsDeps => ({
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
});

function requireAbsolute(filePath: string, what: string) {
	if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
		throw new Error(`${what} must be an absolute path: ${filePath}`);
	}
	return path.resolve(filePath);
}

export function createRemoteRecordings(overrides: Partial<RemoteRecordingsDeps> = {}) {
	const deps = { ...defaultDeps(), ...overrides };

	return {
		async recoverRecording(filePath: string) {
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
					? "Recovered the unfinished capture, including its cursor data."
					: "It is now the current recording. It has no new cursor data unless a .cursor.json already sits next to it. Open the editor, then call review_recording or export_video.",
			};
		},

		async listRecordings(): Promise<{ recordings: RecordingSummary[] }> {
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
		},

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
