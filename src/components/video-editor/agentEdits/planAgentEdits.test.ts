import { describe, expect, it } from "vitest";
import {
	type AgentActivityAction,
	type AgentActivityLog,
	type AgentActivitySpanKind,
	type AgentActivityTarget,
	type AgentEditPlan,
	planAgentEdits,
} from "./planAgentEdits";

type Step = [AgentActivitySpanKind, AgentActivityAction, number, AgentActivityTarget?];
interface SceneSpec {
	startMs: number;
	steps: Step[];
	failed?: boolean;
	title?: string;
}

const WIDE = 16 / 9;
const button = (cx: number, cy: number): AgentActivityTarget => ({
	cx,
	cy,
	width: 0.08,
	height: 0.04,
});

function buildLog(scenes: SceneSpec[]): AgentActivityLog {
	const log: AgentActivityLog = { version: 1, scenes: [], spans: [] };
	for (const scene of scenes) {
		let cursor = scene.startMs;
		for (const [kind, action, durationMs, target] of scene.steps) {
			log.spans.push({ kind, action, startMs: cursor, endMs: cursor + durationMs, target });
			cursor += durationMs;
		}
		log.scenes.push({
			startMs: scene.startMs,
			endMs: cursor,
			failed: scene.failed ?? false,
			title: scene.title,
		});
	}
	return log;
}

function clickScene(startMs: number, target: AgentActivityTarget = button(0.5, 0.5)): SceneSpec {
	return {
		startMs,
		steps: [
			["motion", "click", 700, target],
			["hold", "wait", 2300],
		],
	};
}

function keptWithin(plan: AgentEditPlan, startMs: number, endMs: number) {
	return plan.keepRanges.reduce(
		(sum, range) =>
			sum + Math.max(0, Math.min(endMs, range.endMs) - Math.max(startMs, range.startMs)),
		0,
	);
}

function expectWellFormed(plan: AgentEditPlan, durationMs: number) {
	plan.keepRanges.forEach((range, index) => {
		expect(range.startMs).toBeGreaterThanOrEqual(0);
		expect(range.endMs).toBeLessThanOrEqual(durationMs);
		expect(range.endMs).toBeGreaterThan(range.startMs);
		if (index > 0) expect(range.startMs).toBeGreaterThan(plan.keepRanges[index - 1].endMs);
	});
	plan.zooms.forEach((zoom, index) => {
		expect(zoom.endMs - zoom.startMs).toBeGreaterThanOrEqual(100);
		expect(
			plan.keepRanges.filter(
				(range) => range.startMs <= zoom.startMs && zoom.endMs <= range.endMs,
			),
		).toHaveLength(1);
		if (index > 0) expect(zoom.startMs).toBeGreaterThanOrEqual(plan.zooms[index - 1].endMs);
		expect(zoom.focus.cx).toBeGreaterThanOrEqual(0);
		expect(zoom.focus.cx).toBeLessThanOrEqual(1);
		expect(zoom.focus.cy).toBeGreaterThanOrEqual(0);
		expect(zoom.focus.cy).toBeLessThanOrEqual(1);
	});
	for (const caption of plan.captions) {
		expect(
			plan.keepRanges.some(
				(range) => range.startMs <= caption.startMs && caption.endMs <= range.endMs,
			),
		).toBe(true);
	}
}

function plan(log: AgentActivityLog, durationMs: number, aspect = WIDE): AgentEditPlan {
	const result = planAgentEdits(log, durationMs, aspect);
	if (!result) throw new Error("expected a plan");
	expectWellFormed(result, durationMs);
	return result;
}

describe("planAgentEdits on a realistic agent demo", () => {
	const field: AgentActivityTarget = { cx: 0.4, cy: 0.5, width: 0.25, height: 0.05 };
	const log = buildLog([
		{
			startMs: 5000,
			title: "Open onboarding",
			steps: [
				["wait", "raise", 250],
				["motion", "click", 700, button(0.2, 0.1)],
				["hold", "wait", 4000],
				["motion", "click", 650, button(0.5, 0.3)],
				["hold", "wait", 3000],
			],
		},
		{
			startMs: 17600,
			steps: [
				["wait", "raise", 250],
				["motion", "click", 800, field],
				["motion", "type", 1800],
				["motion", "key", 200],
				["wait", "wait", 2500],
				["hold", "wait", 2500],
			],
		},
		{
			startMs: 30650,
			steps: [
				["wait", "raise", 250],
				["motion", "scroll", 900],
				["hold", "wait", 2500],
				["motion", "click", 700, button(0.7, 0.6)],
				["hold", "wait", 3500],
			],
		},
		{
			startMs: 43000,
			steps: [
				["wait", "raise", 250],
				["motion", "click", 750, button(0.3, 0.7)],
				["hold", "wait", 3000],
				["motion", "click", 700, button(0.32, 0.72)],
				["hold", "wait", 3000],
			],
		},
		{
			startMs: 56700,
			steps: [
				["wait", "raise", 250],
				["motion", "click", 700, button(0.8, 0.2)],
				["wait", "wait", 3000],
				["hold", "wait", 2500],
				["motion", "move", 600],
				["hold", "wait", 1000],
			],
		},
		{
			startMs: 68750,
			steps: [
				["wait", "raise", 250],
				["motion", "click", 700, button(0.6, 0.5)],
				["hold", "wait", 3500],
				["motion", "click", 650, button(0.9, 0.9)],
				["hold", "wait", 2500],
			],
		},
	]);
	const durationMs = 76500;
	const result = plan(log, durationMs);
	const clicks = log.spans.filter((span) => span.action === "click");

	it("cuts at least 20 s of thinking and loading", () => {
		expect(log.scenes[log.scenes.length - 1].endMs).toBeLessThanOrEqual(durationMs);
		expect(durationMs - keptWithin(result, 0, durationMs)).toBeGreaterThanOrEqual(20000);
	});

	it("keeps every click inside one kept range", () => {
		for (const click of clicks) {
			expect(
				result.keepRanges.some(
					(range) => range.startMs <= click.startMs && click.endMs <= range.endMs,
				),
			).toBe(true);
		}
	});

	it("zooms on every click, each zoom inside one keep range", () => {
		for (const click of clicks) {
			expect(
				result.zooms.some(
					(zoom) => zoom.startMs <= click.startMs && click.startMs < zoom.endMs,
				),
			).toBe(true);
		}
	});

	it("captions only the titled scene", () => {
		expect(result.captions).toEqual([{ startMs: 4950, endMs: 7450, text: "Open onboarding" }]);
	});
});

describe("planAgentEdits", () => {
	it("returns null when there is nothing to plan", () => {
		expect(planAgentEdits(null, 10000, WIDE)).toBeNull();
		expect(planAgentEdits(undefined, 10000, WIDE)).toBeNull();
		expect(planAgentEdits({ version: 1, scenes: [], spans: [] }, 10000, WIDE)).toBeNull();
		const log = buildLog([clickScene(1000)]);
		expect(
			planAgentEdits({ ...log, version: 2 } as unknown as AgentActivityLog, 1e4, WIDE),
		).toBeNull();
		expect(
			planAgentEdits({ version: 1 } as unknown as AgentActivityLog, 10000, WIDE),
		).toBeNull();
		expect(planAgentEdits(log, 0, WIDE)).toBeNull();
		expect(planAgentEdits(log, Number.NaN, WIDE)).toBeNull();
	});

	it("returns null when the cut would be tiny and nothing is zoomed", () => {
		const log = buildLog([{ startMs: 200, steps: [["hold", "wait", 8800]] }]);
		expect(planAgentEdits(log, 9500, WIDE)).toBeNull();
	});

	it("plans a single scene: lead-in cut, final tail kept, click zoomed", () => {
		const result = plan(buildLog([clickScene(1000, button(0.25, 0.75))]), 10000);
		expect(result.keepRanges).toEqual([{ startMs: 700, endMs: 5200 }]);
		expect(result.zooms).toEqual([
			{ startMs: 1000, endMs: 4000, depth: 3, focus: { cx: 0.25, cy: 0.75 } },
		]);
		expect(result.captions).toEqual([]);
	});

	it("merges adjacent scenes with tiny gaps instead of micro-cutting", () => {
		const result = plan(buildLog([clickScene(1000), clickScene(5000)]), 12000);
		expect(result.keepRanges).toEqual([{ startMs: 700, endMs: 9200 }]);
	});

	it("survives overlapping, unsorted, out-of-range and corrupt spans", () => {
		const log: AgentActivityLog = {
			version: 1,
			scenes: [{ startMs: Number.NaN, endMs: 5, failed: true }],
			spans: [
				{ kind: "hold", action: "wait", startMs: 5000, endMs: 6000 },
				{ kind: "motion", action: "click", startMs: 1000, endMs: 1500 },
				{ kind: "motion", action: "move", startMs: -2000, endMs: 200 },
				{ kind: "hold", action: "wait", startMs: 4000, endMs: 5500 },
				{ kind: "motion", action: "click", startMs: Number.NaN, endMs: 3000 },
				{ kind: "motion", action: "move", startMs: 8000, endMs: 7000 },
				{ kind: "hold", action: "wait", startMs: 20000, endMs: 21000 },
				{ kind: "think", action: "wait", startMs: 8000, endMs: 9000 } as unknown as never,
			],
		};
		const result = plan(log, 10000);
		expect(result.keepRanges).toEqual([
			{ startMs: 0, endMs: 1900 },
			{ startMs: 3700, endMs: 7200 },
		]);
	});

	it("keeps a long explicit hold", () => {
		const log = buildLog([
			{
				startMs: 1000,
				steps: [
					["motion", "click", 700, button(0.5, 0.5)],
					["hold", "wait", 10000],
					["motion", "click", 700, button(0.5, 0.5)],
				],
			},
		]);
		expect(plan(log, 20000).keepRanges).toEqual([{ startMs: 700, endMs: 13600 }]);
	});

	it("shortens a long wait to 0.8 s", () => {
		const log = buildLog([
			{
				startMs: 1000,
				steps: [
					["motion", "click", 700, button(0.2, 0.2)],
					["wait", "wait", 10000],
					["motion", "click", 700, button(0.8, 0.8)],
					["hold", "wait", 2000],
				],
			},
		]);
		const result = plan(log, 20000);
		expect(keptWithin(result, 1700, 11700)).toBe(800);
		expect(result.keepRanges).toEqual([
			{ startMs: 700, endMs: 2200 },
			{ startMs: 11400, endMs: 15600 },
		]);
	});

	it("cuts a failed scene so the retake replaces it", () => {
		const log = buildLog([
			clickScene(1000),
			{ ...clickScene(8000, button(0.1, 0.1)), failed: true, title: "Broken" },
			{ ...clickScene(13000), title: "Retake" },
		]);
		const result = plan(log, 20000);
		expect(result.keepRanges).toEqual([
			{ startMs: 700, endMs: 4400 },
			{ startMs: 12700, endMs: 17200 },
		]);
		expect(result.zooms.every((zoom) => zoom.endMs <= 4400 || zoom.startMs >= 12700)).toBe(
			true,
		);
		expect(result.captions.map((caption) => caption.text)).toEqual(["Retake"]);
	});

	it("cuts a failed last scene to the end and never keeps nothing", () => {
		const log = buildLog([clickScene(1000), { ...clickScene(4500), failed: true }]);
		expect(plan(log, 15000).keepRanges).toEqual([{ startMs: 700, endMs: 4500 }]);
		const allFailed = buildLog([{ ...clickScene(1000), failed: true }]);
		expect(planAgentEdits(allFailed, 15000, WIDE)).toBeNull();
	});

	it("leaves no sliver between back-to-back failed scenes", () => {
		const log = buildLog([
			clickScene(1000),
			{ startMs: 4500, steps: [["motion", "click", 200, button(0.5, 0.5)]], failed: true },
			{ startMs: 5100, steps: [["motion", "click", 200, button(0.5, 0.5)]], failed: true },
		]);
		expect(plan(log, 15000).keepRanges).toEqual([{ startMs: 700, endMs: 4500 }]);
	});

	it("adds no zooms to tall sources", () => {
		const result = plan(buildLog([clickScene(3000)]), 10000, 0.8);
		expect(result.zooms).toEqual([]);
		expect(result.keepRanges).toEqual([{ startMs: 2700, endMs: 7200 }]);
	});

	it("picks the depth from the target size and skips big targets", () => {
		const zoomFor = (target: AgentActivityTarget) =>
			plan(buildLog([clickScene(3000, target)]), 10000).zooms;
		expect(zoomFor({ cx: 0.5, cy: 0.5, width: 0.5 })).toEqual([]);
		expect(zoomFor({ cx: 0.5, cy: 0.5, width: 0.2 })[0].depth).toBe(2);
		expect(zoomFor({ cx: 0.5, cy: 0.5, width: 0.05 })[0].depth).toBe(3);
		expect(zoomFor({ cx: 1.4, cy: -0.2 })[0]).toMatchObject({
			depth: 3,
			focus: { cx: 1, cy: 0 },
		});
	});

	it("no zoom for scroll, key or move-only motion", () => {
		const log = buildLog([
			{
				startMs: 3000,
				steps: [
					["motion", "scroll", 900, button(0.5, 0.5)],
					["motion", "key", 200, button(0.5, 0.5)],
					["motion", "move", 600, button(0.5, 0.5)],
					["hold", "wait", 2000],
				],
			},
		]);
		expect(plan(log, 10000).zooms).toEqual([]);
	});

	it("lets typing right after a click inherit its focus", () => {
		const field = { cx: 0.3, cy: 0.4, width: 0.2 };
		const log = buildLog([
			{
				startMs: 1000,
				steps: [
					["motion", "click", 700, field],
					["hold", "wait", 500],
					["motion", "type", 2000],
					["hold", "wait", 2000],
				],
			},
		]);
		expect(plan(log, 12000).zooms).toEqual([
			{ startMs: 1000, endMs: 6200, depth: 2, focus: { cx: 0.3, cy: 0.4 } },
		]);

		const late = buildLog([
			{
				startMs: 1000,
				steps: [
					["motion", "click", 700, field],
					["hold", "wait", 3300],
					["motion", "type", 1000],
					["hold", "wait", 2000],
				],
			},
		]);
		expect(plan(late, 12000).zooms).toEqual([
			{ startMs: 1000, endMs: 4700, depth: 2, focus: { cx: 0.3, cy: 0.4 } },
		]);
	});

	it("splits a zoom at a cut and drops short pieces", () => {
		const log = buildLog([
			{
				startMs: 1000,
				steps: [
					["motion", "click", 700, button(0.5, 0.5)],
					["wait", "wait", 2000],
					["motion", "click", 700, button(0.52, 0.5)],
					["hold", "wait", 2000],
				],
			},
		]);
		const result = plan(log, 10000);
		expect(result.keepRanges).toEqual([
			{ startMs: 700, endMs: 2200 },
			{ startMs: 3400, endMs: 7600 },
		]);
		expect(result.zooms).toEqual([
			{ startMs: 1000, endMs: 2200, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
			{ startMs: 3400, endMs: 6400, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
		]);

		const trailing = buildLog([
			{
				startMs: 1000,
				steps: [
					["motion", "click", 700, button(0.5, 0.5)],
					["wait", "wait", 1500],
				],
			},
		]);
		const trailingPlan = plan(trailing, 10000);
		expect(trailingPlan.keepRanges).toEqual([
			{ startMs: 700, endMs: 2200 },
			{ startMs: 2900, endMs: 4400 },
		]);
		expect(trailingPlan.zooms).toEqual([
			{ startMs: 1000, endMs: 2200, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
		]);
	});

	it("does not overlap zooms with different focus", () => {
		const log = buildLog([
			{
				startMs: 1000,
				steps: [
					["motion", "click", 800, button(0.1, 0.1)],
					["motion", "click", 500, button(0.9, 0.9)],
					["hold", "wait", 2000],
				],
			},
		]);
		expect(plan(log, 10000).zooms).toEqual([
			{ startMs: 1000, endMs: 1800, depth: 3, focus: { cx: 0.1, cy: 0.1 } },
			{ startMs: 1800, endMs: 4300, depth: 3, focus: { cx: 0.9, cy: 0.9 } },
		]);
	});

	it("captions only titled, successful scenes, clamped to their keep range", () => {
		const log = buildLog([
			{
				startMs: 1000,
				title: "  Open settings  ",
				steps: [
					["motion", "click", 700, button(0.5, 0.5)],
					["hold", "wait", 1000],
				],
			},
			clickScene(8000),
			{ ...clickScene(15000), title: "   " },
			{ ...clickScene(22000), title: "Oops", failed: true },
			{ ...clickScene(29000), title: "x".repeat(100) },
		]);
		expect(plan(log, 40000).captions).toEqual([
			{ startMs: 700, endMs: 3100, text: "Open settings" },
			{ startMs: 28700, endMs: 31200, text: "x".repeat(80) },
		]);
	});

	it("clamps to a duration shorter than the log", () => {
		const log = buildLog([
			clickScene(1000),
			{
				startMs: 8000,
				steps: [
					["motion", "click", 700, button(0.5, 0.5)],
					["hold", "wait", 11300],
					["hold", "wait", 1000],
				],
			},
		]);
		const result = plan(log, 10000);
		expect(result.keepRanges).toEqual([
			{ startMs: 700, endMs: 4400 },
			{ startMs: 7700, endMs: 10000 },
		]);
	});
});
