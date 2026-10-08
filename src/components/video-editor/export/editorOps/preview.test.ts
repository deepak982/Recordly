import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipRegion } from "../../types";
import type { EditorOpContext } from "./types";

const recorder = vi.hoisted(() => ({
	configs: [] as Record<string, unknown>[],
	renders: [] as number[][],
	destroyed: 0,
	cursorAssetsFail: false,
	initFails: false,
}));

vi.mock("@/lib/exporter/frameRenderer", () => ({
	FrameRenderer: class {
		constructor(config: Record<string, unknown>) {
			recorder.configs.push(config);
		}
		async initialize() {
			if (recorder.initFails) throw new Error("no GPU context");
		}
		async renderFrame(
			_frame: unknown,
			timestamp: number,
			cursorTimestamp: number,
			_durationUs: undefined,
			timelineTimestamp: number,
		) {
			recorder.renders.push([timestamp, cursorTimestamp, timelineTimestamp]);
		}
		getCanvas() {
			return { tile: true };
		}
		destroy() {
			recorder.destroyed += 1;
		}
	},
}));

vi.mock("../../videoPlayback/cursorRenderer", () => ({
	preloadCursorAssets: async () => {
		if (recorder.cursorAssetsFail) throw new Error("cursor artwork missing");
	},
}));

vi.mock("../../projectPersistence", () => ({
	resolveVideoUrl: async (path: string) => `file://${path}`,
	toFileUrl: (path: string) => `file://${path}`,
}));

import {
	MAX_PREVIEW_FRAMES,
	MIN_EVERY_MS,
	planPreview,
	previewSheetGeometry,
	renderPreview,
} from "./preview";

type Listener = () => void;

function fakeVideo() {
	const listeners = new Map<string, Set<Listener>>();
	const emit = (type: string) => {
		for (const listener of [...(listeners.get(type) ?? [])]) listener();
	};
	const video = {
		muted: false,
		preload: "",
		videoWidth: 1920,
		videoHeight: 1080,
		currentTime: 0,
		seeks: [] as number[],
		cleared: false,
		addEventListener(type: string, listener: Listener) {
			const set = listeners.get(type) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type: string, listener: Listener) {
			listeners.get(type)?.delete(listener);
		},
		removeAttribute() {
			video.cleared = true;
		},
		load() {},
		set src(_value: string) {
			queueMicrotask(() => emit("loadeddata"));
		},
	};
	Object.defineProperty(video, "currentTime", {
		set(value: number) {
			video.seeks.push(value);
			queueMicrotask(() => emit("seeked"));
		},
		get() {
			return video.seeks[video.seeks.length - 1] ?? 0;
		},
	});
	return video;
}

function fakeCanvas() {
	return {
		width: 0,
		height: 0,
		drawn: [] as unknown[][],
		getContext(kind: string) {
			if (kind !== "2d") return null;
			return {
				drawImage: (...args: unknown[]) => {
					this.drawn.push(args);
				},
			};
		},
		toDataURL: () => "data:image/jpeg;base64,SHEET",
	};
}

const original = {
	document: (globalThis as { document?: unknown }).document,
	VideoFrame: (globalThis as { VideoFrame?: unknown }).VideoFrame,
};

let video: ReturnType<typeof fakeVideo>;
let canvases: ReturnType<typeof fakeCanvas>[];
let overlay: { clientWidth: number; clientHeight: number } | null;

beforeEach(() => {
	recorder.configs = [];
	recorder.renders = [];
	recorder.destroyed = 0;
	recorder.cursorAssetsFail = false;
	recorder.initFails = false;
	video = fakeVideo();
	canvases = [];
	overlay = { clientWidth: 1280, clientHeight: 720 };
	(globalThis as { document?: unknown }).document = {
		createElement: (tag: string) => {
			if (tag === "video") return video;
			const canvas = fakeCanvas();
			canvases.push(canvas);
			return canvas;
		},
		querySelector: () => overlay,
	};
	(globalThis as { VideoFrame?: unknown }).VideoFrame = class {
		constructor(
			public source: unknown,
			public init: { timestamp: number },
		) {}
		close() {}
	};
});

afterEach(() => {
	(globalThis as { document?: unknown }).document = original.document;
	(globalThis as { VideoFrame?: unknown }).VideoFrame = original.VideoFrame;
});

const clip = (over: Partial<ClipRegion> = {}): ClipRegion =>
	({ id: "clip-1", startMs: 0, endMs: 10_000, speed: 1, ...over }) as ClipRegion;

function makeContext(over: Record<string, unknown> = {}) {
	const timeline = {
		clipRegions: [clip()],
		zoomRegions: [],
		annotationRegions: [],
		audioRegions: [],
		speedRegions: [],
		trimRegions: [],
		cursorTelemetry: [{ timeMs: 0, x: 1, y: 1 }],
		autoCaptions: [],
		autoCaptionSettings: { enabled: true },
		...((over.timeline as Record<string, unknown>) ?? {}),
	};
	const appearance = {
		wallpaper: "none",
		padding: 0,
		borderRadius: 0,
		shadowIntensity: 0,
		backgroundBlur: 0,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		webcam: { enabled: false, sourcePath: null },
		resolvedWebcamVideoUrl: null,
		showCursor: true,
		cursorStyle: "tahoe",
		cursorSize: 1.4,
		...((over.appearance as Record<string, unknown>) ?? {}),
	};
	return {
		duration: 10,
		videoSourcePath: "/tmp/take.mp4",
		assertSameRecording: () => undefined,
		adoptJoinedMedia: () => undefined,
		history: { undo: () => {}, redo: () => {}, canUndo: false, canRedo: false },
		ids: {},
		...over,
		timeline,
		appearance,
	} as unknown as EditorOpContext;
}

const plan = (payload: unknown, clips: ClipRegion[] = [clip()], durationMs = 10_000) =>
	planPreview(payload, { clipRegions: clips, durationMs });

describe("planPreview", () => {
	it("defaults to a single frame at the start of the edited timeline", () => {
		expect(plan({})).toMatchObject({
			frames: [{ atMs: 0, sourceMs: 0 }],
			cols: 1,
			rows: 1,
			skippedAtMs: [],
		});
	});

	it("maps an edited time through a cut and a speed change to its source time", () => {
		const clips = [
			clip({ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 4000, speed: 1 }),
			clip({ id: "b", startMs: 1000, endMs: 2000, sourceStartMs: 20_000, speed: 2 }),
		];
		expect(plan({ atMs: 1500 }, clips, 2000).frames).toEqual([
			{ atMs: 1500, sourceMs: 21_000 },
		]);
	});

	it("resolves a time exactly on a cut into the clip that starts there", () => {
		const clips = [
			clip({ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0 }),
			clip({ id: "b", startMs: 1000, endMs: 2000, sourceStartMs: 50_000 }),
		];
		expect(plan({ atMs: 1000 }, clips, 2000).frames).toEqual([
			{ atMs: 1000, sourceMs: 50_000 },
		]);
	});

	it("resolves the very last millisecond of the timeline instead of calling it a gap", () => {
		const clips = [clip({ startMs: 0, endMs: 2000, sourceStartMs: 1000 })];
		expect(plan({ atMs: 2000 }, clips, 2000).frames).toEqual([{ atMs: 2000, sourceMs: 2999 }]);
	});

	it("refuses a time in a gap between clips", () => {
		const clips = [
			clip({ id: "a", startMs: 0, endMs: 1000 }),
			clip({ id: "b", startMs: 5000, endMs: 6000 }),
		];
		expect(() => plan({ atMs: 3000 }, clips, 6000)).toThrow(/falls in a gap/);
	});

	it("refuses a time past the end of the edited timeline", () => {
		expect(() => plan({ atMs: 10_001 })).toThrow(/past the end/);
	});

	it("refuses atMs together with count", () => {
		expect(() => plan({ atMs: 0, count: 3 })).toThrow(/not both/);
	});

	it("refuses count together with everyMs", () => {
		expect(() => plan({ count: 3, everyMs: 500 })).toThrow(/exactly one/);
	});

	it("refuses an unknown field", () => {
		expect(() => plan({ atMs: 0, source: "raw" })).toThrow(/unknown field source/);
	});

	it("refuses a count outside 2 to the maximum", () => {
		expect(() => plan({ count: 1 })).toThrow(/whole number from 2/);
		expect(() => plan({ count: MAX_PREVIEW_FRAMES + 1 })).toThrow(/whole number from 2/);
		expect(() => plan({ count: 2.5 })).toThrow(/whole number from 2/);
	});

	it("refuses an everyMs below one frame and one that asks for too many frames", () => {
		expect(() => plan({ everyMs: MIN_EVERY_MS - 1 })).toThrow(/at least 17 ms/);
		expect(() => plan({ everyMs: 100 })).toThrow(/the most is 6/);
		expect(() => plan({ everyMs: 20_000 })).toThrow(/longer than the edited timeline/);
	});

	it("refuses a timeline with no length", () => {
		expect(() => plan({}, [], 0)).toThrow(/no length to preview/);
	});

	it("lays a sheet out in a grid and lists the moments that fall in gaps", () => {
		const clips = [
			clip({ id: "a", startMs: 0, endMs: 1000, sourceStartMs: 0 }),
			clip({ id: "b", startMs: 5000, endMs: 6000, sourceStartMs: 9000 }),
		];
		const result = plan({ count: 3 }, clips, 6000);
		expect(result.frames.map((frame) => frame.atMs)).toEqual([0, 6000]);
		expect(result.skippedAtMs).toEqual([3000]);
		expect([result.cols, result.rows]).toEqual([2, 1]);
	});

	it("refuses a sheet when fewer than two moments play anything", () => {
		const clips = [clip({ id: "a", startMs: 0, endMs: 100, sourceStartMs: 0 })];
		expect(() => plan({ count: 3 }, clips, 9000)).toThrow(/Fewer than two/);
	});
});

describe("render_preview", () => {
	it("composites through the export renderer and reports the layers it drew", async () => {
		const result = (await renderPreview({ atMs: 500 }, makeContext())) as Record<
			string,
			unknown
		>;
		expect(result.image).toEqual({
			data: "SHEET",
			mimeType: "image/jpeg",
			width: 1280,
			height: 720,
		});
		expect(result.frames).toEqual([{ atMs: 500, sourceMs: 500 }]);
		expect(recorder.renders).toEqual([[500_000, 500_000, 500_000]]);
		expect(recorder.configs[0]).toMatchObject({
			timelineEffects: true,
			width: 1280,
			height: 720,
			videoWidth: 1920,
			videoHeight: 1080,
			previewWidth: 1280,
			previewHeight: 720,
		});
		expect(result.rendered).toContain("cursor");
		expect(result.notRendered).toEqual([]);
		expect(recorder.destroyed).toBe(1);
		expect(video.cleared).toBe(true);
	});

	it("names the cursor as not rendered when the recording has no telemetry", async () => {
		const result = (await renderPreview(
			{},
			makeContext({ timeline: { cursorTelemetry: [] } }),
		)) as { rendered: string[]; notRendered: string[] };
		expect(result.rendered).not.toContain("cursor");
		expect(result.notRendered).toEqual(["cursor: this recording carries no cursor telemetry"]);
	});

	it("names the cursor as not rendered when its artwork cannot be loaded", async () => {
		recorder.cursorAssetsFail = true;
		const result = (await renderPreview({}, makeContext())) as { notRendered: string[] };
		expect(result.notRendered[0]).toMatch(/cursor: its artwork could not be loaded/);
	});

	it("says the preview could not be measured when the editor preview is not on screen", async () => {
		overlay = null;
		const result = (await renderPreview({}, makeContext())) as { note: string };
		expect(result.note).toMatch(/could not be measured/);
		expect(recorder.configs[0]).toMatchObject({ previewWidth: 1920, previewHeight: 1080 });
	});

	it("tiles a sheet and seeks once per frame", async () => {
		const result = (await renderPreview({ count: 3 }, makeContext())) as {
			cols: number;
			rows: number;
			frames: unknown[];
		};
		expect(result.frames).toHaveLength(3);
		expect(video.seeks).toEqual([0, 5, 9.96]);
		expect([result.cols, result.rows]).toEqual([2, 2]);
		const sheet = canvases[canvases.length - 1];
		expect(sheet.drawn).toHaveLength(3);
		expect([sheet.width, sheet.height]).toEqual([1286, 726]);
	});

	it("refuses when no recording is loaded", async () => {
		await expect(renderPreview({}, makeContext({ videoSourcePath: null }))).rejects.toThrow(
			/no recording loaded in the editor/,
		);
	});

	it("releases the renderer and the video when the renderer cannot start", async () => {
		recorder.initFails = true;
		await expect(renderPreview({}, makeContext())).rejects.toThrow(/no GPU context/);
		expect(video.cleared).toBe(true);
	});

	it("refuses a second preview while one is still rendering", async () => {
		const first = renderPreview({}, makeContext());
		await expect(renderPreview({}, makeContext())).rejects.toThrow(/already rendering/);
		await first;
		await expect(renderPreview({}, makeContext())).resolves.toBeTruthy();
	});

	it("refuses when the editor loads a different recording mid-render", async () => {
		let calls = 0;
		await expect(
			renderPreview(
				{},
				makeContext({
					assertSameRecording: () => {
						calls += 1;
						if (calls > 1) throw new Error("The editor loaded a different recording");
					},
				}),
			),
		).rejects.toThrow(/different recording/);
		expect(video.cleared).toBe(true);
	});
});

describe("previewSheetGeometry", () => {
	it("keeps the planned grid when every frame was drawn", () => {
		expect(previewSheetGeometry(6, 3)).toEqual({ cols: 3, rows: 2 });
		expect(previewSheetGeometry(4, 2)).toEqual({ cols: 2, rows: 2 });
	});

	it("shrinks to one row when the budget cut the sheet short", () => {
		expect(previewSheetGeometry(2, 3)).toEqual({ cols: 2, rows: 1 });
	});

	it("drops the rows nothing was drawn into", () => {
		expect(previewSheetGeometry(4, 3)).toEqual({ cols: 3, rows: 2 });
	});

	it("never returns a zero-sized sheet", () => {
		expect(previewSheetGeometry(0, 3)).toEqual({ cols: 1, rows: 1 });
	});
});
