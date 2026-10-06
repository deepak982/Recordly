import { describe, expect, it, vi } from "vitest";

const { getSources, getScreen } = vi.hoisted(() => ({ getSources: vi.fn(), getScreen: vi.fn() }));
vi.mock("electron", () => ({ desktopCapturer: { getSources } }));
vi.mock("../ipc/utils", () => ({ getScreen }));

import { captureWindow, clampRegion, MAX_IMAGE_PIXELS, planWindowCrop } from "./screenshot";

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

describe("clampRegion", () => {
	const WINDOW = { x: 100, y: 50, width: 800, height: 600 };

	it("clamps a region to the window and returns it in screen points", () => {
		expect(clampRegion(WINDOW, { x: -10, y: 550, width: 100, height: 100 })).toEqual({
			x: 100,
			y: 600,
			width: 90,
			height: 50,
		});
	});

	it.each([
		[{ x: 0, y: 0, width: 0, height: 10 }, /positive width/],
		[{ x: 0, y: 0, width: 10, height: -5 }, /positive width/],
		[{ x: Number.NaN, y: 0, width: 10, height: 10 }, /positive width/],
		[{ x: 800, y: 0, width: 50, height: 50 }, /outside the selected window \(800 × 600/],
		[{ x: 799.5, y: 0, width: 10, height: 10 }, /outside the selected window/],
	])("refuses %o", (region, message) => {
		expect(() => clampRegion(WINDOW, region)).toThrow(message);
	});

	it("keeps a large region within the image caps", () => {
		const area = clampRegion(WINDOW, { x: 0, y: 0, width: 800, height: 600 });
		const plan = planWindowCrop(area, RETINA, { width: 2880, height: 1800 });
		expect(plan?.output).toEqual({ width: 1238, height: 928 });
	});
});

describe("captureWindow", () => {
	const FRAME = { x: 100, y: 50, width: 800, height: 600 };

	function mockRetina() {
		const crop = vi.fn(() => ({ resize: () => ({ toJPEG: () => Buffer.from("hi") }) }));
		getScreen.mockReturnValue({
			getDisplayMatching: () => ({
				id: 1,
				bounds: RETINA,
				size: { width: 1440, height: 900 },
				scaleFactor: 2,
			}),
		});
		getSources.mockResolvedValue([
			{
				display_id: "1",
				thumbnail: {
					isEmpty: () => false,
					getSize: () => ({ width: 2880, height: 1800 }),
					crop,
				},
			},
		]);
		return crop;
	}

	it("zooms a region at the display's physical resolution and reports its origin", async () => {
		const crop = mockRetina();
		await expect(
			captureWindow(FRAME, { x: 700, y: -20, width: 300, height: 100 }),
		).resolves.toEqual({
			data: "aGk=",
			mimeType: "image/jpeg",
			width: 200,
			height: 160,
			scale: 0.5,
			originX: 700,
			originY: 0,
		});
		expect(getSources).toHaveBeenCalledWith({
			types: ["screen"],
			thumbnailSize: { width: 2880, height: 1800 },
		});
		expect(crop).toHaveBeenCalledWith({ x: 1600, y: 100, width: 200, height: 160 });
	});

	it("captures the whole window without a region", async () => {
		const crop = mockRetina();
		await expect(captureWindow(FRAME)).resolves.toMatchObject({
			width: 1238,
			height: 928,
			scale: 800 / 1238,
			originX: 0,
			originY: 0,
		});
		expect(crop).toHaveBeenCalledWith({ x: 200, y: 100, width: 1600, height: 1200 });
	});

	it("refuses a region outside the window before capturing", async () => {
		mockRetina();
		getSources.mockClear();
		await expect(captureWindow(FRAME, { x: 900, y: 0, width: 10, height: 10 })).rejects.toThrow(
			/outside the selected window/,
		);
		expect(getSources).not.toHaveBeenCalled();
	});

	it("says a region is off screen rather than the window being closed", async () => {
		mockRetina();
		await expect(
			captureWindow(
				{ x: 1000, y: 50, width: 800, height: 600 },
				{ x: 500, y: 0, width: 100, height: 100 },
			),
		).rejects.toThrow("That part of the window is off screen.");
	});
});
