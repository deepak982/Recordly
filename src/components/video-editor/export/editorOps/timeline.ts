import {
	type AgentActivityLog,
	holdKeepMs,
	MIN_SHOT_MS,
	MOTION_LEAD_MS,
	MOTION_TAIL_MS,
	QUIET_RADIUS_MS,
	RAMP_MAX_SPEED,
	WAIT_KEEP_TAIL_MS,
} from "../../agentEdits/planAgentEdits";
import {
	packClipSequence,
	reorderClipSequence,
	rippleRegionAnchors,
	rippleRegions,
} from "../../clipSequence";
import { changeClipSpan } from "../../clipSpanChange";
import { planClipSplit } from "../../clipSplit";
import {
	type ClipRegion,
	getClipSourceEndMs,
	getClipSourceStartMs,
	getTimelineDurationMs,
	mapSourceTimeToTimelineTime,
	SPEED_OPTIONS,
	sortClipRegions,
} from "../../types";
import {
	type EditorOpContext,
	type EditorOpMap,
	nextId,
	requireFiniteNumber,
	requireObject,
} from "./types";

type Range = { startMs: number; endMs: number };

const ACTIVITY_TIMEOUT_MS = 10_000;
const ALLOWED_SPEEDS = [1, ...SPEED_OPTIONS.map((option) => option.speed)];
const NO_CLIPS =
	"The timeline has no clips yet. Wait for the recording to finish loading, then try again.";

function loadClips(context: EditorOpContext) {
	const clips = sortClipRegions(context.timeline.clipRegions);
	if (clips.length === 0) throw new Error(NO_CLIPS);
	const sourceMs = Math.round(context.duration * 1000);
	return { clips, sourceMs, totalMs: getTimelineDurationMs(clips, sourceMs) };
}

function requireTimelineTime(value: unknown, field: string, totalMs: number): number {
	const time = Math.round(requireFiniteNumber(value, field));
	if (time < 0 || time > totalMs) {
		throw new Error(
			`${field} is ${time} ms, outside the edit. Times are timeline milliseconds, from 0 to ${totalMs}.`,
		);
	}
	return time;
}

function requireTimelineSpan(payload: Record<string, unknown>, totalMs: number): Range {
	const startMs = requireTimelineTime(payload.startMs, "startMs", totalMs);
	const endMs = requireTimelineTime(payload.endMs, "endMs", totalMs);
	if (endMs <= startMs) {
		throw new Error(
			`endMs (${endMs}) must be after startMs (${startMs}). Times are timeline milliseconds.`,
		);
	}
	return { startMs, endMs };
}

function requireIndex(value: unknown, field: string, length: number): number {
	const index = requireFiniteNumber(value, field);
	if (!Number.isInteger(index) || index < 0 || index >= length) {
		throw new Error(
			`${field} must be a whole number from 0 to ${length - 1}, in timeline order; the edit has ${length} clip${length === 1 ? "" : "s"}.`,
		);
	}
	return index;
}

function clipIndexFor(payload: Record<string, unknown>, clips: ClipRegion[], op: string) {
	if (payload.clipIndex === undefined) {
		if (clips.length > 1) {
			throw new Error(
				`${op} needs clipIndex because the edit has ${clips.length} clips, numbered from 0 in timeline order.`,
			);
		}
		return 0;
	}
	return requireIndex(payload.clipIndex, "clipIndex", clips.length);
}

function idFactory(context: EditorOpContext) {
	return () => nextId(context.ids.clip, "clip");
}

function splitAt(clips: ClipRegion[], timeMs: number, createId: () => string): ClipRegion[] {
	const plan = planClipSplit({ clipRegions: clips, splitMs: timeMs, createId });
	if (!plan) return clips;
	return clips.flatMap((clip) => (clip.id === plan.targetId ? [plan.left, plan.right] : [clip]));
}

function applySequence(context: EditorOpContext, before: ClipRegion[], edited: ClipRegion[]) {
	const { timeline } = context;
	const next = packClipSequence(edited);
	timeline.setClipRegions(next);
	timeline.setZoomRegions((current) => rippleRegions(current, before, next));
	timeline.setAnnotationRegions((current) => rippleRegions(current, before, next));
	timeline.setAudioRegions((current) => rippleRegionAnchors(current, before, next));
	if (timeline.selectedClipId && !next.some((clip) => clip.id === timeline.selectedClipId)) {
		timeline.setSelectedClipId(null);
	}
	return {
		changed: true,
		durationMs: getTimelineDurationMs(next, Math.round(context.duration * 1000)),
		clipCount: next.length,
	};
}

function unchanged(totalMs: number, reason: string) {
	return { changed: false, durationMs: totalMs, note: reason };
}

function safeSpeed(clip: ClipRegion) {
	return Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
}

function retime(clip: ClipRegion, speed: number): ClipRegion {
	return {
		...clip,
		sourceStartMs: getClipSourceStartMs(clip),
		speed,
		endMs:
			clip.startMs +
			Math.max(1, Math.round(((clip.endMs - clip.startMs) * safeSpeed(clip)) / speed)),
	};
}

function subtract(ranges: Range[], cut: Range): Range[] {
	return ranges.flatMap((range) => {
		if (cut.endMs <= range.startMs || cut.startMs >= range.endMs) return [range];
		const pieces: Range[] = [];
		if (cut.startMs > range.startMs) pieces.push({ ...range, endMs: cut.startMs });
		if (cut.endMs < range.endMs) pieces.push({ ...range, startMs: cut.endMs });
		return pieces;
	});
}

/** Source-time stretches the planner would shorten: hold/wait interiors, minus motion lead/tail and screen changes. */
export function findIdleRanges(log: AgentActivityLog, sourceMs: number): Range[] {
	const spans = log.spans
		.filter((span) => Number.isFinite(span.startMs) && Number.isFinite(span.endMs))
		.sort((a, b) => a.startMs - b.startMs);
	const protectedRanges: Range[] = [
		...spans
			.filter((span) => span.kind === "motion")
			.map((span) => ({
				startMs: span.startMs - MOTION_LEAD_MS,
				endMs: span.endMs + MOTION_TAIL_MS,
			})),
		...(log.changeTimesMs ?? [])
			.filter(Number.isFinite)
			.map((time) => ({ startMs: time - QUIET_RADIUS_MS, endMs: time + QUIET_RADIUS_MS })),
	];
	const interiors = spans.flatMap((span, index): Range[] =>
		span.kind === "motion"
			? []
			: [
					{
						startMs: Math.max(
							0,
							span.startMs + holdKeepMs(span, spans[index - 1]) - WAIT_KEEP_TAIL_MS,
						),
						endMs: Math.min(sourceMs, span.endMs - WAIT_KEEP_TAIL_MS),
					},
				],
	);
	return protectedRanges
		.reduce((ranges, cut) => subtract(ranges, cut), interiors)
		.filter((range) => range.endMs - range.startMs >= MIN_SHOT_MS)
		.map(({ startMs, endMs }) => ({ startMs: Math.round(startMs), endMs: Math.round(endMs) }));
}

async function loadActivity(context: EditorOpContext, op: string) {
	const advice = `Use timeline.speed or timeline.remove with explicit times instead of ${op}.`;
	if (!context.videoSourcePath) throw new Error(`There is no recording loaded. ${advice}`);
	const fetch = window.electronAPI?.getAgentActivity;
	if (!fetch) throw new Error(`The activity log is unavailable here. ${advice}`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			fetch(context.videoSourcePath),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`Timed out after ${ACTIVITY_TIMEOUT_MS / 1000} seconds waiting for the recording's activity log.`,
							),
						),
					ACTIVITY_TIMEOUT_MS,
				);
			}),
		]);
		if (!result.success || !result.log || result.log.version !== 1) {
			throw new Error(
				`${result.message ?? result.error ?? "This recording has no agent activity log, so idle stretches cannot be told from action."} ${advice}`,
			);
		}
		return result.log;
	} finally {
		clearTimeout(timer);
	}
}

function clipsWithin(clips: ClipRegion[], range: Range): number {
	return Math.round(
		clips.reduce((sum, clip) => {
			const start = Math.max(getClipSourceStartMs(clip), range.startMs);
			const end = Math.min(getClipSourceEndMs(clip), range.endMs);
			return sum + Math.max(0, end - start) / safeSpeed(clip);
		}, 0),
	);
}

function compressIdle(
	context: EditorOpContext,
	clips: ClipRegion[],
	idle: Range[],
	reduceMs: number,
	label: string,
) {
	const createId = idFactory(context);
	const split = idle.reduce(
		(current, range) =>
			[range.startMs, range.endMs].reduce(
				(inner, time) => splitAt(inner, mapSourceTimeToTimelineTime(time, inner), createId),
				current,
			),
		clips,
	);
	const isIdle = (clip: ClipRegion) => {
		const mid = (getClipSourceStartMs(clip) + getClipSourceEndMs(clip)) / 2;
		return idle.some((range) => mid >= range.startMs && mid < range.endMs);
	};
	const slots = split.filter(isIdle).map((clip) => {
		const duration = clip.endMs - clip.startMs;
		const sourceLength = duration * safeSpeed(clip);
		const fastest =
			safeSpeed(clip) >= RAMP_MAX_SPEED ? duration : sourceLength / RAMP_MAX_SPEED;
		return { clip, duration, sourceLength, fastest };
	});
	const capacityMs = slots.reduce((sum, slot) => sum + slot.duration, 0);
	if (reduceMs > capacityMs) {
		throw new Error(
			`${label} cannot be reached without cutting into action: speeding up and trimming every idle stretch removes at most ${capacityMs} ms, which is ${reduceMs - capacityMs} ms short. Nothing was changed. Ask for ${reduceMs - capacityMs} ms more, or cut action explicitly with timeline.remove. Times are timeline milliseconds.`,
		);
	}
	const speedCapacity = slots.reduce((sum, slot) => sum + slot.duration - slot.fastest, 0);
	const fastestTotal = capacityMs - speedCapacity;
	const speedOnly = reduceMs <= speedCapacity;
	const durations = slots.map((slot) =>
		Math.round(
			speedOnly
				? slot.duration - (reduceMs * (slot.duration - slot.fastest)) / speedCapacity
				: slot.fastest * (1 - (reduceMs - speedCapacity) / fastestTotal),
		),
	);
	const residual = capacityMs - reduceMs - durations.reduce((sum, value) => sum + value, 0);
	const widest = durations.indexOf(Math.max(...durations));
	if (residual !== 0 && widest >= 0) {
		durations[widest] = Math.max(
			0,
			Math.min(slots[widest].duration, durations[widest] + residual),
		);
	}
	const replacements = new Map<string, ClipRegion | null>();
	slots.forEach((slot, index) => {
		const duration = durations[index];
		if (duration === slot.duration) return;
		if (duration <= 0) {
			replacements.set(slot.clip.id, null);
			return;
		}
		const speed = speedOnly
			? slot.sourceLength / duration
			: Math.max(safeSpeed(slot.clip), RAMP_MAX_SPEED);
		replacements.set(slot.clip.id, {
			...slot.clip,
			sourceStartMs: getClipSourceStartMs(slot.clip),
			speed,
			endMs: slot.clip.startMs + duration,
		});
	});
	const edited = split.flatMap((clip) => {
		const replacement = replacements.get(clip.id);
		return replacement === undefined ? [clip] : replacement ? [replacement] : [];
	});
	return { ...applySequence(context, split, edited), idleStretches: slots.length };
}

function sceneAt(log: AgentActivityLog, index: unknown) {
	const scenes = [...log.scenes].sort((a, b) => a.startMs - b.startMs);
	if (scenes.length === 0) {
		throw new Error(
			"This recording's activity log has no scenes. Use timeline.fit to hit a total length, or timeline.speed for one clip.",
		);
	}
	const at = requireFiniteNumber(index, "index");
	if (!Number.isInteger(at) || at < 0 || at >= scenes.length) {
		throw new Error(
			`index must be a whole number from 0 to ${scenes.length - 1}; the recording has ${scenes.length} scene${scenes.length === 1 ? "" : "s"}.`,
		);
	}
	return scenes[at];
}

function clampRanges(ranges: Range[], bounds: Range): Range[] {
	return ranges.flatMap((range) => {
		const startMs = Math.max(range.startMs, bounds.startMs);
		const endMs = Math.min(range.endMs, bounds.endMs);
		return endMs - startMs >= MIN_SHOT_MS ? [{ startMs, endMs }] : [];
	});
}

export const timelineOps: EditorOpMap = {
	"timeline.trim": (payload, context) => {
		const args = requireObject(payload, "timeline.trim");
		const { clips, totalMs, sourceMs } = loadClips(context);
		const span = requireTimelineSpan(args, totalMs);
		if (args.clipIndex === undefined) {
			if (span.startMs === 0 && span.endMs === totalMs) {
				return unchanged(totalMs, "The edit already spans exactly that range.");
			}
			const createId = idFactory(context);
			const split = splitAt(splitAt(clips, span.startMs, createId), span.endMs, createId);
			const kept = split.filter(
				(clip) => clip.startMs >= span.startMs && clip.endMs <= span.endMs,
			);
			if (kept.length === 0) {
				throw new Error(
					`No footage lies between ${span.startMs} and ${span.endMs} ms (timeline milliseconds), so there is nothing to keep.`,
				);
			}
			return applySequence(context, split, kept);
		}
		const index = requireIndex(args.clipIndex, "clipIndex", clips.length);
		const clip = clips[index];
		if (span.startMs < clip.startMs || span.endMs > clip.endMs) {
			throw new Error(
				`Clip ${index} covers ${clip.startMs} to ${clip.endMs} ms (timeline milliseconds); the span to keep must lie inside it. Trimming only shortens a clip.`,
			);
		}
		if (span.startMs === clip.startMs && span.endMs === clip.endMs) {
			return unchanged(totalMs, `Clip ${index} already spans exactly that range.`);
		}
		const trimmed = changeClipSpan(clip, span.startMs, span.endMs, sourceMs);
		if (trimmed.endMs <= trimmed.startMs) {
			throw new Error(
				`Keeping ${span.startMs} to ${span.endMs} ms would leave clip ${index} empty.`,
			);
		}
		return applySequence(
			context,
			clips,
			clips.map((candidate) => (candidate.id === clip.id ? trimmed : candidate)),
		);
	},

	"timeline.split": (payload, context) => {
		const args = requireObject(payload, "timeline.split");
		const { clips, totalMs } = loadClips(context);
		const timeMs = requireTimelineTime(args.timeMs, "timeMs", totalMs);
		const split = splitAt(clips, timeMs, idFactory(context));
		if (split === clips) {
			throw new Error(
				`${timeMs} ms (timeline milliseconds) is already a clip boundary or lies outside every clip, so there is nothing to split.`,
			);
		}
		context.timeline.setClipRegions(split);
		return { changed: true, durationMs: totalMs, clipCount: split.length };
	},

	"timeline.remove": (payload, context) => {
		const args = requireObject(payload, "timeline.remove");
		const { clips, totalMs } = loadClips(context);
		const span = requireTimelineSpan(args, totalMs);
		const createId = idFactory(context);
		const split = splitAt(splitAt(clips, span.startMs, createId), span.endMs, createId);
		const kept = split.filter(
			(clip) => !(clip.startMs >= span.startMs && clip.endMs <= span.endMs),
		);
		if (kept.length === split.length) {
			throw new Error(
				`No footage lies between ${span.startMs} and ${span.endMs} ms (timeline milliseconds), so nothing was removed.`,
			);
		}
		if (kept.length === 0) {
			throw new Error(
				"That would remove the whole recording. Keep at least one clip, or use timeline.trim to choose what stays.",
			);
		}
		return applySequence(context, split, kept);
	},

	"timeline.speed": (payload, context) => {
		const args = requireObject(payload, "timeline.speed");
		const { clips, totalMs } = loadClips(context);
		const speed = requireFiniteNumber(args.speed, "speed");
		if (!ALLOWED_SPEEDS.includes(speed)) {
			throw new Error(
				`speed ${speed} is not a playback speed the editor offers. Use one of ${ALLOWED_SPEEDS.join(", ")}.`,
			);
		}
		const index = clipIndexFor(args, clips, "timeline.speed");
		const clip = clips[index];
		if (safeSpeed(clip) === speed) {
			return unchanged(totalMs, `Clip ${index} already plays at ${speed}x.`);
		}
		return applySequence(
			context,
			clips,
			clips.map((candidate) =>
				candidate.id === clip.id ? retime(candidate, speed) : candidate,
			),
		);
	},

	"timeline.reorder": (payload, context) => {
		const args = requireObject(payload, "timeline.reorder");
		const { clips, totalMs } = loadClips(context);
		if (clips.length < 2) {
			throw new Error("The edit has a single clip, so there is nothing to reorder.");
		}
		const from = requireIndex(args.fromIndex, "fromIndex", clips.length);
		const to = requireIndex(args.toIndex, "toIndex", clips.length);
		if (from === to) {
			return unchanged(totalMs, `Clip ${from} is already at position ${to}.`);
		}
		return applySequence(context, clips, reorderClipSequence(clips, clips[from].id, to));
	},

	"timeline.set_scene_duration": async (payload, context) => {
		const args = requireObject(payload, "timeline.set_scene_duration");
		const { clips, totalMs } = loadClips(context);
		const ms = Math.round(requireFiniteNumber(args.ms, "ms"));
		if (ms <= 0) throw new Error("ms must be more than 0. Times are timeline milliseconds.");
		const log = await loadActivity(context, "timeline.set_scene_duration");
		const scene = sceneAt(log, args.index);
		const currentMs = clipsWithin(clips, scene);
		if (currentMs === 0) {
			throw new Error(
				`Scene ${args.index} has been cut out of the edit, so it has no length to change.`,
			);
		}
		if (ms === currentMs)
			return unchanged(totalMs, `Scene ${args.index} already lasts ${ms} ms.`);
		if (ms > currentMs) {
			throw new Error(
				`Scene ${args.index} lasts ${currentMs} ms and can only be shortened to ${ms} ms, not lengthened. Use timeline.speed to slow a clip down.`,
			);
		}
		const idle = clampRanges(findIdleRanges(log, Math.round(context.duration * 1000)), scene);
		return {
			...compressIdle(context, clips, idle, currentMs - ms, `A ${ms} ms scene`),
			sceneMs: ms,
		};
	},

	"timeline.fit": async (payload, context) => {
		const args = requireObject(payload, "timeline.fit");
		const { clips, totalMs, sourceMs } = loadClips(context);
		const targetMs = Math.round(requireFiniteNumber(args.targetMs, "targetMs"));
		if (targetMs <= 0)
			throw new Error("targetMs must be more than 0. Times are timeline milliseconds.");
		if (targetMs > sourceMs) {
			throw new Error(
				`targetMs (${targetMs}) is longer than the raw recording (${sourceMs} ms). fit only shortens an edit.`,
			);
		}
		if (targetMs === totalMs)
			return unchanged(totalMs, `The edit already lasts ${targetMs} ms.`);
		if (targetMs > totalMs) {
			throw new Error(
				`The edit lasts ${totalMs} ms, shorter than targetMs (${targetMs}). fit only shortens; use timeline.speed to slow clips down.`,
			);
		}
		const log = await loadActivity(context, "timeline.fit");
		const idle = findIdleRanges(log, sourceMs);
		return {
			...compressIdle(context, clips, idle, totalMs - targetMs, `${targetMs} ms`),
			targetMs,
		};
	},
};
