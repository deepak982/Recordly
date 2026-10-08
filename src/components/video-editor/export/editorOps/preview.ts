import { calculateMp4SourceDimensions } from "../../exportDimensions";
import { resolveVideoUrl } from "../../projectPersistence";
import {
	type ClipRegion,
	findClipAtTimelineTime,
	getTimelineDurationMs,
	mapTimelineTimeToSourceTime,
} from "../../types";
import { buildExportRenderOptions } from "../buildExportRenderOptions";
import {
	type EditorOpContext,
	type EditorOpMap,
	rejectUnknown,
	requireFiniteNumber,
	requireObject,
} from "./types";

export const MIN_PREVIEW_FRAMES = 2;
export const MAX_PREVIEW_FRAMES = 6;
export const MIN_EVERY_MS = 17;
export const MAX_SINGLE_WIDTH = 1280;
export const MAX_TILE_WIDTH = 640;

const TILE_GAP = 6;
const JPEG_QUALITY = 0.92;
const LOAD_TIMEOUT_MS = 20_000;
const SEEK_TIMEOUT_MS = 10_000;
const INIT_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 20_000;
const TOTAL_BUDGET_MS = 25_000;
const END_FRAME_BACKOFF_MS = 40;
const FALLBACK_PREVIEW_WIDTH = 1920;
const FALLBACK_PREVIEW_HEIGHT = 1080;

export type PreviewFrame = { atMs: number; sourceMs: number };

export type PreviewPlan = {
	frames: PreviewFrame[];
	skippedAtMs: number[];
	cols: number;
	rows: number;
	durationMs: number;
};

function even(value: number) {
	return Math.max(2, 2 * Math.floor(value / 2));
}

export function timelineToSourceMs(atMs: number, clips: ClipRegion[]): number | null {
	if (clips.length === 0) return Math.round(atMs);
	if (findClipAtTimelineTime(atMs, clips)) return mapTimelineTimeToSourceTime(atMs, clips);
	const lastEndMs = clips.reduce((end, clip) => Math.max(end, clip.endMs), 0);
	if (atMs === lastEndMs) return mapTimelineTimeToSourceTime(atMs - 1, clips);
	return null;
}

export function planPreview(
	payload: unknown,
	{ clipRegions, durationMs }: { clipRegions: ClipRegion[]; durationMs: number },
): PreviewPlan {
	const args = requireObject(payload, "render_preview");
	rejectUnknown(args, ["atMs", "count", "everyMs"], "render_preview");
	const { atMs, count, everyMs } = args;
	if (atMs !== undefined && (count !== undefined || everyMs !== undefined)) {
		throw new Error(
			"render_preview takes atMs for one frame or count/everyMs for a contact sheet, not both.",
		);
	}
	if (count !== undefined && everyMs !== undefined) {
		throw new Error("render_preview takes exactly one of count or everyMs.");
	}
	if (!(durationMs > 0)) {
		throw new Error(
			"The edited timeline has no length to preview yet. Load a recording in the editor first.",
		);
	}
	let times: number[];
	if (count !== undefined) {
		if (
			!Number.isInteger(count) ||
			(count as number) < MIN_PREVIEW_FRAMES ||
			(count as number) > MAX_PREVIEW_FRAMES
		) {
			throw new Error(
				`count must be a whole number from ${MIN_PREVIEW_FRAMES} to ${MAX_PREVIEW_FRAMES}. Each frame is composited one at a time, so a sheet is slow; pass atMs for a single frame.`,
			);
		}
		const total = count as number;
		times = Array.from({ length: total }, (_, index) =>
			Math.round((index * durationMs) / (total - 1)),
		);
	} else if (everyMs !== undefined) {
		const every = requireFiniteNumber(everyMs, "everyMs");
		if (every < MIN_EVERY_MS) {
			throw new Error(`everyMs must be at least ${MIN_EVERY_MS} ms (one frame at 60 fps).`);
		}
		const total = Math.floor(durationMs / every) + 1;
		if (total < MIN_PREVIEW_FRAMES) {
			throw new Error(
				`everyMs ${Math.round(every)} is longer than the edited timeline (${Math.round(durationMs)} ms).`,
			);
		}
		if (total > MAX_PREVIEW_FRAMES) {
			throw new Error(
				`everyMs ${Math.round(every)} would need ${total} frames over ${Math.round(durationMs)} ms; the most is ${MAX_PREVIEW_FRAMES}. Use a larger everyMs or pass count.`,
			);
		}
		times = Array.from({ length: total }, (_, index) => Math.round(index * every));
	} else {
		const at = atMs === undefined ? 0 : requireFiniteNumber(atMs, "atMs");
		if (at < 0) throw new Error("atMs must be 0 or more.");
		if (at > durationMs) {
			throw new Error(
				`atMs ${Math.round(at)} is past the end of the edited timeline (${Math.round(durationMs)} ms).`,
			);
		}
		times = [Math.round(at)];
	}
	const frames: PreviewFrame[] = [];
	const skippedAtMs: number[] = [];
	for (const time of times) {
		const sourceMs = timelineToSourceMs(time, clipRegions);
		if (sourceMs === null) skippedAtMs.push(time);
		else frames.push({ atMs: time, sourceMs });
	}
	if (frames.length === 0) {
		throw new Error(
			`Nothing plays at ${skippedAtMs.join(", ")} ms; it falls in a gap between clips.`,
		);
	}
	if (times.length > 1 && frames.length < MIN_PREVIEW_FRAMES) {
		throw new Error(
			"Fewer than two of those moments play anything; the rest fall in gaps between clips.",
		);
	}
	const cols = Math.ceil(Math.sqrt(frames.length));
	return { frames, skippedAtMs, cols, rows: Math.ceil(frames.length / cols), durationMs };
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, waitingFor: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(
							`Timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for ${waitingFor}.`,
						),
					),
				timeoutMs,
			);
		}),
	]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function settleVideo(video: HTMLVideoElement, event: "loadeddata" | "seeked", waitingFor: string) {
	return withTimeout(
		new Promise<void>((resolve, reject) => {
			const done = (error?: Error) => {
				video.removeEventListener(event, onEvent);
				video.removeEventListener("error", onError);
				error ? reject(error) : resolve();
			};
			const onEvent = () => done();
			const onError = () =>
				done(new Error(`The recording could not be decoded for a preview.`));
			video.addEventListener(event, onEvent, { once: true });
			video.addEventListener("error", onError, { once: true });
		}),
		event === "seeked" ? SEEK_TIMEOUT_MS : LOAD_TIMEOUT_MS,
		waitingFor,
	);
}

function previewPixelSize() {
	const overlay = document.querySelector<HTMLElement>("[data-preview-overlay]");
	const width = overlay?.clientWidth || 0;
	const height = overlay?.clientHeight || 0;
	if (width > 0 && height > 0) return { width, height, measured: true };
	return { width: FALLBACK_PREVIEW_WIDTH, height: FALLBACK_PREVIEW_HEIGHT, measured: false };
}

let rendering = false;

export async function renderPreview(payload: unknown, context: EditorOpContext) {
	const { timeline, appearance, videoSourcePath, duration } = context;
	if (!videoSourcePath) {
		throw new Error(
			"There is no recording loaded in the editor, so there is nothing to preview.",
		);
	}
	const sourceDurationMs = Math.round(duration * 1000);
	const plan = planPreview(payload, {
		clipRegions: timeline.clipRegions,
		durationMs: getTimelineDurationMs(timeline.clipRegions, sourceDurationMs),
	});
	if (rendering) {
		throw new Error("A preview is already rendering. Wait for it to finish, then try again.");
	}
	rendering = true;
	let video: HTMLVideoElement | null = null;
	let renderer: Awaited<ReturnType<typeof createRenderer>> | null = null;
	try {
		video = document.createElement("video");
		const url = await withTimeout(
			resolveVideoUrl(videoSourcePath),
			LOAD_TIMEOUT_MS,
			"a playable URL for the recording",
		);
		video.muted = true;
		video.preload = "auto";
		const loaded = settleVideo(video, "loadeddata", "the recording to open for decoding");
		video.src = url;
		await loaded;
		context.assertSameRecording();
		if (!(video.videoWidth > 0 && video.videoHeight > 0)) {
			throw new Error("The recording reports no picture size, so it cannot be composited.");
		}
		const previewSize = previewPixelSize();
		const native = calculateMp4SourceDimensions(
			video.videoWidth,
			video.videoHeight,
			"native",
			appearance.cropRegion,
		);
		const cap = plan.frames.length > 1 ? MAX_TILE_WIDTH : MAX_SINGLE_WIDTH;
		const scale = Math.min(1, cap / native.width);
		const tileWidth = even(native.width * scale);
		const tileHeight = even(native.height * scale);
		renderer = await createRenderer({
			context,
			tileWidth,
			tileHeight,
			video,
			previewWidth: previewSize.width,
			previewHeight: previewSize.height,
		});
		const sheet = document.createElement("canvas");
		sheet.width = plan.cols * tileWidth + (plan.cols - 1) * TILE_GAP;
		sheet.height = plan.rows * tileHeight + (plan.rows - 1) * TILE_GAP;
		const sheetCtx = sheet.getContext("2d");
		if (!sheetCtx) throw new Error("This window cannot open a 2D canvas for the preview.");
		const lastSeekMs = Math.max(0, sourceDurationMs - END_FRAME_BACKOFF_MS);
		const drawn: PreviewFrame[] = [];
		const deadline = Date.now() + TOTAL_BUDGET_MS;
		let budgetNote: string | undefined;
		for (const [index, frame] of plan.frames.entries()) {
			if (drawn.length >= MIN_PREVIEW_FRAMES && Date.now() > deadline) {
				budgetNote = `Only the first ${drawn.length} of ${plan.frames.length} frames were composited: the ${TOTAL_BUDGET_MS / 1000} second budget ran out. Ask for fewer frames, or one atMs at a time.`;
				break;
			}
			context.assertSameRecording();
			const seekMs = Math.min(frame.sourceMs, lastSeekMs);
			const seeked = settleVideo(
				video,
				"seeked",
				`the recording to seek to ${Math.round(seekMs)} ms`,
			);
			video.currentTime = seekMs / 1000;
			await seeked;
			await renderer.draw(frame, seekMs);
			sheetCtx.drawImage(
				renderer.canvas(),
				(index % plan.cols) * (tileWidth + TILE_GAP),
				Math.floor(index / plan.cols) * (tileHeight + TILE_GAP),
				tileWidth,
				tileHeight,
			);
			drawn.push(frame);
		}
		const dataUrl = sheet.toDataURL("image/jpeg", JPEG_QUALITY);
		const comma = dataUrl.indexOf(",");
		if (comma < 0) throw new Error("The preview canvas returned no image.");
		return {
			image: {
				data: dataUrl.slice(comma + 1),
				mimeType: "image/jpeg" as const,
				width: sheet.width,
				height: sheet.height,
			},
			cols: plan.cols,
			rows: plan.rows,
			frames: drawn,
			...(plan.skippedAtMs.length > 0 && { skippedAtMs: plan.skippedAtMs }),
			rendered: renderer.rendered,
			notRendered: renderer.notRendered,
			note: [
				`This is the export pipeline's own composite at ${tileWidth}x${tileHeight} per frame, not the recorded screen.`,
				`It uses the recording's native aspect ratio and the legacy export renderer, so an export set to another aspect ratio or to the modern pipeline can frame things differently.`,
				previewSize.measured
					? undefined
					: `The editor preview could not be measured, so caption and cursor sizes were scaled against ${FALLBACK_PREVIEW_WIDTH}x${FALLBACK_PREVIEW_HEIGHT}, as a headless export would.`,
				budgetNote,
			]
				.filter(Boolean)
				.join(" "),
		};
	} finally {
		rendering = false;
		release(() => renderer?.destroy());
		release(() => {
			video?.removeAttribute("src");
			video?.load();
		});
	}
}

function release(step: () => void) {
	try {
		step();
	} catch (error) {
		console.warn("[render_preview] a preview resource could not be released", error);
	}
}

async function createRenderer({
	context,
	tileWidth,
	tileHeight,
	video,
	previewWidth,
	previewHeight,
}: {
	context: EditorOpContext;
	tileWidth: number;
	tileHeight: number;
	video: HTMLVideoElement;
	previewWidth: number;
	previewHeight: number;
}) {
	const { timeline, appearance } = context;
	const rendered = ["clips and speed", "look", "zooms", "webcam"];
	const notRendered: string[] = [];
	const { preloadCursorAssets } = await import("../../videoPlayback/cursorRenderer");
	let cursorAssets = true;
	try {
		await withTimeout(preloadCursorAssets(), INIT_TIMEOUT_MS, "the cursor artwork to load");
	} catch (error) {
		cursorAssets = false;
		notRendered.push(
			`cursor: its artwork could not be loaded here (${error instanceof Error ? error.message : String(error)}), so no cursor is drawn even though the export draws one`,
		);
	}
	if (cursorAssets) {
		if (!appearance.showCursor) notRendered.push("cursor: it is turned off for this export");
		else if ((timeline.cursorTelemetry ?? []).length === 0) {
			notRendered.push("cursor: this recording carries no cursor telemetry");
		} else rendered.push("cursor");
	}
	if (timeline.annotationRegions.length > 0) rendered.push("annotations");
	if (timeline.autoCaptions.length > 0) {
		if (timeline.autoCaptionSettings?.enabled) rendered.push("captions");
		else notRendered.push("captions: they are turned off in the caption settings");
	}
	const { FrameRenderer } = await import("@/lib/exporter/frameRenderer");
	const renderer = new FrameRenderer({
		...buildExportRenderOptions({
			appearance,
			timeline,
			effectiveSpeedRegions: timeline.speedRegions,
			effectiveZoomRegions: timeline.zoomRegions,
			effectiveCursorTelemetry: timeline.cursorTelemetry ?? [],
			effectiveShowCursor: appearance.showCursor,
			previewWidth,
			previewHeight,
			shadowIntensity: appearance.shadowIntensity,
			onProgress: () => undefined,
		}),
		timelineEffects: true,
		width: tileWidth,
		height: tileHeight,
		videoWidth: video.videoWidth,
		videoHeight: video.videoHeight,
	});
	await withTimeout(
		renderer.initialize(),
		INIT_TIMEOUT_MS,
		"the export renderer to start up (it needs a GPU context)",
	);
	return {
		rendered,
		notRendered,
		canvas: () => renderer.getCanvas(),
		destroy: () => renderer.destroy(),
		draw: async (frame: PreviewFrame, seekMs: number) => {
			const videoFrame = new VideoFrame(video, { timestamp: seekMs * 1000 });
			try {
				await withTimeout(
					renderer.renderFrame(
						videoFrame,
						seekMs * 1000,
						seekMs * 1000,
						undefined,
						frame.atMs * 1000,
					),
					RENDER_TIMEOUT_MS,
					`the export renderer to composite the frame at ${Math.round(frame.atMs)} ms`,
				);
			} finally {
				videoFrame.close();
			}
		},
	};
}

export const previewOps: EditorOpMap = {
	render_preview: renderPreview,
};
