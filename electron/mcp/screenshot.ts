import { desktopCapturer } from "electron";
import { WINDOW_OFF_SCREEN_MESSAGE, type WindowBounds } from "../ipc/types";
import { getScreen } from "../ipc/utils";

export const MAX_IMAGE_EDGE = 1568;
export const MAX_IMAGE_PIXELS = 1_150_000;
const JPEG_QUALITY = 80;
const REGION_OFF_SCREEN_MESSAGE =
	"That part of the window is off screen. Move the window fully onto a display, then try again.";

export type WindowShot = {
	data: string;
	mimeType: "image/jpeg";
	width: number;
	height: number;
	scale: number;
	originX: number;
	originY: number;
};

export function clampRegion(window: WindowBounds, region: WindowBounds): WindowBounds {
	const { x, y, width, height } = region;
	if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
		throw new Error(
			"A screenshot region needs numbers x and y and a positive width and height, in window points.",
		);
	}
	const left = Math.max(0, x);
	const top = Math.max(0, y);
	const right = Math.min(window.width, x + width);
	const bottom = Math.min(window.height, y + height);
	if (right - left < 1 || bottom - top < 1) {
		throw new Error(
			`The region (${x}, ${y}, ${width} × ${height}) is outside the selected window ` +
				`(${Math.round(window.width)} × ${Math.round(window.height)} points). Use window-relative points.`,
		);
	}
	return { x: window.x + left, y: window.y + top, width: right - left, height: bottom - top };
}

export function planWindowCrop(
	window: WindowBounds,
	display: WindowBounds,
	image: { width: number; height: number },
	maxEdge = MAX_IMAGE_EDGE,
) {
	const left = Math.max(window.x, display.x);
	const top = Math.max(window.y, display.y);
	const right = Math.min(window.x + window.width, display.x + display.width);
	const bottom = Math.min(window.y + window.height, display.y + display.height);
	if (right - left < 1 || bottom - top < 1) return null;
	const ratioX = image.width / display.width;
	const ratioY = image.height / display.height;
	const cropX = Math.round((left - display.x) * ratioX);
	const cropY = Math.round((top - display.y) * ratioY);
	const crop = {
		x: cropX,
		y: cropY,
		width: Math.min(image.width - cropX, Math.round((right - left) * ratioX)),
		height: Math.min(image.height - cropY, Math.round((bottom - top) * ratioY)),
	};
	if (crop.width < 1 || crop.height < 1) return null;
	const fit = Math.min(
		1,
		maxEdge / Math.max(crop.width, crop.height),
		Math.sqrt(MAX_IMAGE_PIXELS / (crop.width * crop.height)),
	);
	const output = {
		width: Math.max(1, Math.floor(crop.width * fit + 1e-6)),
		height: Math.max(1, Math.floor(crop.height * fit + 1e-6)),
	};
	return {
		crop,
		output,
		scale: (right - left) / output.width,
		originX: left - window.x,
		originY: top - window.y,
	};
}

export async function captureWindow(
	frame: WindowBounds,
	region?: WindowBounds,
): Promise<WindowShot> {
	const area = region ? clampRegion(frame, region) : frame;
	const display = getScreen().getDisplayMatching({
		x: Math.round(area.x),
		y: Math.round(area.y),
		width: Math.round(area.width),
		height: Math.round(area.height),
	});
	const sources = await desktopCapturer.getSources({
		types: ["screen"],
		thumbnailSize: {
			width: Math.round(display.size.width * display.scaleFactor),
			height: Math.round(display.size.height * display.scaleFactor),
		},
	});
	const source =
		sources.find((candidate) => candidate.display_id === String(display.id)) ??
		(sources.length === 1 ? sources[0] : undefined);
	if (!source || source.thumbnail.isEmpty()) {
		throw new Error(
			"Recordly could not capture the screen. Check its Screen Recording permission in System Settings > Privacy & Security.",
		);
	}
	const plan = planWindowCrop(area, display.bounds, source.thumbnail.getSize());
	if (!plan) throw new Error(region ? REGION_OFF_SCREEN_MESSAGE : WINDOW_OFF_SCREEN_MESSAGE);
	const image = source.thumbnail.crop(plan.crop).resize({ ...plan.output, quality: "best" });
	return {
		data: image.toJPEG(JPEG_QUALITY).toString("base64"),
		mimeType: "image/jpeg",
		width: plan.output.width,
		height: plan.output.height,
		scale: plan.scale,
		originX: plan.originX + area.x - frame.x,
		originY: plan.originY + area.y - frame.y,
	};
}
