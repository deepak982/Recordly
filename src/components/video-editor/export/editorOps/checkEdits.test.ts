import { describe, expect, it } from "vitest";
import { checkEditsOps, lintEdits } from "./checkEdits";
import type { EditorOpContext } from "./types";

const whole = [{ id: "c1", startMs: 0, endMs: 10_000, sourceStartMs: 0, speed: 1 }];
const cutClips = [
	{ id: "c1", startMs: 0, endMs: 3000, sourceStartMs: 0, speed: 1 },
	{ id: "c2", startMs: 3000, endMs: 6000, sourceStartMs: 4000, speed: 1 },
];

function annotation(patch: Record<string, unknown> = {}) {
	return {
		id: "a1",
		startMs: 1000,
		endMs: 3000,
		type: "text",
		content: "Title",
		position: { x: 5, y: 5 },
		size: { width: 20, height: 10 },
		space: "frame",
		...patch,
	};
}

function zoom(patch: Record<string, unknown> = {}) {
	return {
		id: "z1",
		startMs: 1000,
		endMs: 3000,
		depth: 3,
		focus: { cx: 0.8, cy: 0.8 },
		...patch,
	};
}

function make(
	timeline: Record<string, unknown> = {},
	appearance: Record<string, unknown> = {},
): EditorOpContext {
	return {
		duration: 10,
		videoSourcePath: "/tmp/take.mp4",
		timeline: {
			clipRegions: whole,
			zoomRegions: [],
			annotationRegions: [],
			speedRegions: [],
			autoCaptions: [],
			...timeline,
		},
		appearance: {
			padding: 0,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			...appearance,
		},
	} as unknown as EditorOpContext;
}

const kinds = (context: EditorOpContext) => lintEdits(context).problems.map((p) => p.kind);

describe("check_edits", () => {
	it("reports nothing for a clean project and names every check that ran", () => {
		const result = lintEdits(make());
		expect(result.problems).toEqual([]);
		expect(result.checked).toContain("zoom_crops_annotation");
		expect(result.checked).toContain("caption_validity");
	});

	it("rejects arguments and mutates nothing", () => {
		const context = make({ annotationRegions: [annotation()] });
		const before = JSON.stringify(context.timeline);
		expect(() => checkEditsOps.check_edits({ nope: 1 }, context)).toThrow(/unknown field/);
		checkEditsOps.check_edits({}, context);
		expect(JSON.stringify(context.timeline)).toBe(before);
	});

	describe("zoom cropping a frame-space annotation", () => {
		it("errors when the zoom pushes it fully out of view, at the overlap midpoint", () => {
			const [problem] = lintEdits(
				make({ annotationRegions: [annotation()], zoomRegions: [zoom()] }),
			).problems;
			expect(problem).toMatchObject({
				severity: "error",
				kind: "zoom_crops_annotation",
				subject: "annotation a1",
				atMs: 2000,
			});
		});

		it("warns and names the edges when only partly cropped", () => {
			const [problem] = lintEdits(
				make({
					annotationRegions: [
						annotation({ position: { x: 10, y: 40 }, size: { width: 80, height: 10 } }),
					],
					zoomRegions: [zoom({ focus: { cx: 0.5, cy: 0.5 } })],
				}),
			).problems;
			expect(problem.severity).toBe("warning");
			expect(problem.message).toContain("left and right");
		});

		it("is fine for a screen-space annotation, a zoom elsewhere in time, or a box that stays inside", () => {
			const zooms = [zoom()];
			expect(
				kinds(
					make({
						annotationRegions: [annotation({ space: "screen" })],
						zoomRegions: zooms,
					}),
				),
			).toEqual([]);
			expect(
				kinds(
					make({
						annotationRegions: [annotation({ startMs: 5000, endMs: 6000 })],
						zoomRegions: zooms,
					}),
				),
			).toEqual([]);
			expect(
				kinds(
					make({
						annotationRegions: [
							annotation({
								position: { x: 45, y: 45 },
								size: { width: 10, height: 10 },
							}),
						],
						zoomRegions: [zoom({ focus: { cx: 0.5, cy: 0.5 } })],
					}),
				),
			).toEqual([]);
		});

		it("touching a region only at an instant is not an overlap", () => {
			expect(
				kinds(
					make({
						annotationRegions: [annotation({ startMs: 0, endMs: 1000 })],
						zoomRegions: [zoom()],
					}),
				),
			).toEqual([]);
		});
	});

	describe("look", () => {
		it("warns when padding leaves under half the frame", () => {
			const [problem] = lintEdits(make({}, { padding: 100 })).problems;
			expect(problem).toMatchObject({ severity: "warning", kind: "look_picture_small" });
			expect(problem.message).toContain("36%");
		});

		it("accepts ordinary padding", () => {
			expect(kinds(make({}, { padding: 28 }))).toEqual([]);
		});

		it("flags an empty or out-of-range crop, and warns on a tiny one", () => {
			expect(kinds(make({}, { cropRegion: { x: 0, y: 0, width: 0, height: 1 } }))).toContain(
				"look_crop_invalid",
			);
			expect(
				kinds(make({}, { cropRegion: { x: 0.6, y: 0, width: 0.6, height: 1 } })),
			).toContain("look_crop_invalid");
			expect(
				kinds(make({}, { cropRegion: { x: 0, y: 0, width: 0.4, height: 0.4 } })),
			).toContain("look_crop_small");
		});
	});

	describe("captions after a cut", () => {
		it("accepts a cue inside one clip", () => {
			const cues = [{ id: "q1", startMs: 500, endMs: 2500, text: "Hello" }];
			expect(kinds(make({ clipRegions: cutClips, autoCaptions: cues }))).toEqual([]);
		});

		it("errors on a cue that now spans a cut, reporting the timeline moment", () => {
			const cues = [{ id: "q1", startMs: 2000, endMs: 5000, text: "Hello" }];
			const [problem] = lintEdits(
				make({ clipRegions: cutClips, autoCaptions: cues }),
			).problems;
			expect(problem).toMatchObject({
				severity: "error",
				kind: "caption_crosses_cut",
				atMs: 2000,
			});
		});

		it("errors on a cue wholly inside a cut and on a cue whose head is cut", () => {
			expect(
				kinds(
					make({
						clipRegions: cutClips,
						autoCaptions: [{ id: "q1", startMs: 3200, endMs: 3800, text: "Gone" }],
					}),
				),
			).toEqual(["caption_in_cut"]);
			expect(
				kinds(
					make({
						clipRegions: cutClips,
						autoCaptions: [{ id: "q1", startMs: 3500, endMs: 5000, text: "Head" }],
					}),
				),
			).toEqual(["caption_crosses_cut"]);
		});

		it("accepts a cue across two clips that are contiguous in the source", () => {
			const split = [
				{ id: "c1", startMs: 0, endMs: 3000, sourceStartMs: 0, speed: 1 },
				{ id: "c2", startMs: 3000, endMs: 6000, sourceStartMs: 3000, speed: 1 },
			];
			const cues = [{ id: "q1", startMs: 2000, endMs: 4000, text: "Hello" }];
			expect(kinds(make({ clipRegions: split, autoCaptions: cues }))).toEqual([]);
		});

		it("errors on a cue across clips with different speeds", () => {
			const mixed = [
				{ id: "c1", startMs: 0, endMs: 3000, sourceStartMs: 0, speed: 1 },
				{ id: "c2", startMs: 3000, endMs: 4500, sourceStartMs: 3000, speed: 2 },
			];
			const cues = [{ id: "q1", startMs: 2000, endMs: 4000, text: "Hello" }];
			expect(kinds(make({ clipRegions: mixed, autoCaptions: cues }))).toEqual([
				"caption_crosses_cut",
			]);
		});

		it("errors on empty caption text", () => {
			const cues = [{ id: "q1", startMs: 0, endMs: 1000, text: "  " }];
			expect(kinds(make({ autoCaptions: cues }))).toEqual(["caption_empty"]);
		});
	});

	describe("blur over a zoom", () => {
		it("warns with the overlap moment", () => {
			const [problem] = lintEdits(
				make({
					annotationRegions: [
						annotation({ type: "blur", space: "screen", startMs: 2000, endMs: 4000 }),
					],
					zoomRegions: [zoom()],
				}),
			).problems;
			expect(problem).toMatchObject({
				severity: "warning",
				kind: "blur_over_zoom",
				atMs: 2500,
			});
		});
	});

	describe("plainly broken regions", () => {
		it("errors on inverted regions and off-frame focus", () => {
			expect(
				kinds(
					make({
						zoomRegions: [
							zoom({ startMs: 3000, endMs: 3000, focus: { cx: 1.4, cy: 0.5 } }),
						],
					}),
				),
			).toEqual(["empty_region", "zoom_focus_off_frame"]);
		});

		it("errors on a zero-size or fully off-frame annotation", () => {
			expect(
				kinds(
					make({ annotationRegions: [annotation({ size: { width: 0, height: 10 } })] }),
				),
			).toEqual(["annotation_zero_size"]);
			expect(
				kinds(make({ annotationRegions: [annotation({ position: { x: 100, y: 10 } })] })),
			).toEqual(["annotation_off_frame"]);
		});

		it("warns about a region that starts after the timeline ends", () => {
			const [problem] = lintEdits(
				make({
					zoomRegions: [
						zoom({ startMs: 10_000, endMs: 11_000, focus: { cx: 0.5, cy: 0.5 } }),
					],
				}),
			).problems;
			expect(problem).toMatchObject({ severity: "warning", kind: "region_past_end" });
		});
	});
});
