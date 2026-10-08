import { describe, expect, it } from "vitest";
import type { AnnotationRegion } from "@/components/video-editor/types";
import { DEFAULT_ANNOTATION_STYLE } from "@/components/video-editor/types";
import { renderAnnotations } from "./annotationRenderer";

function textAnnotation(space?: "frame" | "screen"): AnnotationRegion {
	return {
		id: "a",
		startMs: 0,
		endMs: 1000,
		type: "text",
		content: "Title",
		textContent: "Title",
		position: { x: 10, y: 20 },
		size: { width: 50, height: 10 },
		style: { ...DEFAULT_ANNOTATION_STYLE },
		zIndex: 1,
		space,
	};
}

async function clipRect(annotation: AnnotationRegion) {
	const rects: number[][] = [];
	const ctx = new Proxy(
		{ measureText: () => ({ width: 10 }) },
		{
			get: (target, key) =>
				key in target
					? (target as never)[key]
					: key === "rect"
						? (...args: number[]) => rects.push(args)
						: () => undefined,
			set: () => true,
		},
	) as unknown as CanvasRenderingContext2D;
	await renderAnnotations(
		ctx,
		[annotation],
		1000,
		500,
		0,
		1,
		undefined,
		{ scale: 2, x: -300, y: -100 },
		{ x: 50, y: 25, width: 900, height: 450 },
	);
	return rects[0];
}

describe("renderAnnotations space", () => {
	it("frame follows the zoom and the recording rect", async () => {
		expect(await clipRect(textAnnotation())).toEqual([
			(50 + 90) * 2 - 300,
			(25 + 90) * 2 - 100,
			900,
			90,
		]);
	});

	it("screen ignores the zoom and the recording rect", async () => {
		expect(await clipRect(textAnnotation("screen"))).toEqual([100, 100, 500, 50]);
	});
});
