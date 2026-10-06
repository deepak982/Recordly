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

const { createRemoteExport } = await import("./remoteExport");

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

function setup() {
	const ipc = new EventEmitter();
	const remote = createRemoteExport({
		ipc: ipc as unknown as IpcMain,
		recordingsDir: async () => dir,
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

	it("rejects when there is no recording", async () => {
		const { remote } = setup();
		await expect(remote.exportVideo({ videoPath: null })).rejects.toThrow(/no recording/);
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
		await fs.symlink(videoPath, alias);
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
		progress(140);
		expect(onProgress.mock.calls).toEqual([[10], [55], [100]]);
		expect(remote.getStatus().progress).toBe(100);
		reply({ ok: true, path: "/out/p.mp4" });
		await pending;
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
