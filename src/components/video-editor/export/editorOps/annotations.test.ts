import { describe, expect, it } from "vitest";
import type { AnnotationRegion } from "../../types";
import { annotationsOps } from "./annotations";
import type { EditorOpContext } from "./types";

function makeContext(initial: AnnotationRegion[] = [], duration = 10) {
	const state = { regions: initial, selected: null as string | null };
	const context = {
		duration,
		videoSourcePath: "/tmp/a.mp4",
		timeline: {
			clipRegions: [],
			get annotationRegions() {
				return state.regions;
			},
			get selectedAnnotationId() {
				return state.selected;
			},
			setAnnotationRegions: (next: unknown) => {
				state.regions =
					typeof next === "function"
						? (next as (c: AnnotationRegion[]) => AnnotationRegion[])(state.regions)
						: (next as AnnotationRegion[]);
			},
			setSelectedAnnotationId: (id: string | null) => {
				state.selected = id;
			},
		},
		history: { undo: () => undefined, redo: () => undefined },
		ids: {
			zoom: { current: 1 },
			clip: { current: 1 },
			audio: { current: 1 },
			annotation: { current: 1 },
			annotationZIndex: { current: 1 },
		},
		assertSameRecording: () => undefined,
		adoptJoinedMedia: () => undefined,
	} as unknown as EditorOpContext;
	return { state, context };
}

const blur = { kind: "blur", startMs: 1000, endMs: 3000, x: 10, y: 20, width: 30, height: 10 };
const add = (payload: unknown, context: EditorOpContext) =>
	annotationsOps["annotate.add"](payload, context) as { id: string };

describe("annotate.add blur", () => {
	it("creates a blur region in percent coordinates with the default strength", () => {
		const { state, context } = makeContext();
		const { id } = add(blur, context);
		expect(state.regions).toHaveLength(1);
		expect(state.regions[0]).toMatchObject({
			id,
			type: "blur",
			startMs: 1000,
			endMs: 3000,
			position: { x: 10, y: 20 },
			size: { width: 30, height: 10 },
			blurIntensity: 20,
			zIndex: 1,
		});
		expect(state.selected).toBe(id);
	});

	it("squares the box so no corner pixel escapes the blur", () => {
		const { state, context } = makeContext();
		add(blur, context);
		add(
			{ startMs: 0, endMs: 1000, x: 0, y: 0, width: 20, height: 20, kind: "text", text: "a" },
			context,
		);
		expect(state.regions[0].style.borderRadius).toBe(0);
		expect(state.regions[1].style.borderRadius).toBe(8);
	});

	it("accepts a box exactly on the frame edge and a range ending at the timeline end", () => {
		const { state, context } = makeContext();
		add({ ...blur, x: 0, y: 0, width: 100, height: 100, startMs: 0, endMs: 10000 }, context);
		expect(state.regions).toHaveLength(1);
	});

	it("gives the next annotation a higher zIndex and a unique id", () => {
		const { state, context } = makeContext();
		add(blur, context);
		add(blur, context);
		expect(state.regions[1].zIndex).toBe(2);
		expect(new Set(state.regions.map((r) => r.id)).size).toBe(2);
	});

	it("takes zIndex from the editor's shared counter, so a later hand edit cannot collide", () => {
		const { state, context } = makeContext();
		add(blur, context);
		expect(context.ids.annotationZIndex.current).toBe(2);
		const handAdded = context.ids.annotationZIndex.current++;
		expect(handAdded).not.toBe(state.regions[0].zIndex);
	});

	it("burns no id or zIndex when the add is refused", () => {
		const { context } = makeContext();
		expect(() => add({ ...blur, x: 90 }, context)).toThrow();
		expect(context.ids.annotation.current).toBe(1);
		expect(context.ids.annotationZIndex.current).toBe(1);
		expect(add(blur, context).id).toBe("annotation-1");
	});

	it("takes its ids from the editor's own counter, so they cannot collide", () => {
		const { context } = makeContext();
		expect(add(blur, context).id).toBe("annotation-1");
		expect(add(blur, context).id).toBe("annotation-2");
		expect(context.ids.annotation.current).toBe(3);
	});

	it.each([
		["a non-finite start", { startMs: Number.NaN }],
		["an inverted range", { startMs: 3000, endMs: 1000 }],
		["a zero-length range", { startMs: 1000, endMs: 1000 }],
		["a negative start", { startMs: -1 }],
		["an end past the timeline", { endMs: 10001 }],
		["a zero width", { width: 0 }],
		["a negative height", { height: -5 }],
		["a negative x", { x: -1 }],
		["a box running off the right edge", { x: 80, width: 30 }],
		["a box running off the bottom", { y: 95, height: 10 }],
		["a pixel-style size", { width: 400, height: 80 }],
		["a strength of 0", { strength: 0 }],
		["a strength above 100", { strength: 101 }],
		["a text-only field", { text: "hi" }],
		["a string time", { startMs: "1000" }],
		["a misspelled strength", { strenght: 80 }],
		["a range shorter than one exported frame", { startMs: 1001, endMs: 1032 }],
	])("refuses %s and changes nothing", (_name, override) => {
		const { state, context } = makeContext();
		expect(() => add({ ...blur, ...override }, context)).toThrow();
		expect(state.regions).toEqual([]);
		expect(state.selected).toBeNull();
	});

	it("refuses when no recording is loaded", () => {
		const { state, context } = makeContext([], 0);
		expect(() => add(blur, context)).toThrow(/no recording/);
		expect(state.regions).toEqual([]);
	});

	it("refuses an unknown kind and a non-object payload", () => {
		const { state, context } = makeContext();
		expect(() => add({ ...blur, kind: "spotlight" }, context)).toThrow(/kind must be one of/);
		expect(() => add(null, context)).toThrow(/needs an object/);
		expect(state.regions).toEqual([]);
	});
});

describe("annotate.add other kinds", () => {
	it("adds text, a figure arrow and an image", () => {
		const { state, context } = makeContext();
		const geo = { startMs: 0, endMs: 1000, x: 0, y: 0, width: 20, height: 20 };
		add({ ...geo, kind: "text", text: "Hello" }, context);
		add({ ...geo, kind: "figure", arrowDirection: "up-left", color: "#ff0000" }, context);
		add({ ...geo, kind: "image", image: "data:image/png;base64,AAAA" }, context);
		expect(state.regions[0]).toMatchObject({
			type: "text",
			content: "Hello",
			textContent: "Hello",
		});
		expect(state.regions[1].figureData).toEqual({
			arrowDirection: "up-left",
			color: "#ff0000",
			strokeWidth: 4,
		});
		expect(state.regions[2]).toMatchObject({
			type: "image",
			imageContent: "data:image/png;base64,AAAA",
		});
	});

	it("refuses empty text, a bad arrow and a non-image URL", () => {
		const { state, context } = makeContext();
		const geo = { startMs: 0, endMs: 1000, x: 0, y: 0, width: 20, height: 20 };
		expect(() => add({ ...geo, kind: "text" }, context)).toThrow();
		expect(() => add({ ...geo, kind: "text", text: "  " }, context)).toThrow();
		expect(() => add({ ...geo, kind: "figure", arrowDirection: "sideways" }, context)).toThrow(
			/arrowDirection/,
		);
		expect(() => add({ ...geo, kind: "image", image: "https://x/y.png" }, context)).toThrow(
			/data:image/,
		);
		expect(state.regions).toEqual([]);
	});
});

describe("annotate.update / remove / clear", () => {
	it("moves a blur and keeps the rest", () => {
		const { state, context } = makeContext();
		const { id } = add(blur, context);
		annotationsOps["annotate.update"]({ id, x: 50, strength: 60 }, context);
		expect(state.regions[0]).toMatchObject({
			position: { x: 50, y: 20 },
			size: { width: 30, height: 10 },
			blurIntensity: 60,
		});
	});

	it("refuses an update that would leave the frame and keeps the old region", () => {
		const { state, context } = makeContext();
		const { id } = add(blur, context);
		expect(() => annotationsOps["annotate.update"]({ id, x: 90 }, context)).toThrow(
			/inside the frame/,
		);
		expect(state.regions[0].position.x).toBe(10);
	});

	it("refuses a retime shorter than one exported frame and keeps the old range", () => {
		const { state, context } = makeContext();
		const { id } = add(blur, context);
		expect(() =>
			annotationsOps["annotate.update"]({ id, startMs: 1001, endMs: 1032 }, context),
		).toThrow(/too short to be rendered/);
		expect(state.regions[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
	});

	it("refuses an update whose last field is unknown and applies none of the earlier ones", () => {
		const { state, context } = makeContext();
		const { id } = add(blur, context);
		expect(() =>
			annotationsOps["annotate.update"]({ id, x: 50, strength: 60, strenght: 80 }, context),
		).toThrow(/unknown field strenght/);
		expect(state.regions[0]).toMatchObject({
			position: { x: 10, y: 20 },
			blurIntensity: 20,
		});
	});

	it("refuses clear with arguments instead of wiping every annotation", () => {
		const { state, context } = makeContext();
		const { id } = add(blur, context);
		expect(() => annotationsOps["annotate.clear"]({ id }, context)).toThrow(
			/takes no arguments/,
		);
		expect(state.regions).toHaveLength(1);
	});

	it("refuses unknown ids, empty updates and kind changes", () => {
		const { context } = makeContext();
		const { id } = add(blur, context);
		expect(() => annotationsOps["annotate.update"]({ id: "nope", x: 1 }, context)).toThrow(
			/no annotation/,
		);
		expect(() => annotationsOps["annotate.update"]({ id }, context)).toThrow(
			/at least one field/,
		);
		expect(() => annotationsOps["annotate.update"]({ id, kind: "text" }, context)).toThrow(
			/cannot change/,
		);
		expect(() => annotationsOps["annotate.update"]({ id, text: "x" }, context)).toThrow(
			/does not apply/,
		);
	});

	it("removes one annotation and clears the selection only if it was selected", () => {
		const { state, context } = makeContext();
		const a = add(blur, context).id;
		const b = add(blur, context).id;
		annotationsOps["annotate.remove"]({ id: a }, context);
		expect(state.regions.map((r) => r.id)).toEqual([b]);
		expect(state.selected).toBe(b);
		annotationsOps["annotate.remove"]({ id: b }, context);
		expect(state.selected).toBeNull();
		expect(() => annotationsOps["annotate.remove"]({ id: b }, context)).toThrow(
			/no annotation/,
		);
	});

	it("clears everything, and refuses when there is nothing to clear", () => {
		const { state, context } = makeContext();
		expect(() => annotationsOps["annotate.clear"]({}, context)).toThrow(/no annotations/);
		add(blur, context);
		add(blur, context);
		expect(annotationsOps["annotate.clear"]({}, context)).toEqual({ removed: 2 });
		expect(state.regions).toEqual([]);
		expect(state.selected).toBeNull();
	});
});
