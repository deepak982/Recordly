import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ desktopCapturer: {} }));
vi.mock("../ipc/utils", () => ({}));

import { MAX_IMAGE_PIXELS, planWindowCrop } from "./screenshot";

const RETINA = { x: 0, y: 0, width: 1440, height: 900 };

describe("planWindowCrop", () => {
	it("crops a window on a Retina display and keeps the image within 1.15 megapixels", () => {
		const plan = planWindowCrop({ x: 100, y: 50, width: 800, height: 600 }, RETINA, {
			width: 2880,
			height: 1800,
		});
		expect(plan).toEqual({
			crop: { x: 200, y: 100, width: 1600, height: 1200 },
			output: { width: 1238, height: 928 },
			scale: 800 / 1238,
			originX: 0,
			originY: 0,
		});
	});

	it("caps a wide window's long edge at 1568 px", () => {
		const plan = planWindowCrop({ x: 0, y: 0, width: 1440, height: 300 }, RETINA, {
			width: 2880,
			height: 1800,
		});
		expect(plan?.output).toEqual({ width: 1568, height: 326 });
		expect((plan?.output.width ?? 0) * (plan?.output.height ?? 0)).toBeLessThanOrEqual(
			MAX_IMAGE_PIXELS,
		);
	});

	it("never upscales a small window, so one pixel is one point at 1x", () => {
		const plan = planWindowCrop({ x: 10, y: 20, width: 400, height: 300 }, RETINA, {
			width: 1440,
			height: 900,
		});
		expect(plan).toMatchObject({
			crop: { x: 10, y: 20, width: 400, height: 300 },
			output: { width: 400, height: 300 },
			scale: 1,
		});
	});

	it("maps a secondary display's offset and clips a window hanging off its edge", () => {
		const display = { x: 1440, y: 0, width: 1920, height: 1080 };
		const plan = planWindowCrop({ x: 1340, y: 980, width: 800, height: 600 }, display, {
			width: 1920,
			height: 1080,
		});
		expect(plan).toMatchObject({
			crop: { x: 0, y: 980, width: 700, height: 100 },
			output: { width: 700, height: 100 },
			originX: 100,
			originY: 0,
			scale: 1,
		});
	});

	it("returns null when less than a pixel of the window is visible", () => {
		expect(
			planWindowCrop({ x: 1439.5, y: 0, width: 300, height: 300 }, RETINA, {
				width: 1440,
				height: 900,
			}),
		).toBeNull();
	});

	it("returns null when the window is not on the display", () => {
		expect(
			planWindowCrop({ x: 2000, y: 0, width: 300, height: 300 }, RETINA, {
				width: 2880,
				height: 1800,
			}),
		).toBeNull();
	});
});
