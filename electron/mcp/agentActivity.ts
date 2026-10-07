import fs from "node:fs/promises";
import { clamp, getCursorCaptureElapsedMs } from "../ipc/cursor/telemetry";
import { MAX_CHANGE_TIMES } from "../ipc/ffmpeg/changeTimes";
import { isCursorCaptureActive } from "../ipc/state";
import { getAgentActivityPathForVideo, parseJsonWithByteOrderMark } from "../ipc/utils";

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
	changeTimesMs?: number[];
}

const KINDS = new Set<unknown>(["motion", "hold", "wait"]);
const ACTIONS = new Set<unknown>([
	"move",
	"click",
	"drag",
	"scroll",
	"type",
	"key",
	"wait",
	"raise",
]);

let scenes: AgentActivityScene[] = [];
let spans: AgentActivitySpan[] = [];
let frozen = false;

export function resetAgentActivity() {
	scenes = [];
	spans = [];
	frozen = false;
}

export function getAgentActivityMs(): number | null {
	return isCursorCaptureActive && !frozen ? getCursorCaptureElapsedMs() : null;
}

function open<T extends { startMs: number; endMs: number }>(
	list: T[],
	entry: Omit<T, "startMs" | "endMs">,
) {
	const startMs = getAgentActivityMs();
	if (startMs === null) return null;
	const opened = { ...entry, startMs, endMs: Number.POSITIVE_INFINITY } as T;
	list.push(opened);
	return opened;
}

function close<T extends { endMs: number }>(entry: T | null, fields: Partial<T> = {}) {
	const endMs = getAgentActivityMs();
	if (entry && endMs !== null && entry.endMs === Number.POSITIVE_INFINITY) {
		Object.assign(entry, fields, { endMs });
	}
}

export function beginScene(title?: string) {
	const scene = open<AgentActivityScene>(scenes, { failed: false, ...(title ? { title } : {}) });
	return (failed: boolean) => close(scene, { failed });
}

export function beginSpan(
	kind: AgentActivitySpanKind,
	action: AgentActivityAction,
	target?: AgentActivityTarget,
) {
	const span = open<AgentActivitySpan>(spans, { kind, action, ...(target ? { target } : {}) });
	return () => close(span);
}

function clampTimes<T extends { startMs: number; endMs: number }>(entries: T[], stopMs: number) {
	return entries
		.map((entry) => ({
			...entry,
			startMs: clamp(entry.startMs, 0, stopMs),
			endMs: clamp(entry.endMs, 0, stopMs),
		}))
		.filter((entry) => entry.endMs > entry.startMs);
}

export function snapshotAgentActivity(stopMs: number): AgentActivityLog {
	if (!frozen) {
		scenes = clampTimes(scenes, Math.max(0, stopMs));
		spans = clampTimes(spans, Math.max(0, stopMs));
		frozen = true;
	}
	return { version: 1, scenes, spans };
}

export async function persistAgentActivity(
	videoPath: string,
	readChangeTimesMs?: () => Promise<number[] | null>,
) {
	const log: AgentActivityLog = { version: 1, scenes, spans };
	scenes = [];
	spans = [];
	if (log.scenes.length === 0 && log.spans.length === 0) return;
	if (readChangeTimesMs) {
		try {
			const changeTimesMs = await readChangeTimesMs();
			if (changeTimesMs && changeTimesMs.length > 0) log.changeTimesMs = changeTimesMs;
		} catch (error) {
			console.warn("[agent-activity] Failed to extract screen change times:", error);
		}
	}
	await fs.writeFile(
		getAgentActivityPathForVideo(videoPath),
		JSON.stringify(log, null, 2),
		"utf-8",
	);
}

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

function normalizeTimes(raw: unknown) {
	const entry = raw as { startMs?: unknown; endMs?: unknown } | null;
	if (!entry || typeof entry !== "object") return null;
	if (!isFiniteNumber(entry.startMs) || !isFiniteNumber(entry.endMs)) return null;
	const startMs = Math.max(0, entry.startMs);
	const endMs = Math.max(0, entry.endMs);
	return endMs > startMs ? { startMs, endMs } : null;
}

function normalizeTarget(raw: unknown): AgentActivityTarget | undefined {
	const target = raw as Partial<Record<keyof AgentActivityTarget, unknown>> | null;
	if (!target || !isFiniteNumber(target.cx) || !isFiniteNumber(target.cy)) return undefined;
	return {
		cx: clamp(target.cx, 0, 1),
		cy: clamp(target.cy, 0, 1),
		...(isFiniteNumber(target.width) ? { width: clamp(target.width, 0, 1) } : {}),
		...(isFiniteNumber(target.height) ? { height: clamp(target.height, 0, 1) } : {}),
	};
}

const byStart = (a: { startMs: number }, b: { startMs: number }) => a.startMs - b.startMs;

function normalizeChangeTimes(raw: unknown): number[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const sorted = raw
		.filter(isFiniteNumber)
		.map((timeMs) => Math.max(0, Math.round(timeMs)))
		.sort((a, b) => a - b);
	const times = sorted
		.filter((timeMs, index) => index === 0 || timeMs !== sorted[index - 1])
		.slice(0, MAX_CHANGE_TIMES);
	return times.length > 0 ? times : undefined;
}

export function normalizeAgentActivityLog(raw: unknown): AgentActivityLog | null {
	const log = raw as {
		version?: unknown;
		scenes?: unknown;
		spans?: unknown;
		changeTimesMs?: unknown;
	} | null;
	if (!log || log.version !== 1) return null;
	const rawScenes: unknown[] = Array.isArray(log.scenes) ? log.scenes : [];
	const rawSpans: unknown[] = Array.isArray(log.spans) ? log.spans : [];
	const changeTimesMs = normalizeChangeTimes(log.changeTimesMs);
	return {
		version: 1,
		...(changeTimesMs ? { changeTimesMs } : {}),
		scenes: rawScenes
			.flatMap((raw) => {
				const times = normalizeTimes(raw);
				if (!times) return [];
				const { failed, title } = raw as { failed?: unknown; title?: unknown };
				return [
					{
						...times,
						failed: failed === true,
						...(typeof title === "string" && title ? { title } : {}),
					},
				];
			})
			.sort(byStart),
		spans: rawSpans
			.flatMap((raw) => {
				const times = normalizeTimes(raw);
				if (!times) return [];
				const { kind, action, target } = raw as Record<string, unknown>;
				if (!KINDS.has(kind) || !ACTIONS.has(action)) return [];
				const normalizedTarget = normalizeTarget(target);
				return [
					{
						kind: kind as AgentActivitySpanKind,
						action: action as AgentActivityAction,
						...times,
						...(normalizedTarget ? { target: normalizedTarget } : {}),
					},
				];
			})
			.sort(byStart),
	};
}

export async function readAgentActivity(videoPath: string) {
	try {
		const content = await fs.readFile(getAgentActivityPathForVideo(videoPath), "utf-8");
		return normalizeAgentActivityLog(parseJsonWithByteOrderMark<unknown>(content));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
