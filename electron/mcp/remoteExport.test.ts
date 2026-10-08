import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { getPath: () => os.tmpdir(), isPackaged: false },
	ipcMain: { on: vi.fn() },
}));

const { buildPadFilter, createRemoteExport, isSameFile } = await import("./remoteExport");

let dir: string;
let videoPath: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-remote-export-"));
	videoPath = path.join(dir, "recording-1.mp4");
	await fs.writeFile(videoPath, "");
});
afterEach(async () => {
	vi.useRealTimers();
	await fs.rm(dir, { recursive: true, force: true });
});

function fakeEditor() {
	return Object.assign(new EventEmitter(), {
		send: vi.fn(),
		isDestroyed: () => false,
		isCrashed: () => false,
	});
}

function setup(runFfmpeg: (args: string[]) => Promise<void> = async () => undefined) {
	const ipc = new EventEmitter();
	const remote = createRemoteExport({
		ipc: ipc as unknown as IpcMain,
		recordingsDir: async () => dir,
		runFfmpeg,
	});
	const editor = fakeEditor();
	const ready = (target: string | null, sender = editor) =>
		ipc.emit("remote-editor-ready", { sender }, { videoPath: target, ready: target !== null });
	const sent = (times = 1) => vi.waitFor(() => expect(editor.send).toHaveBeenCalledTimes(times));
	const lastRequest = () => editor.send.mock.lastCall?.[1] as RemoteExportRequest;
	const reply = (result: Omit<RemoteExportResult, "id">) =>
		ipc.emit("remote-export-result", {}, { id: lastRequest().id, ...result });
	const progress = (value: number) =>
		ipc.emit("remote-export-progress", {}, { id: lastRequest().id, progress: value });
	return { remote, editor, ready, sent, lastRequest, reply, progress };
}

describe("output path validation", () => {
	it.each([
		[{ outputPath: "out.mp4" }, /absolute/],
		[{ outputPath: "/tmp/out.mov" }, /\.mp4/],
		[{ outputPath: "/tmp/out.mp4", format: "gif" as const }, /\.gif/],
		[{ outputPath: "/no/such/dir/out.mp4" }, /folder does not exist/],
	])("rejects %o", async (args, message) => {
		const { remote } = setup();
		await expect(remote.exportVideo({ videoPath, ...args })).rejects.toThrow(message);
		expect(remote.getStatus().state).toBe("idle");
	});

	it("rejects a whitespace-only path and a folder", async () => {
		const { remote } = setup();
		await expect(remote.exportVideo({ videoPath, outputPath: "   " })).rejects.toThrow(/empty/);
		const folder = path.join(dir, "folder.mp4");
		await fs.mkdir(folder);
		await expect(
			remote.exportVideo({ videoPath, outputPath: folder, overwrite: true }),
		).rejects.toThrow(/not a regular file/);
		expect(remote.getStatus().state).toBe("idle");
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"rejects an unwritable folder",
		async () => {
			const { remote } = setup();
			const locked = path.join(dir, "locked");
			await fs.mkdir(locked, { mode: 0o500 });
			await expect(
				remote.exportVideo({ videoPath, outputPath: path.join(locked, "out.mp4") }),
			).rejects.toThrow(/cannot write/);
			expect(remote.getStatus().state).toBe("idle");
		},
	);

	it("keeps surrounding spaces in a real file name", async () => {
		const { remote, ready, sent, lastRequest, reply } = setup();
		const spaced = path.join(dir, " demo .mp4");
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath, outputPath: spaced });
		await sent();
		expect(lastRequest().outputPath).toBe(spaced);
		reply({ ok: true, path: spaced });
		await pending;
	});

	it("rejects when there is no recording", async () => {
		const { remote } = setup();
		await expect(remote.exportVideo({ videoPath: null })).rejects.toThrow(/no recording/);
	});

	it("rejects a recording file that is not on disk", async () => {
		const { remote } = setup();
		await expect(remote.exportVideo({ videoPath: path.join(dir, "gone.mp4") })).rejects.toThrow(
			/no recording file at/,
		);
		expect(remote.getStatus().state).toBe("idle");
	});

	it("refuses to overwrite unless asked, and never the recording itself", async () => {
		const { remote, ready, sent, reply } = setup();
		const existing = path.join(dir, "taken.mp4");
		await fs.writeFile(existing, "");
		await expect(remote.exportVideo({ videoPath, outputPath: existing })).rejects.toThrow(
			/already exists/,
		);
		await expect(
			remote.exportVideo({ videoPath, outputPath: videoPath, overwrite: true }),
		).rejects.toThrow(/recording itself/);
		const alias = path.join(dir, "alias.mp4");
		await fs.link(videoPath, alias);
		await expect(
			remote.exportVideo({ videoPath, outputPath: alias, overwrite: true }),
		).rejects.toThrow(/recording itself/);
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath, outputPath: existing, overwrite: true });
		await sent();
		reply({ ok: true, path: existing });
		await expect(pending).resolves.toEqual({ status: "done", path: existing });
	});

	it("defaults to the recordings dir and infers gif from the extension", async () => {
		const { remote, ready, sent, lastRequest, reply } = setup();
		ready(videoPath);
		const first = remote.exportVideo({ videoPath });
		await sent();
		expect(lastRequest()).toEqual({
			id: expect.any(String),
			outputPath: path.join(dir, "recording-1-export.mp4"),
			format: "mp4",
			quality: undefined,
		});
		reply({ ok: true, path: lastRequest().outputPath });
		await first;

		const gifPath = path.join(dir, "clip.gif");
		const second = remote.exportVideo({ videoPath, outputPath: gifPath, quality: "high" });
		await sent(2);
		expect(lastRequest()).toMatchObject({
			format: "gif",
			outputPath: gifPath,
			quality: "high",
		});
		reply({ ok: true, path: gifPath });
		await second;
	});
});

describe("export flow", () => {
	it("waits for the editor to be ready for the requested recording", async () => {
		const { remote, editor, ready, sent, reply } = setup();
		const other = fakeEditor();
		ready(path.join(dir, "older.mp4"), other);
		const pending = remote.exportVideo({ videoPath });
		await vi.waitFor(() => expect(remote.getStatus().state).toBe("waiting-for-editor"));
		expect(editor.send).not.toHaveBeenCalled();
		ready(videoPath);
		await sent();
		expect(other.send).not.toHaveBeenCalled();
		expect(remote.getStatus().state).toBe("exporting");
		reply({ ok: true, path: "/out/final.mp4" });
		await expect(pending).resolves.toEqual({ status: "done", path: "/out/final.mp4" });
		expect(remote.getStatus()).toEqual({
			state: "done",
			progress: 100,
			outputPath: "/out/final.mp4",
			error: null,
		});
	});

	it("fails when the editor never becomes ready", async () => {
		vi.useFakeTimers();
		const { remote } = setup();
		const pending = remote.exportVideo({ videoPath });
		const assertion = expect(pending).rejects.toThrow(/did not finish loading/);
		await vi.waitFor(() => expect(remote.getStatus().state).toBe("waiting-for-editor"));
		await vi.advanceTimersByTimeAsync(45_000);
		await assertion;
		expect(remote.getStatus().state).toBe("failed");
	});

	it("reports an editor error and frees the slot", async () => {
		const { remote, ready, sent, reply } = setup();
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath });
		await sent();
		reply({ ok: false, error: "Encoder crashed" });
		await expect(pending).rejects.toThrow("Encoder crashed");
		expect(remote.getStatus()).toMatchObject({ state: "failed", error: "Encoder crashed" });
		const next = remote.exportVideo({ videoPath });
		await sent(2);
		reply({ ok: true, path: "/out/x.mp4" });
		await expect(next).resolves.toMatchObject({ status: "done" });
	});

	it("fails when the editor reloads mid-export, then retries once it is ready again", async () => {
		const { remote, editor, ready, sent, reply } = setup();
		ready(videoPath);
		ready(videoPath);
		expect(editor.listenerCount("did-start-navigation")).toBe(1);
		const pending = remote.exportVideo({ videoPath });
		await sent();
		editor.emit("did-start-navigation", {}, "app://editor", false, true);
		await expect(pending).rejects.toThrow(/reloaded/);
		const retry = remote.exportVideo({ videoPath });
		await vi.waitFor(() => expect(remote.getStatus().state).toBe("waiting-for-editor"));
		expect(editor.send).toHaveBeenCalledTimes(1);
		ready(videoPath);
		await sent(2);
		reply({ ok: true, path: "/out/retry.mp4" });
		await expect(retry).resolves.toEqual({ status: "done", path: "/out/retry.mp4" });
	});

	it("ignores in-page navigation and skips crashed editors", async () => {
		const { remote, editor, ready, sent, reply } = setup();
		const crashed = Object.assign(fakeEditor(), { isCrashed: () => true });
		ready(videoPath, crashed);
		ready(videoPath);
		editor.emit("did-start-navigation", {}, "app://editor#x", true, true);
		const pending = remote.exportVideo({ videoPath });
		await sent();
		expect(crashed.send).not.toHaveBeenCalled();
		reply({ ok: true, path: "/out/ok.mp4" });
		await expect(pending).resolves.toMatchObject({ status: "done" });
	});

	it("allows one export at a time", async () => {
		const { remote, ready, sent, reply } = setup();
		ready(videoPath);
		const first = remote.exportVideo({ videoPath });
		await expect(remote.exportVideo({ videoPath })).rejects.toThrow(/already running/);
		await sent();
		reply({ ok: true, path: "/out/a.mp4" });
		await first;
	});

	it("forwards progress, deduped and clamped", async () => {
		const { remote, ready, sent, progress, reply } = setup();
		ready(videoPath);
		const onProgress = vi.fn();
		const pending = remote.exportVideo({ videoPath }, { onProgress });
		await sent();
		progress(10.2);
		progress(10.4);
		progress(55);
		progress(40);
		progress(140);
		expect(onProgress.mock.calls).toEqual([[10], [55], [100]]);
		expect(remote.getStatus().progress).toBe(100);
		reply({ ok: true, path: "/out/p.mp4" });
		await pending;
	});

	it("stops waiting for the editor when aborted and frees the slot", async () => {
		const { remote, ready, sent, reply } = setup();
		const controller = new AbortController();
		const pending = remote.exportVideo({ videoPath }, { signal: controller.signal });
		await vi.waitFor(() => expect(remote.getStatus().state).toBe("waiting-for-editor"));
		controller.abort();
		await expect(pending).rejects.toThrow(/canceled/);
		expect(remote.getStatus().state).toBe("failed");
		ready(videoPath);
		const next = remote.exportVideo({ videoPath });
		await sent();
		reply({ ok: true, path: "/out/next.mp4" });
		await expect(next).resolves.toMatchObject({ status: "done" });
	});

	it("detaches from a running export when aborted", async () => {
		const { remote, ready, sent, reply } = setup();
		const controller = new AbortController();
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath }, { signal: controller.signal });
		await sent();
		controller.abort();
		await expect(pending).resolves.toEqual({ status: "still-exporting" });
		expect(remote.getStatus().state).toBe("exporting");
		reply({ ok: true, path: "/out/after.mp4" });
		expect(remote.getStatus()).toMatchObject({ state: "done", outputPath: "/out/after.mp4" });
	});

	it("rejects a signal that is already aborted", async () => {
		const { remote } = setup();
		await expect(
			remote.exportVideo({ videoPath }, { signal: AbortSignal.abort() }),
		).rejects.toThrow();
		expect(remote.getStatus().state).toBe("idle");
	});

	it("returns still-exporting after the cap and keeps tracking", async () => {
		vi.useFakeTimers();
		const { remote, ready, sent, progress, reply } = setup();
		ready(videoPath);
		const onProgress = vi.fn();
		const pending = remote.exportVideo({ videoPath }, { onProgress });
		await sent();
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await expect(pending).resolves.toEqual({ status: "still-exporting" });
		progress(80);
		expect(onProgress).not.toHaveBeenCalled();
		expect(remote.getStatus()).toMatchObject({ state: "exporting", progress: 80 });
		await expect(remote.exportVideo({ videoPath })).rejects.toThrow(/already running/);
		reply({ ok: true, path: "/out/late.mp4" });
		expect(remote.getStatus()).toMatchObject({ state: "done", outputPath: "/out/late.mp4" });
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("videoPath", () => {
	it("exports the file it is given, not another one the editor has open", async () => {
		const { remote, ready, sent, lastRequest, reply } = setup();
		const other = path.join(dir, "recording-2.mp4");
		await fs.writeFile(other, "");
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath: other });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(remote.getStatus().state).toBe("waiting-for-editor");
		ready(other);
		await sent();
		expect(lastRequest().outputPath).toBe(path.join(dir, "recording-2-export.mp4"));
		reply({ ok: true, path: lastRequest().outputPath });
		await pending;
	});
});

describe("aspect and padTo", () => {
	it("letterboxes to a fixed size by fitting first, never stretching", () => {
		const { filter } = buildPadFilter({ padTo: "2880x1600" }) ?? { filter: "" };
		expect(filter).toBe(
			"scale=2880:1600:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=2880:1600:(ow-iw)/2:(oh-ih)/2:black",
		);
	});

	it("pads to an aspect ratio by only growing the canvas", () => {
		const { filter } = buildPadFilter({ aspect: "16:9" }) ?? { filter: "" };
		expect(filter).toContain("pad='ceil(max(iw,ih*16/9)/2)*2':'ceil(max(ih,iw/(16/9))/2)*2'");
		expect(filter).not.toMatch(/scale=\d+:\d+(?!:force)/);
	});

	it.each([
		[{ aspect: "wide" }, /aspect must look like/],
		[{ aspect: "16:0" }, /aspect must look like/],
		[{ padTo: "2881x1600" }, /even/],
		[{ padTo: "9000x1600" }, /larger than/],
		[{ aspect: "16:9", padTo: "2880x1600" }, /not both/],
	])("rejects %o before touching the editor", async (args, message) => {
		const { remote } = setup();
		await expect(remote.exportVideo({ videoPath, ...args })).rejects.toThrow(message);
		expect(remote.getStatus().state).toBe("idle");
	});

	it("rejects padding a gif", async () => {
		const { remote } = setup();
		await expect(
			remote.exportVideo({ videoPath, format: "gif", padTo: "2880x1600" }),
		).rejects.toThrow(/only work with mp4/);
	});

	it("renders to a temp file, pads it with ffmpeg, and leaves only the final file", async () => {
		const runFfmpeg = vi.fn(async (args: string[]) => {
			await fs.writeFile(args[args.length - 1], "padded");
		});
		const { remote, ready, sent, lastRequest, reply } = setup(runFfmpeg);
		const out = path.join(dir, "final.mp4");
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath, outputPath: out, padTo: "2880x1600" });
		await sent();
		const rendered = lastRequest().outputPath;
		expect(rendered).not.toBe(out);
		await fs.writeFile(rendered, "raw");
		reply({ ok: true, path: rendered });
		await expect(pending).resolves.toEqual({ status: "done", path: out });
		const args = runFfmpeg.mock.calls[0][0];
		expect(args[args.indexOf("-vf") + 1]).toContain("pad=2880:1600");
		expect(args[args.indexOf("-i") + 1]).toBe(rendered);
		expect(await fs.readFile(out, "utf8")).toBe("padded");
		expect((await fs.readdir(dir)).sort()).toEqual(["final.mp4", "recording-1.mp4"]);
		expect(remote.getStatus()).toMatchObject({ state: "done", outputPath: out });
	});

	it("reports a padding failure plainly", async () => {
		const { remote, ready, sent, lastRequest, reply } = setup(async () => {
			throw new Error("Invalid argument");
		});
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath, aspect: "1:1" });
		await sent();
		reply({ ok: true, path: lastRequest().outputPath });
		await expect(pending).rejects.toThrow(/padding it failed: Invalid argument/);
		expect(remote.getStatus().state).toBe("failed");
	});

	it("keeps the unpadded video when padding fails", async () => {
		const { remote, ready, sent, lastRequest, reply } = setup(async () => {
			throw new Error("Invalid argument");
		});
		const out = path.join(dir, "final.mp4");
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath, outputPath: out, padTo: "2880x1600" });
		await sent();
		await fs.writeFile(lastRequest().outputPath, "raw");
		reply({ ok: true, path: lastRequest().outputPath });
		await expect(pending).rejects.toThrow(/The unpadded video is at/);
		expect(await fs.readFile(out, "utf8")).toBe("raw");
		expect((await fs.readdir(dir)).sort()).toEqual(["final.mp4", "recording-1.mp4"]);
	});

	it("removes the pre-pad file when the editor's export fails", async () => {
		const { remote, ready, sent, lastRequest, reply } = setup();
		ready(videoPath);
		const pending = remote.exportVideo({
			videoPath,
			outputPath: path.join(dir, "final.mp4"),
			padTo: "2880x1600",
		});
		await sent();
		await fs.writeFile(lastRequest().outputPath, "half");
		reply({ ok: false, error: "Encoder crashed" });
		await expect(pending).rejects.toThrow("Encoder crashed");
		expect(await fs.readdir(dir)).toEqual(["recording-1.mp4"]);
	});

	it("leaves a file that already sits at a temp path alone", async () => {
		const runFfmpeg = vi.fn(async (args: string[]) => {
			await fs.writeFile(args[args.length - 1], "padded");
		});
		const { remote, ready, sent, lastRequest, reply } = setup(runFfmpeg);
		const out = path.join(dir, "final.mp4");
		const prepad = path.join(dir, ".final.prepad.mp4");
		const staged = `${out}.padding.mp4`;
		await fs.writeFile(prepad, "mine");
		await fs.writeFile(staged, "mine");
		ready(videoPath);
		const pending = remote.exportVideo({ videoPath, outputPath: out, padTo: "2880x1600" });
		await sent();
		await fs.writeFile(lastRequest().outputPath, "raw");
		reply({ ok: true, path: lastRequest().outputPath });
		await expect(pending).resolves.toEqual({ status: "done", path: out });
		expect(await fs.readFile(prepad, "utf8")).toBe("mine");
		expect(await fs.readFile(staged, "utf8")).toBe("mine");
	});
});

describe("isSameFile", () => {
	const real = { dev: 1n, ino: 42n };
	const other = { dev: 1n, ino: 43n };
	const unknown = { dev: 0n, ino: 0n };

	it("matches the same inode under another name", () => {
		expect(isSameFile("/rec/a.mp4", real, "/rec/b.mp4", real)).toBe(true);
		expect(isSameFile("/rec/a.mp4", real, "/rec/b.mp4", other)).toBe(false);
	});

	it("falls back to the resolved path when the inode is unknown", () => {
		expect(isSameFile("/rec/a.mp4", unknown, "/rec/b.mp4", unknown)).toBe(false);
		expect(isSameFile("/rec/x/../a.mp4", unknown, "/rec/a.mp4", unknown)).toBe(true);
	});

	it("compares paths case-insensitively only on Windows", () => {
		expect(isSameFile("/Rec/A.mp4", unknown, "/rec/a.mp4", unknown, "win32")).toBe(true);
		expect(isSameFile("/Rec/A.mp4", unknown, "/rec/a.mp4", unknown, "linux")).toBe(false);
	});
});
