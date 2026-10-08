import { EventEmitter } from "node:events";
import type { IpcMain } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { getPath: () => "/tmp", isPackaged: false },
	ipcMain: { on: vi.fn() },
}));

const { createRemoteEditor, frameArgs, timelineToSourceMs } = await import("./remoteEditor");

afterEach(() => vi.useRealTimers());

function setup(options: Parameters<typeof createRemoteEditor>[0] = {}) {
	const ipc = new EventEmitter();
	const editor = Object.assign(new EventEmitter(), {
		send: vi.fn(),
		isDestroyed: () => false,
		isCrashed: () => false,
	});
	const remote = createRemoteEditor({ ipc: ipc as unknown as IpcMain, ...options });
	const ready = () =>
		ipc.emit("remote-editor-ready", { sender: editor }, { videoPath: "/v/a.mp4", ready: true });
	const request = (index: number) => editor.send.mock.calls[index][1] as RemoteEditorRequest;
	const reply = (index: number, result: Omit<RemoteEditorResult, "id">) =>
		ipc.emit("remote-editor-result", {}, { id: request(index).id, ...result });
	const sent = (times: number) =>
		vi.waitFor(() => expect(editor.send).toHaveBeenCalledTimes(times));
	return { remote, editor, ready, request, reply, sent };
}

const state = {
	videoPath: "/v/a.mp4",
	durationMs: 8000,
	sourceDurationMs: 10_000,
	clips: [
		{ id: "c1", startMs: 0, endMs: 2000, sourceStartMs: 0, speed: 1 },
		{ id: "c2", startMs: 2000, endMs: 8000, sourceStartMs: 4000, speed: 1 },
	],
	zooms: [],
	annotations: [],
	audio: [],
	captions: [],
};

describe("requestEditor", () => {
	it("times out when the editor never becomes ready", async () => {
		vi.useFakeTimers();
		const { remote, editor } = setup({ readyTimeoutMs: 1000 });
		const result = remote.requestEditor("get_state");
		const expectation = expect(result).rejects.toThrow(/did not finish loading/);
		await vi.advanceTimersByTimeAsync(1001);
		await expectation;
		expect(editor.send).not.toHaveBeenCalled();
	});

	it("settles two concurrent requests to the right callers", async () => {
		const { remote, ready, sent, request, reply } = setup();
		ready();
		const first = remote.requestEditor("a");
		const second = remote.requestEditor("b");
		await sent(2);
		expect([request(0).op, request(1).op]).toEqual(["a", "b"]);
		reply(1, { ok: true, data: "for-b" });
		reply(0, { ok: true, data: "for-a" });
		await expect(first).resolves.toBe("for-a");
		await expect(second).resolves.toBe("for-b");
	});

	it("surfaces a renderer error as a failure", async () => {
		const { remote, ready, sent, reply } = setup();
		ready();
		const result = remote.requestEditor("nope");
		await sent(1);
		reply(0, { ok: false, error: 'The editor does not support "nope".' });
		await expect(result).rejects.toThrow('does not support "nope"');
	});

	it("rejects at once when the signal is already aborted", async () => {
		const { remote, editor } = setup();
		const result = remote.requestEditor("get_state", undefined, {
			signal: AbortSignal.abort(),
		});
		await expect(result).rejects.toThrow(/canceled/);
		expect(editor.send).not.toHaveBeenCalled();
	});

	it("reports why the editor could not be reached when send throws", async () => {
		const { remote, ready, editor } = setup();
		ready();
		editor.send.mockImplementation(() => {
			throw new Error("Object has been destroyed");
		});
		await expect(remote.requestEditor("get_state")).rejects.toThrow(
			/could not be reached: Object has been destroyed/,
		);
	});

	it("does not treat a truthy but non-true ok as success", async () => {
		const { remote, ready, sent, reply } = setup();
		ready();
		const result = remote.requestEditor("get_state");
		await sent(1);
		reply(0, { ok: "yes" as unknown as boolean, data: 1 });
		await expect(result).rejects.toThrow(/could not run get_state/);
	});

	it("fails when the editor does not answer", async () => {
		vi.useFakeTimers();
		const { remote, ready } = setup({ replyTimeoutMs: 500 });
		ready();
		const result = remote.requestEditor("get_state");
		const expectation = expect(result).rejects.toThrow(/did not answer get_state/);
		await vi.advanceTimersByTimeAsync(501);
		await expectation;
	});
});

describe("get_state", () => {
	it("returns the editor's state untouched", async () => {
		const { remote, ready, sent, reply } = setup();
		ready();
		const result = remote.getState();
		await sent(1);
		reply(0, { ok: true, data: state });
		await expect(result).resolves.toEqual(state);
	});
});

describe("get_state validation", () => {
	it.each([
		["no video loaded", { ...state, videoPath: null }],
		["clips that are not a list", { ...state, clips: undefined }],
		["no data at all", undefined],
	])("rejects %s", async (_name, data) => {
		const { remote, ready, sent, reply } = setup();
		ready();
		const result = remote.getState();
		await sent(1);
		reply(0, { ok: true, data });
		await expect(result).rejects.toThrow(/no recording loaded/);
	});
});

describe("get_frame", () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
	const frame = async (args: { atMs: number; source?: "edited" | "raw" }) => {
		const runFfmpeg = vi.fn(async () => png);
		const ctx = setup({ ffmpegPath: () => "ffmpeg", runFfmpeg });
		ctx.ready();
		const result = ctx.remote.getFrame(args);
		await ctx.sent(1);
		ctx.reply(0, { ok: true, data: state });
		return { result, runFfmpeg };
	};

	it("returns a PNG data URL, mapping edited time through the cuts", async () => {
		const { result, runFfmpeg } = await frame({ atMs: 3000, source: "edited" });
		const out = await result;
		expect(out.dataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
		expect(out.sourceMs).toBe(5000);
		expect(runFfmpeg).toHaveBeenCalledWith(
			"ffmpeg",
			frameArgs("/v/a.mp4", 5000),
			expect.any(Object),
		);
	});

	it("reads raw time straight from the recording", async () => {
		const { result } = await frame({ atMs: 3000, source: "raw" });
		expect((await result).sourceMs).toBe(3000);
	});

	it("returns the last frame at exactly the end of the edited video", async () => {
		const { result } = await frame({ atMs: 8000, source: "edited" });
		expect((await result).sourceMs).toBe(9960);
	});

	it("names the reason when ffmpeg fails", async () => {
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ killed: true, message: "Command failed" }, /took longer than 30 s/],
			[{ code: "ENOENT", message: "spawn ffmpeg ENOENT" }, /FFmpeg was not found/],
			[
				{ message: "Command failed: /bin/ffmpeg", stderr: Buffer.from("Invalid data\n") },
				/Invalid data/,
			],
		];
		for (const [failure, pattern] of cases) {
			const runFfmpeg = vi.fn(async () => {
				throw Object.assign(new Error(String(failure.message)), failure);
			});
			const ctx = setup({ ffmpegPath: () => "ffmpeg", runFfmpeg });
			ctx.ready();
			const result = ctx.remote.getFrame({ atMs: 100 });
			await ctx.sent(1);
			ctx.reply(0, { ok: true, data: state });
			await expect(result).rejects.toThrow(pattern);
		}
	});

	it("rejects output that is not a PNG", async () => {
		const ctx = setup({
			ffmpegPath: () => "ffmpeg",
			runFfmpeg: async () => Buffer.from("junk!"),
		});
		ctx.ready();
		const result = ctx.remote.getFrame({ atMs: 100 });
		await ctx.sent(1);
		ctx.reply(0, { ok: true, data: state });
		await expect(result).rejects.toThrow(/did not return an image/);
	});

	it("rejects a time past the end", async () => {
		const { result } = await frame({ atMs: 9000, source: "edited" });
		await expect(result).rejects.toThrow(/past the end/);
	});
});

describe("timelineToSourceMs", () => {
	it("honours speed and returns null in a gap", () => {
		const clips = [{ startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 2 }];
		expect(timelineToSourceMs(clips, 500)).toBe(1000);
		expect(timelineToSourceMs(clips, 1500)).toBeNull();
		expect(timelineToSourceMs([], 700)).toBe(700);
		expect(timelineToSourceMs(clips, 1000)).toBe(2000);
	});

	it("keeps a gap before the last clip a gap", () => {
		const clips = [
			{ startMs: 0, endMs: 1000, sourceStartMs: 0, speed: 1 },
			{ startMs: 2000, endMs: 3000, sourceStartMs: 5000, speed: 1 },
		];
		expect(timelineToSourceMs(clips, 1000)).toBeNull();
		expect(timelineToSourceMs(clips, 3000)).toBe(6000);
	});
});
