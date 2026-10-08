import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const ipc = vi.hoisted(() => ({
	state: {
		nativeCaptureTargetPath: null as string | null,
		lastNativeCaptureDiagnostics: null as {
			backend?: string;
			outputPath?: string | null;
		} | null,
		nativeScreenRecordingActive: false,
		windowsNativeCaptureActive: false,
		ffmpegScreenRecordingActive: false,
		setCurrentVideoPath: vi.fn(),
		setCurrentProjectPath: vi.fn(),
		setCurrentRecordingSession: vi.fn(),
	},
	mac: { recoverNativeMacCaptureOutput: vi.fn() },
	session: { resolveRecordingSession: vi.fn() },
	manager: { replaceApprovedSessionLocalReadPaths: vi.fn() },
	utils: { approveUserPath: vi.fn() },
}));
vi.mock("../ipc/state", () => ipc.state);
vi.mock("../ipc/recording/mac", () => ipc.mac);
vi.mock("../ipc/project/session", () => ipc.session);
vi.mock("../ipc/project/manager", () => ipc.manager);
vi.mock("../ipc/utils", () => ipc.utils);

const { createRemoteRecordings } = await import("./remoteRecordings");

function setup(overrides = {}) {
	const deps = {
		list: vi.fn(async () => [
			{ path: "/r/old.mp4", name: "old.mp4", bytes: 10, createdAt: 1000 },
			{ path: "/r/new.mp4", name: "new.mp4", bytes: 20, createdAt: 2000 },
		]),
		setRemoved: vi.fn(async () => undefined),
		validate: vi.fn(async () => ({ fileSizeBytes: 5000, durationSeconds: 90 })),
		activate: vi.fn(async () => ({ usedLiveCapture: false })),
		isCapturing: vi.fn(async () => false),
		...overrides,
	};
	return { deps, recordings: createRemoteRecordings(deps) };
}

describe("recoverRecording", () => {
	it("validates, then makes a valid file the current recording", async () => {
		const { deps, recordings } = setup();
		const result = await recordings.recoverRecording("/r/take.mp4");
		expect(deps.validate).toHaveBeenCalledWith("/r/take.mp4");
		expect(deps.activate).toHaveBeenCalledWith("/r/take.mp4");
		expect(result).toMatchObject({
			path: "/r/take.mp4",
			durationSeconds: 90,
			telemetrySaved: false,
		});
	});

	it("reports saved telemetry when the live capture was recovered", async () => {
		const { recordings } = setup({ activate: vi.fn(async () => ({ usedLiveCapture: true })) });
		expect((await recordings.recoverRecording("/r/take.mov")).telemetrySaved).toBe(true);
	});

	it("rejects a missing file without activating it", async () => {
		const { deps, recordings } = setup({
			validate: vi.fn(async () => {
				throw Object.assign(new Error("nope"), { code: "ENOENT" });
			}),
		});
		await expect(recordings.recoverRecording("/r/gone.mp4")).rejects.toThrow(/no file at/);
		expect(deps.activate).not.toHaveBeenCalled();
	});

	it("rejects a non-video extension and a file that will not decode", async () => {
		const { deps, recordings } = setup({
			validate: vi.fn(async () => {
				throw new Error("does not contain a readable video stream");
			}),
		});
		await expect(recordings.recoverRecording("/r/notes.txt")).rejects.toThrow(/not a video/);
		await expect(recordings.recoverRecording("/r/bad.mp4")).rejects.toThrow(/cannot play/);
		await expect(recordings.recoverRecording("bad.mp4")).rejects.toThrow(/absolute/);
		expect(deps.activate).not.toHaveBeenCalled();
	});

	it("refuses while a capture is still running", async () => {
		const { deps, recordings } = setup({ isCapturing: vi.fn(async () => true) });
		await expect(recordings.recoverRecording("/r/take.mp4")).rejects.toThrow(/still recording/);
		expect(deps.validate).not.toHaveBeenCalled();
		expect(deps.activate).not.toHaveBeenCalled();
	});
});

describe("the default activation", () => {
	const platform = process.platform;
	const recover = () =>
		createRemoteRecordings({
			validate: async () => ({ fileSizeBytes: 5000, durationSeconds: 90 }),
		}).recoverRecording("/r/take.mp4");

	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		vi.clearAllMocks();
		ipc.state.nativeCaptureTargetPath = null;
		ipc.state.lastNativeCaptureDiagnostics = null;
		ipc.state.nativeScreenRecordingActive = false;
		ipc.session.resolveRecordingSession.mockResolvedValue(null);
		ipc.mac.recoverNativeMacCaptureOutput.mockResolvedValue(null);
		ipc.manager.replaceApprovedSessionLocalReadPaths.mockResolvedValue(undefined);
	});
	afterEach(() =>
		Object.defineProperty(process, "platform", { value: platform, configurable: true }),
	);

	it("saves the live telemetry when the capture held this exact file", async () => {
		ipc.state.nativeCaptureTargetPath = "/r/take.mp4";
		ipc.mac.recoverNativeMacCaptureOutput.mockResolvedValue({
			success: true,
			path: "/r/take.mp4",
		});
		expect((await recover()).telemetrySaved).toBe(true);
		expect(ipc.state.setCurrentRecordingSession).not.toHaveBeenCalled();
	});

	it("leaves the native recovery alone when it holds a different file", async () => {
		ipc.state.nativeCaptureTargetPath = "/r/live.mp4";
		ipc.state.lastNativeCaptureDiagnostics = {
			backend: "mac-screencapturekit",
			outputPath: "/r/take.mp4",
		};
		const result = await recover();
		expect(ipc.mac.recoverNativeMacCaptureOutput).not.toHaveBeenCalled();
		expect(result.telemetrySaved).toBe(false);
		expect(ipc.state.setCurrentVideoPath).toHaveBeenCalledWith("/r/take.mp4");
	});

	it("adopts the file anyway when the recovery wrote another one", async () => {
		ipc.state.nativeCaptureTargetPath = "/r/take.mp4";
		ipc.mac.recoverNativeMacCaptureOutput.mockResolvedValue({
			success: true,
			path: "/r/other.mp4",
		});
		const result = await recover();
		expect(result.telemetrySaved).toBe(false);
		expect(ipc.state.setCurrentVideoPath).toHaveBeenCalledWith("/r/take.mp4");
	});

	it("keeps the current recording when the session cannot be read", async () => {
		ipc.session.resolveRecordingSession.mockRejectedValue(new Error("manifest is unreadable"));
		await expect(recover()).rejects.toThrow(/manifest is unreadable/);
		expect(ipc.state.setCurrentVideoPath).not.toHaveBeenCalled();
		expect(ipc.utils.approveUserPath).not.toHaveBeenCalled();
	});
});

describe("list and delete", () => {
	it("lists newest first with size and ISO date", async () => {
		const { recordings } = setup();
		const { recordings: list } = await recordings.listRecordings();
		expect(list.map((entry) => entry.name)).toEqual(["new.mp4", "old.mp4"]);
		expect(list[0]).toMatchObject({ sizeBytes: 20, modifiedAt: new Date(2000).toISOString() });
	});

	it("delete goes through the reversible trash and says so", async () => {
		const { deps, recordings } = setup();
		const result = await recordings.deleteRecording("/r/old.mp4");
		expect(deps.setRemoved).toHaveBeenCalledWith(["/r/old.mp4"], true);
		expect(result.note).toMatch(/not deleted for good/);
		await recordings.restoreRecording("/r/old.mp4");
		expect(deps.setRemoved).toHaveBeenLastCalledWith(["/r/old.mp4"], false);
	});
});
