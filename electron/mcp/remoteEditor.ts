import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { type IpcMain, ipcMain, type WebContents } from "electron";
import { getFfmpegBinaryPath } from "../ipc/ffmpeg/binary";

const EDITOR_READY_TIMEOUT_MS = 45_000;
const EDITOR_REPLY_TIMEOUT_MS = 20_000;
const FRAME_TIMEOUT_MS = 30_000;
const MAX_FRAME_WIDTH = 1920;
const END_FRAME_BACKOFF_MS = 40;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const execFileAsync = promisify(execFile);

export type RunFfmpeg = (
	binary: string,
	args: string[],
	opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<Buffer>;

const runFfmpegProcess: RunFfmpeg = async (binary, args, { timeoutMs, signal }) => {
	const { stdout } = await execFileAsync(binary, args, {
		encoding: "buffer",
		timeout: timeoutMs,
		maxBuffer: MAX_FRAME_BYTES,
		signal,
		windowsHide: true,
	});
	return stdout;
};

export type EditorClip = {
	startMs: number;
	endMs: number;
	sourceStartMs?: number;
	speed: number;
};

export type EditorState = {
	videoPath: string;
	durationMs: number;
	sourceDurationMs: number;
	clips: unknown[];
	zooms: unknown[];
	annotations: unknown[];
	audio: unknown[];
	captions: unknown[];
};

export type EditorFrameSource = "edited" | "raw";

type Pending = {
	editor: WebContents;
	settle: (result: RemoteEditorResult) => void;
};

export function timelineToSourceMs(clips: EditorClip[], atMs: number) {
	if (clips.length === 0) return atMs;
	const clip =
		clips.find((item) => atMs >= item.startMs && atMs < item.endMs) ??
		clips.find((item) => item.endMs === atMs && !clips.some((other) => other.endMs > atMs));
	if (!clip) return null;
	const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
	const sourceStart = Number.isFinite(clip.sourceStartMs)
		? (clip.sourceStartMs as number)
		: clip.startMs;
	return sourceStart + (atMs - clip.startMs) * speed;
}

export function frameArgs(videoPath: string, sourceMs: number) {
	return [
		"-hide_banner",
		"-nostats",
		"-loglevel",
		"error",
		"-ss",
		(Math.max(0, sourceMs) / 1000).toFixed(3),
		"-i",
		videoPath,
		"-frames:v",
		"1",
		"-vf",
		`scale='min(${MAX_FRAME_WIDTH},iw)':-2`,
		"-f",
		"image2pipe",
		"-c:v",
		"png",
		"pipe:1",
	];
}

function describeFfmpegError(error: unknown, timeoutMs: number) {
	const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: Buffer | string };
	if (failure.name === "AbortError" || failure.code === "ABORT_ERR") {
		return "The request was canceled.";
	}
	if (failure.code === "ENOENT") return "FFmpeg was not found.";
	if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "The frame was too large.";
	if (failure.killed) return `FFmpeg took longer than ${timeoutMs / 1000} s.`;
	const stderr = failure.stderr?.toString().trim().slice(0, 300);
	return stderr || failure.message;
}

export function createRemoteEditor({
	ipc = ipcMain,
	ffmpegPath = getFfmpegBinaryPath,
	runFfmpeg = runFfmpegProcess,
	readyTimeoutMs = EDITOR_READY_TIMEOUT_MS,
	replyTimeoutMs = EDITOR_REPLY_TIMEOUT_MS,
}: {
	ipc?: Pick<IpcMain, "on">;
	ffmpegPath?: () => string;
	runFfmpeg?: RunFfmpeg;
	readyTimeoutMs?: number;
	replyTimeoutMs?: number;
} = {}) {
	const readyEditors = new Map<WebContents, string>();
	const watchedEditors = new WeakSet<WebContents>();
	const readyCheckers = new Set<() => void>();
	const pending = new Map<string, Pending>();

	function forgetEditor(editor: WebContents) {
		readyEditors.delete(editor);
		for (const [id, request] of [...pending]) {
			if (request.editor === editor) {
				request.settle({
					id,
					ok: false,
					error: "The editor closed or reloaded before it answered.",
				});
			}
		}
	}

	function watchEditor(editor: WebContents) {
		if (watchedEditors.has(editor)) return;
		watchedEditors.add(editor);
		editor.once("destroyed", () => forgetEditor(editor));
		editor.on("render-process-gone", () => forgetEditor(editor));
		editor.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
			if (isMainFrame && !isInPlace) forgetEditor(editor);
		});
	}

	ipc.on("remote-editor-ready", (event, state: RemoteEditorReadyState) => {
		watchEditor(event.sender);
		if (state?.ready && typeof state.videoPath === "string") {
			readyEditors.set(event.sender, path.resolve(state.videoPath));
		} else {
			readyEditors.delete(event.sender);
		}
		for (const check of [...readyCheckers]) check();
	});
	ipc.on("remote-editor-result", (_event, result: RemoteEditorResult) => {
		if (typeof result?.id === "string") pending.get(result.id)?.settle(result);
	});

	function waitForEditor(signal?: AbortSignal) {
		if (signal?.aborted) return Promise.reject(new Error("The request was canceled."));
		return new Promise<WebContents>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				readyCheckers.delete(check);
				signal?.removeEventListener("abort", onAbort);
			};
			const stop = (message: string) => {
				cleanup();
				reject(new Error(message));
			};
			const check = () => {
				for (const editor of [...readyEditors.keys()]) {
					if (editor.isDestroyed() || editor.isCrashed()) readyEditors.delete(editor);
					else {
						cleanup();
						resolve(editor);
						return;
					}
				}
			};
			const onAbort = () => stop("The request was canceled.");
			const timer = setTimeout(
				() =>
					stop(
						`The editor did not finish loading a recording within ${readyTimeoutMs / 1000} s. Is the editor open?`,
					),
				readyTimeoutMs,
			);
			readyCheckers.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	async function requestEditor<T = unknown>(
		op: string,
		payload?: unknown,
		{ signal }: { signal?: AbortSignal } = {},
	): Promise<T> {
		const editor = await waitForEditor(signal);
		if (signal?.aborted) throw new Error("The request was canceled.");
		return new Promise<T>((resolve, reject) => {
			const id = randomUUID();
			const settle = (result: RemoteEditorResult) => {
				if (!pending.delete(id)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (result.ok === true) resolve(result.data as T);
				else reject(new Error(result.error ?? `The editor could not run ${op}.`));
			};
			const onAbort = () => settle({ id, ok: false, error: "The request was canceled." });
			const timer = setTimeout(
				() =>
					settle({
						id,
						ok: false,
						error: `The editor did not answer ${op} within ${replyTimeoutMs / 1000} s.`,
					}),
				replyTimeoutMs,
			);
			signal?.addEventListener("abort", onAbort, { once: true });
			pending.set(id, { editor, settle });
			try {
				editor.send("remote-editor-request", {
					id,
					op,
					payload,
				} satisfies RemoteEditorRequest);
			} catch (error) {
				readyEditors.delete(editor);
				settle({
					id,
					ok: false,
					error: `The editor could not be reached: ${(error as Error).message}`,
				});
			}
		});
	}

	const getState = async (opts?: { signal?: AbortSignal }) => {
		const state = await requestEditor<EditorState>("get_state", undefined, opts);
		const valid =
			state &&
			typeof state.videoPath === "string" &&
			Number.isFinite(state.durationMs) &&
			Number.isFinite(state.sourceDurationMs) &&
			Array.isArray(state.clips);
		if (!valid) {
			throw new Error(
				"There is no recording loaded in the editor, or it returned an unreadable state.",
			);
		}
		return state;
	};

	async function getFrame(
		{ atMs, source = "edited" }: { atMs: number; source?: EditorFrameSource },
		opts: { signal?: AbortSignal } = {},
	): Promise<{ dataUrl: string; atMs: number; source: EditorFrameSource; sourceMs: number }> {
		if (!Number.isFinite(atMs) || atMs < 0) throw new Error("atMs must be 0 or more.");
		if (source !== "edited" && source !== "raw") {
			throw new Error(`source must be "edited" or "raw", not "${source}".`);
		}
		const state = await getState(opts);
		const limit = source === "raw" ? state.sourceDurationMs : state.durationMs;
		if (atMs > limit) {
			throw new Error(
				`atMs ${Math.round(atMs)} is past the end of the ${source} video (${limit} ms).`,
			);
		}
		const sourceMs =
			source === "raw" ? atMs : timelineToSourceMs(state.clips as EditorClip[], atMs);
		if (sourceMs === null) {
			throw new Error(`Nothing plays at ${Math.round(atMs)} ms; it falls in a gap.`);
		}
		// ffmpeg often cannot seek to the very last frame.
		const seekMs = Math.min(
			sourceMs,
			Math.max(0, state.sourceDurationMs - END_FRAME_BACKOFF_MS),
		);
		let binary: string;
		try {
			binary = ffmpegPath();
		} catch (error) {
			throw new Error(
				`Recordly cannot read a frame without FFmpeg. ${(error as Error).message}`,
			);
		}
		const png = await runFfmpeg(binary, frameArgs(state.videoPath, seekMs), {
			timeoutMs: FRAME_TIMEOUT_MS,
			signal: opts.signal,
		}).catch((error) => {
			throw new Error(
				`Recordly could not read that frame: ${describeFfmpegError(error, FRAME_TIMEOUT_MS)}`,
			);
		});
		if (png.length === 0) throw new Error("Recordly could not read that frame: no image.");
		if (!png.subarray(0, 4).equals(PNG_SIGNATURE)) {
			throw new Error("Recordly could not read that frame: FFmpeg did not return an image.");
		}
		return {
			dataUrl: `data:image/png;base64,${png.toString("base64")}`,
			atMs,
			source,
			sourceMs: Math.round(seekMs),
		};
	}

	return { requestEditor, getState, getFrame };
}

export type RemoteEditor = ReturnType<typeof createRemoteEditor>;
