import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type IpcMain, ipcMain, type WebContents } from "electron";
import { getRecordingsDir } from "../ipc/utils";

const EDITOR_READY_TIMEOUT_MS = 45_000;
const EXPORT_WAIT_CAP_MS = 5 * 60_000;

type ExportFormat = RemoteExportRequest["format"];

export type RemoteExportArgs = {
	videoPath: string | null;
	outputPath?: string;
	format?: ExportFormat;
	quality?: RemoteExportRequest["quality"];
	overwrite?: boolean;
};

export type RemoteExportStatus = {
	state: "idle" | "waiting-for-editor" | "exporting" | "done" | "failed";
	progress: number | null;
	outputPath: string | null;
	error: string | null;
};

type ActiveExport = {
	id: string;
	editor: WebContents;
	onProgress?: (pct: number) => void;
	settle: (result: RemoteExportResult) => void;
};

const fileExists = (filePath: string) =>
	fs.stat(filePath, { bigint: true }).then(
		(stats) => stats,
		() => null,
	);

type FileIdentity = { dev: bigint; ino: bigint };

export function isSameFile(
	first: string,
	firstStats: FileIdentity,
	second: string,
	secondStats: FileIdentity,
	platform: NodeJS.Platform = process.platform,
) {
	const normalize = (filePath: string) =>
		platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
	if (normalize(first) === normalize(second)) return true;
	return (
		firstStats.ino !== 0n &&
		firstStats.dev === secondStats.dev &&
		firstStats.ino === secondStats.ino
	);
}

async function resolveTarget(args: RemoteExportArgs, recordingsDir: () => Promise<string>) {
	if (!args.videoPath) throw new Error("There is no recording to export yet.");
	const videoPath = path.resolve(args.videoPath);
	const requested = args.outputPath;
	if (requested !== undefined && !requested.trim()) throw new Error("outputPath is empty.");
	if (requested && !path.isAbsolute(requested)) {
		throw new Error(`outputPath must be an absolute path: ${requested}`);
	}
	const format: ExportFormat =
		args.format ?? (requested?.toLowerCase().endsWith(".gif") ? "gif" : "mp4");
	const outputPath = requested
		? path.resolve(requested)
		: path.join(await recordingsDir(), `${path.parse(videoPath).name}-export.${format}`);
	if (path.extname(outputPath).toLowerCase() !== `.${format}`) {
		throw new Error(`outputPath must end in .${format} for a ${format} export.`);
	}
	const folder = path.dirname(outputPath);
	if (!(await fileExists(folder))?.isDirectory()) {
		throw new Error(`The folder does not exist: ${folder}`);
	}
	await fs.access(folder, constants.W_OK).catch(() => {
		throw new Error(`Recordly cannot write to the folder: ${folder}`);
	});
	const [existing, recording] = await Promise.all([
		fileExists(outputPath),
		fileExists(videoPath),
	]);
	if (existing && recording && isSameFile(outputPath, existing, videoPath, recording)) {
		throw new Error("outputPath cannot be the recording itself.");
	}
	if (existing && !existing.isFile()) throw new Error(`${outputPath} is not a regular file.`);
	if (existing && !args.overwrite) {
		throw new Error(`${outputPath} already exists. Pass overwrite: true to replace it.`);
	}
	return { videoPath, outputPath, format };
}

export function createRemoteExport({
	ipc = ipcMain,
	recordingsDir = getRecordingsDir,
}: {
	ipc?: Pick<IpcMain, "on">;
	recordingsDir?: () => Promise<string>;
} = {}) {
	const readyEditors = new Map<WebContents, string>();
	const watchedEditors = new WeakSet<WebContents>();
	const readyCheckers = new Set<() => void>();
	let status: RemoteExportStatus = {
		state: "idle",
		progress: null,
		outputPath: null,
		error: null,
	};
	let busy = false;
	let active: ActiveExport | null = null;

	function forgetEditor(editor: WebContents) {
		readyEditors.delete(editor);
		if (active?.editor === editor) {
			active.settle({
				id: active.id,
				ok: false,
				error: "The editor closed or reloaded during the export.",
			});
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
	ipc.on("remote-export-progress", (_event, update: RemoteExportProgress) => {
		if (!active || update?.id !== active.id || !Number.isFinite(update.progress)) return;
		const pct = Math.round(Math.min(100, Math.max(0, update.progress)));
		if (pct <= (status.progress ?? -1)) return;
		status = { ...status, progress: pct };
		active.onProgress?.(pct);
	});
	ipc.on("remote-export-result", (_event, result: RemoteExportResult) => {
		if (active && result?.id === active.id) active.settle(result);
	});

	function fail(message: string) {
		status = { ...status, state: "failed", error: message };
		busy = false;
	}

	function waitForEditor(videoPath: string, signal?: AbortSignal) {
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
				for (const [editor, readyPath] of readyEditors) {
					if (editor.isDestroyed() || editor.isCrashed()) readyEditors.delete(editor);
					else if (readyPath === videoPath) {
						cleanup();
						resolve(editor);
						return;
					}
				}
			};
			const onAbort = () => stop("The export was canceled.");
			const timer = setTimeout(
				() =>
					stop(
						`The editor did not finish loading ${videoPath} within ${EDITOR_READY_TIMEOUT_MS / 1000} s. Is the editor open?`,
					),
				EDITOR_READY_TIMEOUT_MS,
			);
			readyCheckers.add(check);
			signal?.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	function runInEditor(
		editor: WebContents,
		request: RemoteExportRequest,
		onProgress?: (pct: number) => void,
	) {
		return new Promise<RemoteExportResult>((resolve) => {
			const settle = (result: RemoteExportResult) => {
				if (active?.id !== request.id) return;
				active = null;
				if (result.ok) {
					status = {
						state: "done",
						progress: 100,
						outputPath: result.path ?? request.outputPath,
						error: null,
					};
					busy = false;
				} else {
					fail(result.error ?? "The export failed.");
				}
				resolve(result);
			};
			active = { id: request.id, editor, onProgress, settle };
			try {
				editor.send("remote-export-request", request);
			} catch {
				forgetEditor(editor);
			}
		});
	}

	async function exportVideo(
		args: RemoteExportArgs,
		opts: { onProgress?: (pct: number) => void; signal?: AbortSignal } = {},
	): Promise<{ status: "done"; path: string } | { status: "still-exporting" }> {
		if (busy) throw new Error("An export is already running. get_status shows its progress.");
		busy = true;
		let target: Awaited<ReturnType<typeof resolveTarget>>;
		try {
			opts.signal?.throwIfAborted();
			target = await resolveTarget(args, recordingsDir);
		} catch (error) {
			busy = false;
			throw error;
		}
		status = {
			state: "waiting-for-editor",
			progress: null,
			outputPath: target.outputPath,
			error: null,
		};
		let editor: WebContents;
		try {
			editor = await waitForEditor(target.videoPath, opts.signal);
		} catch (error) {
			fail((error as Error).message);
			throw error;
		}
		status = { ...status, state: "exporting", progress: 0 };
		const request: RemoteExportRequest = {
			id: randomUUID(),
			outputPath: target.outputPath,
			format: target.format,
			quality: args.quality,
		};
		const completion = runInEditor(editor, request, opts.onProgress);
		const result = await new Promise<RemoteExportResult | null>((resolve) => {
			const detach = () => resolve(null);
			const timer = setTimeout(detach, EXPORT_WAIT_CAP_MS);
			opts.signal?.addEventListener("abort", detach, { once: true });
			void completion.then((done) => {
				clearTimeout(timer);
				opts.signal?.removeEventListener("abort", detach);
				resolve(done);
			});
		});
		if (!result) {
			if (active?.id === request.id) active.onProgress = undefined;
			return { status: "still-exporting" };
		}
		if (!result.ok) throw new Error(result.error ?? "The export failed.");
		return { status: "done", path: result.path ?? request.outputPath };
	}

	return {
		exportVideo,
		getStatus: (): RemoteExportStatus => ({ ...status }),
	};
}

export type RemoteExport = ReturnType<typeof createRemoteExport>;
