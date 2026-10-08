import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WEBCAM_OVERLAY, DEFAULT_ZOOM_MOTION_BLUR_TUNING } from "../../types";
import { lookOps } from "./look";
import { getEditorState } from "./state";
import type { EditorOpContext } from "./types";

const PROBES: Record<string, unknown> = {
	connectZooms: true,
	zoomInDurationMs: 800,
	zoomOutDurationMs: 800,
	connectedZoomDurationMs: 800,
	connectedZoomGapMs: 100,
	zoomInOverlapMs: 200,
	zoomInEasing: "glide",
	zoomOutEasing: "glide",
	connectedZoomEasing: "glide",
	zoomSmoothness: 0.5,
	zoomClassicMode: true,
	zoomMotionBlur: 1,
	zoomMotionBlurTuning: { maxDirectionalBlurPx: 10 },
	showCursor: false,
	loopCursor: true,
	cursorStyle: "dot",
	cursorSize: 2,
	cursorSmoothing: 1,
	cursorMotionBlur: 1,
	cursorSway: 1,
	cursorClickEffect: "ripple",
	cursorClickEffectScale: 1,
	cursorClickEffectOpacity: 0.5,
	cursorClickEffectDurationMs: 400,
	cursorClickBounce: 1,
	cursorClickBounceDuration: 200,
	cursorSpringStiffnessMultiplier: 1,
	cursorSpringDampingMultiplier: 1,
	cursorSpringMassMultiplier: 1,
	cameraSpringStiffnessMultiplier: 1,
	cameraSpringDampingMultiplier: 1,
	cameraSpringMassMultiplier: 1,
};

function appearanceStub() {
	const state: Record<string, unknown> = {
		webcam: DEFAULT_WEBCAM_OVERLAY,
		...PROBES,
		zoomMotionBlurTuning: DEFAULT_ZOOM_MOTION_BLUR_TUNING,
	};
	return new Proxy(state, {
		get(target, key: string) {
			if (key.startsWith("set")) {
				return (value: unknown) => {
					target[key[3].toLowerCase() + key.slice(4)] = value;
				};
			}
			return target[key];
		},
	});
}

function context(): EditorOpContext {
	return {
		duration: 10,
		videoSourcePath: "/tmp/take.mp4",
		timeline: {
			clipRegions: [{ id: "clip-1", startMs: 0, endMs: 10_000, sourceStartMs: 0, speed: 1 }],
			zoomRegions: [],
			annotationRegions: [],
			audioRegions: [],
			autoCaptions: [],
		},
		appearance: appearanceStub(),
		history: { undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false },
		ids: {},
		assertSameRecording: () => undefined,
	} as unknown as EditorOpContext;
}

function accepts(field: string): boolean {
	try {
		lookOps["look.motion"]({ [field]: PROBES[field] }, context());
		return true;
	} catch (error) {
		if (error instanceof Error && /unknown field/.test(error.message)) return false;
		throw error;
	}
}

describe("look.motion and get_editor_state agree on the motion settings", () => {
	beforeEach(() => {
		vi.stubGlobal("window", {
			electronAPI: { getAgentActivity: vi.fn(async () => ({ success: false })) },
		});
	});

	it("reports back every motion setting look.motion accepts", async () => {
		const reported = Object.keys((await getEditorState(context())).motion);
		const writableButInvisible = Object.keys(PROBES).filter(
			(field) => accepts(field) && !reported.includes(field),
		);
		expect(writableButInvisible).toEqual([]);
	});

	it("accepts every motion setting get_editor_state reports back", async () => {
		const reported = Object.keys((await getEditorState(context())).motion);
		const readableButUnsettable = reported.filter((field) => !accepts(field));
		expect(readableButUnsettable).toEqual([]);
	});
});
