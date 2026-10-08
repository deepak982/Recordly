import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityLog } from "../../agentEdits/planAgentEdits";
import { type ClipRegion, getTimelineDurationMs } from "../../types";
import { findIdleRanges, timelineOps } from "./timeline";
import type { EditorOpContext } from "./types";

const clip = (id: string, startMs: number, endMs: number, extra: Partial<ClipRegion> = {}) =>
	({ id, startMs, endMs, speed: 1, ...extra }) as ClipRegion;

function makeContext(clips: ClipRegion[], duration = 20) {
	const state = {
		clips,
		zooms: [{ id: "z", startMs: 15000, endMs: 16000 }] as {
			id: string;
			startMs: number;
			endMs: number;
		}[],
		selected: null as string | null,
		writes: 0,
	};
	const apply = <T>(current: T, next: unknown) =>
		typeof next === "function" ? (next as (value: T) => T)(current) : (next as T);
	const context = {
		duration,
		videoSourcePath: "/tmp/a.mp4",
		timeline: {
			get clipRegions() {
				return state.clips;
			},
			get selectedClipId() {
				return state.selected;
			},
			setClipRegions: (next: unknown) => {
				state.writes++;
				state.clips = apply(state.clips, next);
			},
			setSelectedClipId: (id: string | null) => {
				state.selected = id;
			},
			setZoomRegions: (next: unknown) => {
				state.zooms = apply(state.zooms, next);
			},
			setAnnotationRegions: () => undefined,
			setAudioRegions: () => undefined,
		},
		history: { undo: () => undefined, redo: () => undefined },
		ids: {
			zoom: { current: 1 },
			clip: { current: 1 },
			audio: { current: 1 },
			annotation: { current: 1 },
			annotationZIndex: { current: 1 },
		},
	} as unknown as EditorOpContext;
	return { state, context };
}

type Result = { changed: boolean; durationMs: number; clipCount: number; sceneMs: number };

const run = (op: string, payload: unknown, context: EditorOpContext) =>
	timelineOps[op](payload, context) as Result;

const log: AgentActivityLog = {
	version: 1,
	scenes: [
		{ startMs: 0, endMs: 12000, failed: false },
		{ startMs: 12000, endMs: 20000, failed: false },
	],
	spans: [
		{ kind: "motion", action: "click", startMs: 0, endMs: 1000 },
		{ kind: "wait", action: "wait", startMs: 2000, endMs: 12000 },
		{ kind: "motion", action: "click", startMs: 12000, endMs: 13000 },
	],
};

function stubActivity(result: unknown) {
	vi.stubGlobal("window", { electronAPI: { getAgentActivity: async () => result } });
}

afterEach(() => vi.unstubAllGlobals());

describe("timeline.split", () => {
	it("splits a clip at a timeline time and keeps source continuity", () => {
		const { state, context } = makeContext([clip("clip-1", 0, 10000, { speed: 2 })]);
		const result = run("timeline.split", { timeMs: 4000 }, context);
		expect(result.clipCount).toBe(2);
		expect(state.clips.map((c) => [c.startMs, c.endMs, c.sourceStartMs ?? 0])).toEqual([
			[0, 4000, 0],
			[4000, 10000, 8000],
		]);
	});

	it("refuses a split on an existing boundary and changes nothing", () => {
		const { state, context } = makeContext([clip("a", 0, 5000), clip("b", 5000, 10000)]);
		expect(() => run("timeline.split", { timeMs: 5000 }, context)).toThrow(
			/already a clip boundary/,
		);
		expect(state.writes).toBe(0);
	});

	it("rejects non-finite and out-of-range times", () => {
		const { state, context } = makeContext([clip("a", 0, 10000)]);
		expect(() => run("timeline.split", { timeMs: Number.NaN }, context)).toThrow(
			/must be a number/,
		);
		expect(() => run("timeline.split", { timeMs: 99999 }, context)).toThrow(
			/timeline milliseconds/,
		);
		expect(() => run("timeline.split", {}, context)).toThrow(/must be a number/);
		expect(state.writes).toBe(0);
	});

	it("refuses an empty timeline", () => {
		const { context } = makeContext([]);
		expect(() => run("timeline.split", { timeMs: 1 }, context)).toThrow(/no clips/);
	});
});

describe("timeline.remove", () => {
	it("drops the span, closes the gap and ripples zooms", () => {
		const { state, context } = makeContext([clip("a", 0, 20000)]);
		const result = run("timeline.remove", { startMs: 5000, endMs: 10000 }, context);
		expect(result.durationMs).toBe(15000);
		expect(state.clips.map((c) => [c.startMs, c.endMs, c.sourceStartMs ?? 0])).toEqual([
			[0, 5000, 0],
			[5000, 15000, 10000],
		]);
		expect(state.zooms[0].startMs).toBe(10000);
	});

	it("refuses to remove everything and an inverted range", () => {
		const { state, context } = makeContext([clip("a", 0, 20000)]);
		expect(() => run("timeline.remove", { startMs: 0, endMs: 20000 }, context)).toThrow(
			/whole recording/,
		);
		expect(() => run("timeline.remove", { startMs: 9, endMs: 3 }, context)).toThrow(
			/after startMs/,
		);
		expect(state.writes).toBe(0);
	});
});

describe("timeline.trim", () => {
	it("keeps only a span of the whole recording", () => {
		const { state, context } = makeContext([clip("a", 0, 20000)]);
		run("timeline.trim", { startMs: 2000, endMs: 8000 }, context);
		expect(state.clips.map((c) => [c.startMs, c.endMs, c.sourceStartMs ?? 0])).toEqual([
			[0, 6000, 2000],
		]);
	});

	it("trims one clip within its own span", () => {
		const { state, context } = makeContext([clip("a", 0, 10000), clip("b", 10000, 20000)]);
		run("timeline.trim", { clipIndex: 0, startMs: 1000, endMs: 4000 }, context);
		expect(state.clips.map((c) => [c.startMs, c.endMs])).toEqual([
			[0, 3000],
			[3000, 13000],
		]);
	});

	it("refuses a span outside the clip, and a no-op span", () => {
		const { state, context } = makeContext([clip("a", 0, 10000), clip("b", 10000, 20000)]);
		expect(() =>
			run("timeline.trim", { clipIndex: 0, startMs: 0, endMs: 12000 }, context),
		).toThrow(/must lie inside it/);
		expect(() => run("timeline.trim", { clipIndex: 5, startMs: 0, endMs: 1 }, context)).toThrow(
			/clipIndex must be a whole number/,
		);
		expect(
			run("timeline.trim", { clipIndex: 0, startMs: 0, endMs: 10000 }, context).changed,
		).toBe(false);
		expect(state.writes).toBe(0);
	});
});

describe("timeline.speed", () => {
	it("re-speeds a clip and ripples the clips after it", () => {
		const { state, context } = makeContext([clip("a", 0, 10000), clip("b", 10000, 20000)]);
		run("timeline.speed", { clipIndex: 0, speed: 2 }, context);
		expect(state.clips.map((c) => [c.startMs, c.endMs, c.speed])).toEqual([
			[0, 5000, 2],
			[5000, 15000, 1],
		]);
	});

	it("rejects a speed that is not offered by name instead of rounding", () => {
		const { state, context } = makeContext([clip("a", 0, 10000)]);
		expect(() => run("timeline.speed", { speed: 3 }, context)).toThrow(/not a playback speed/);
		expect(() => run("timeline.speed", { speed: 1.9 }, context)).toThrow(
			/not a playback speed/,
		);
		expect(state.writes).toBe(0);
	});

	it("needs clipIndex when there are several clips, and reports a no-op", () => {
		const { context } = makeContext([clip("a", 0, 10000), clip("b", 10000, 20000)]);
		expect(() => run("timeline.speed", { speed: 2 }, context)).toThrow(/needs clipIndex/);
		expect(run("timeline.speed", { clipIndex: 1, speed: 1 }, context).changed).toBe(false);
	});
});

describe("timeline.reorder", () => {
	it("moves a clip and repacks the sequence", () => {
		const { state, context } = makeContext([clip("a", 0, 4000), clip("b", 4000, 10000)]);
		run("timeline.reorder", { fromIndex: 1, toIndex: 0 }, context);
		expect(state.clips.map((c) => [c.id, c.startMs, c.endMs])).toEqual([
			["b", 0, 6000],
			["a", 6000, 10000],
		]);
	});

	it("refuses a single clip, bad indexes and a same-place move", () => {
		const single = makeContext([clip("a", 0, 4000)]);
		expect(() => run("timeline.reorder", { fromIndex: 0, toIndex: 0 }, single.context)).toThrow(
			/single clip/,
		);
		const { state, context } = makeContext([clip("a", 0, 4000), clip("b", 4000, 10000)]);
		expect(() => run("timeline.reorder", { fromIndex: 0, toIndex: 2 }, context)).toThrow(
			/toIndex must be a whole number/,
		);
		expect(run("timeline.reorder", { fromIndex: 1, toIndex: 1 }, context).changed).toBe(false);
		expect(state.writes).toBe(0);
	});
});

describe("findIdleRanges", () => {
	it("keeps the planner's margins and protects motion", () => {
		expect(findIdleRanges(log, 20000)).toEqual([{ startMs: 3200, endMs: 11300 }]);
	});

	it("protects screen changes", () => {
		const ranges = findIdleRanges({ ...log, changeTimesMs: [7000] }, 20000);
		expect(ranges).toEqual([
			{ startMs: 3200, endMs: 6600 },
			{ startMs: 7400, endMs: 11300 },
		]);
	});
});

describe("timeline.fit", () => {
	it("speeds up idle stretches to hit the target and leaves action alone", async () => {
		stubActivity({ success: true, log });
		const { state, context } = makeContext([clip("a", 0, 20000)]);
		const result = await run("timeline.fit", { targetMs: 15000 }, context);
		expect(result.durationMs).toBe(15000);
		expect(getTimelineDurationMs(state.clips, 20000)).toBe(15000);
		const sped = state.clips.filter((c) => c.speed > 1);
		expect(sped).toHaveLength(1);
		expect(sped[0].sourceStartMs).toBe(3200);
		expect(state.clips.filter((c) => c.speed === 1).length).toBeGreaterThanOrEqual(2);
	});

	it("trims once speed alone is not enough", async () => {
		stubActivity({ success: true, log });
		const { state, context } = makeContext([clip("a", 0, 20000)]);
		const result = await run("timeline.fit", { targetMs: 12500 }, context);
		expect(result.durationMs).toBe(12500);
		expect(state.clips.every((c) => c.speed === 1 || c.speed >= 8)).toBe(true);
	});

	it("says how far short it fell and changes nothing", async () => {
		stubActivity({ success: true, log });
		const { state, context } = makeContext([clip("a", 0, 20000)]);
		await expect(run("timeline.fit", { targetMs: 5000 }, context)).rejects.toThrow(
			/6900 ms short/,
		);
		expect(state.writes).toBe(0);
	});

	it("rejects zero, over-long and non-shortening targets", async () => {
		stubActivity({ success: true, log });
		const { state, context } = makeContext([clip("a", 0, 10000)], 20);
		await expect(run("timeline.fit", { targetMs: 0 }, context)).rejects.toThrow(/more than 0/);
		await expect(run("timeline.fit", { targetMs: 25000 }, context)).rejects.toThrow(
			/raw recording/,
		);
		await expect(run("timeline.fit", { targetMs: 15000 }, context)).rejects.toThrow(
			/only shortens/,
		);
		expect((await run("timeline.fit", { targetMs: 10000 }, context)).changed).toBe(false);
		expect(state.writes).toBe(0);
	});

	it("reports a missing activity log by name", async () => {
		stubActivity({ success: false, log: null, message: "No activity log." });
		const { state, context } = makeContext([clip("a", 0, 20000)]);
		await expect(run("timeline.fit", { targetMs: 15000 }, context)).rejects.toThrow(
			/No activity log/,
		);
		expect(state.writes).toBe(0);
	});
});

describe("timeline.set_scene_duration", () => {
	it("shortens one scene to the requested length", async () => {
		stubActivity({ success: true, log });
		const { context } = makeContext([clip("a", 0, 20000)]);
		const result = await run("timeline.set_scene_duration", { index: 0, ms: 8000 }, context);
		expect(result.durationMs).toBe(16000);
		expect(result.sceneMs).toBe(8000);
	});

	it("refuses a scene with no idle time to give and a bad index", async () => {
		stubActivity({ success: true, log });
		const { state, context } = makeContext([clip("a", 0, 20000)]);
		await expect(
			run("timeline.set_scene_duration", { index: 1, ms: 5000 }, context),
		).rejects.toThrow(/short/);
		await expect(
			run("timeline.set_scene_duration", { index: 9, ms: 5000 }, context),
		).rejects.toThrow(/index must be a whole number/);
		await expect(
			run("timeline.set_scene_duration", { index: 0, ms: 13000 }, context),
		).rejects.toThrow(/only be shortened/);
		expect(state.writes).toBe(0);
	});
});
