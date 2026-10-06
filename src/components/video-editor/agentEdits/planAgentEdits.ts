import { MIN_FRESH_RECORDING_AUTO_ZOOM_SOURCE_ASPECT_RATIO } from "../timeline/zoomSuggestionUtils";
import { clampFocusToDepth, type ZoomDepth, type ZoomFocus } from "../types";

export type AgentActivitySpanKind = "motion" | "hold" | "wait";
export type AgentActivityAction =
	| "move"
	| "click"
	| "drag"
	| "scroll"
	| "type"
	| "key"
	| "wait"
	| "raise";

export interface AgentActivityTarget {
	cx: number;
	cy: number;
	width?: number;
	height?: number;
}

export interface AgentActivitySpan {
	kind: AgentActivitySpanKind;
	action: AgentActivityAction;
	startMs: number;
	endMs: number;
	target?: AgentActivityTarget;
}

export interface AgentActivityScene {
	startMs: number;
	endMs: number;
	failed: boolean;
	title?: string;
}

export interface AgentActivityLog {
	version: 1;
	scenes: AgentActivityScene[];
	spans: AgentActivitySpan[];
}

export interface AgentEditPlan {
	keepRanges: { startMs: number; endMs: number }[];
	zooms: { startMs: number; endMs: number; depth: ZoomDepth; focus: ZoomFocus }[];
	captions: { startMs: number; endMs: number; text: string }[];
}

export const MOTION_LEAD_MS = 300;
export const MOTION_TAIL_MS = 400;
export const WAIT_KEEP_HEAD_MS = 500;
export const WAIT_KEEP_TAIL_MS = 300;
export const KEEP_MERGE_GAP_MS = 600;
export const FINAL_TAIL_MS = 1200;
export const MIN_TOTAL_CUT_MS = 500;
export const ZOOM_MAX_AFTER_ACTION_MS = 3000;
export const ZOOM_MIN_DURATION_MS = 1200;
export const TYPE_INHERITS_CLICK_WITHIN_MS = 2000;
export const ZOOM_SMALL_TARGET_MAX_WIDTH = 0.15;
export const ZOOM_MEDIUM_TARGET_MAX_WIDTH = 0.35;
export const SMALL_TARGET_ZOOM_DEPTH: ZoomDepth = 3;
export const MEDIUM_TARGET_ZOOM_DEPTH: ZoomDepth = 2;
export const ZOOM_MERGE_GAP_MS = 1350;
export const ZOOM_MERGE_FOCUS_DISTANCE = 0.25;
export const ZOOM_MIN_PIECE_MS = 600;
export const CAPTION_DURATION_MS = 2500;
export const CAPTION_MAX_CHARS = 80;

type TimeRange = AgentEditPlan["keepRanges"][number];
type ZoomPlan = AgentEditPlan["zooms"][number];
type ZoomLook = Pick<ZoomPlan, "depth" | "focus">;

const SPAN_KINDS = new Set<AgentActivitySpanKind>(["motion", "hold", "wait"]);

function normalizeTimed<T extends TimeRange>(items: readonly T[] | undefined, durationMs: number) {
	return (Array.isArray(items) ? items : [])
		.filter(
			(item) =>
				item &&
				Number.isFinite(item.startMs) &&
				Number.isFinite(item.endMs) &&
				item.endMs >= item.startMs,
		)
		.map((item) => ({
			...item,
			startMs: Math.max(0, Math.round(item.startMs)),
			endMs: Math.min(durationMs, Math.round(item.endMs)),
		}))
		.filter((item) => item.startMs < durationMs && item.endMs >= item.startMs)
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function mergeRanges(ranges: TimeRange[], durationMs: number): TimeRange[] {
	const merged: TimeRange[] = [];
	const clamped = ranges
		.map((range) => ({
			startMs: Math.max(0, range.startMs),
			endMs: Math.min(durationMs, range.endMs),
		}))
		.filter((range) => range.endMs > range.startMs)
		.sort((a, b) => a.startMs - b.startMs);
	for (const range of clamped) {
		const last = merged[merged.length - 1];
		if (last && range.startMs - last.endMs < KEEP_MERGE_GAP_MS) {
			last.endMs = Math.max(last.endMs, range.endMs);
		} else {
			merged.push(range);
		}
	}
	return merged;
}

function subtractRange(ranges: TimeRange[], cut: TimeRange): TimeRange[] {
	return ranges.flatMap((range) => {
		if (cut.endMs <= range.startMs || cut.startMs >= range.endMs) return [range];
		const pieces: TimeRange[] = [];
		if (cut.startMs > range.startMs)
			pieces.push({ startMs: range.startMs, endMs: cut.startMs });
		if (cut.endMs < range.endMs) pieces.push({ startMs: cut.endMs, endMs: range.endMs });
		return pieces;
	});
}

function keptMsBetween(startMs: number, endMs: number, keepRanges: TimeRange[]): number {
	return keepRanges.reduce(
		(sum, range) =>
			sum + Math.max(0, Math.min(endMs, range.endMs) - Math.max(startMs, range.startMs)),
		0,
	);
}

function zoomLookForTarget(target: AgentActivityTarget | undefined): ZoomLook | null {
	if (!target || !Number.isFinite(target.cx) || !Number.isFinite(target.cy)) return null;
	const width = Number.isFinite(target.width) ? Number(target.width) : 0;
	if (width >= ZOOM_MEDIUM_TARGET_MAX_WIDTH) return null;
	const depth =
		width >= ZOOM_SMALL_TARGET_MAX_WIDTH ? MEDIUM_TARGET_ZOOM_DEPTH : SMALL_TARGET_ZOOM_DEPTH;
	return { depth, focus: clampFocusToDepth(target, depth) };
}

function planZooms(spans: AgentActivitySpan[], keepRanges: TimeRange[]): ZoomPlan[] {
	const candidates: ZoomPlan[] = [];
	let lastClick: { endMs: number; look: ZoomLook | null } | null = null;
	for (let index = 0; index < spans.length; index += 1) {
		const span = spans[index];
		if (span.kind !== "motion") continue;
		let look: ZoomLook | null = null;
		if (span.action === "click") {
			look = zoomLookForTarget(span.target);
			lastClick = { endMs: span.endMs, look };
		} else if (
			span.action === "type" &&
			lastClick &&
			span.startMs - lastClick.endMs <= TYPE_INHERITS_CLICK_WITHIN_MS
		) {
			look = lastClick.look;
		}
		if (!look) continue;
		const next = spans[index + 1];
		const followEndMs = !next
			? Number.POSITIVE_INFINITY
			: next.kind === "motion"
				? next.startMs
				: next.endMs;
		const endMs = Math.max(
			span.startMs + ZOOM_MIN_DURATION_MS,
			Math.min(followEndMs, span.endMs + ZOOM_MAX_AFTER_ACTION_MS),
		);
		candidates.push({ startMs: span.startMs, endMs, ...look });
	}

	const merged: ZoomPlan[] = [];
	for (const zoom of candidates) {
		const prev = merged[merged.length - 1];
		if (
			prev &&
			keptMsBetween(prev.endMs, zoom.startMs, keepRanges) < ZOOM_MERGE_GAP_MS &&
			Math.hypot(prev.focus.cx - zoom.focus.cx, prev.focus.cy - zoom.focus.cy) <
				ZOOM_MERGE_FOCUS_DISTANCE
		) {
			prev.endMs = Math.max(prev.endMs, zoom.endMs);
			continue;
		}
		if (prev) prev.endMs = Math.min(prev.endMs, zoom.startMs);
		merged.push({ ...zoom });
	}

	return merged.flatMap((zoom) =>
		keepRanges.flatMap((range) => {
			const startMs = Math.max(zoom.startMs, range.startMs);
			const endMs = Math.min(zoom.endMs, range.endMs);
			return endMs - startMs >= ZOOM_MIN_PIECE_MS ? [{ ...zoom, startMs, endMs }] : [];
		}),
	);
}

function planCaptions(
	scenes: AgentActivityScene[],
	keepRanges: TimeRange[],
): AgentEditPlan["captions"] {
	const captions: AgentEditPlan["captions"] = [];
	for (const scene of scenes) {
		const title = typeof scene.title === "string" ? scene.title.trim() : "";
		const text = Array.from(title).slice(0, CAPTION_MAX_CHARS).join("").trim();
		if (scene.failed || !text) continue;
		const range = keepRanges.find((candidate) => candidate.endMs > scene.startMs);
		if (!range || range.startMs >= scene.endMs) continue;
		const startMs =
			range.startMs >= scene.startMs - MOTION_LEAD_MS ? range.startMs : scene.startMs;
		const prev = captions[captions.length - 1];
		if (prev) prev.endMs = Math.min(prev.endMs, startMs);
		captions.push({
			startMs,
			endMs: Math.min(range.endMs, startMs + CAPTION_DURATION_MS),
			text,
		});
	}
	return captions.filter((caption) => caption.endMs > caption.startMs);
}

export function planAgentEdits(
	log: AgentActivityLog | null | undefined,
	durationMs: number,
	sourceAspect: number,
): AgentEditPlan | null {
	if (!log || log.version !== 1 || !Number.isFinite(durationMs) || durationMs <= 0) return null;

	const scenes = normalizeTimed(log.scenes, durationMs);
	const failedCuts = scenes.flatMap((scene) => {
		if (!scene.failed) return [];
		const next = scenes.find((other) => other.startMs > scene.startMs);
		const endMs = !next
			? durationMs
			: next.failed
				? next.startMs
				: Math.min(next.startMs, Math.max(scene.endMs, next.startMs - MOTION_LEAD_MS));
		return [{ startMs: scene.startMs, endMs }];
	});
	const spans = normalizeTimed(log.spans, durationMs).filter(
		(span) =>
			SPAN_KINDS.has(span.kind) &&
			!failedCuts.some((cut) => span.startMs >= cut.startMs && span.startMs < cut.endMs),
	);
	if (spans.length === 0) return null;

	const pieces = spans.flatMap((span): TimeRange[] => {
		if (span.kind !== "wait") {
			return [{ startMs: span.startMs - MOTION_LEAD_MS, endMs: span.endMs + MOTION_TAIL_MS }];
		}
		if (span.endMs - span.startMs < WAIT_KEEP_HEAD_MS + WAIT_KEEP_TAIL_MS) {
			return [{ startMs: span.startMs, endMs: span.endMs }];
		}
		return [
			{ startMs: span.startMs, endMs: span.startMs + WAIT_KEEP_HEAD_MS },
			{ startMs: span.endMs - WAIT_KEEP_TAIL_MS, endMs: span.endMs },
		];
	});
	const lastEndMs = spans.reduce((max, span) => Math.max(max, span.endMs), 0);
	pieces.push({ startMs: lastEndMs, endMs: lastEndMs + FINAL_TAIL_MS });
	const keepRanges = failedCuts.reduce(subtractRange, mergeRanges(pieces, durationMs));
	if (keepRanges.length === 0) return null;

	const zooms =
		sourceAspect < MIN_FRESH_RECORDING_AUTO_ZOOM_SOURCE_ASPECT_RATIO
			? []
			: planZooms(spans, keepRanges);
	const captions = planCaptions(scenes, keepRanges);
	const keptMs = keepRanges.reduce((sum, range) => sum + range.endMs - range.startMs, 0);
	if (durationMs - keptMs < MIN_TOTAL_CUT_MS && zooms.length === 0 && captions.length === 0) {
		return null;
	}
	return { keepRanges, zooms, captions };
}
