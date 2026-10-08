import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AutoCaptionSettings,
	type CaptionCue,
	DEFAULT_AUTO_CAPTION_SETTINGS,
} from "../../types";
import { captionsOps } from "./captions";
import type { EditorOpContext } from "./types";

type Clip = { id: string; startMs: number; endMs: number; speed: number; sourceStartMs?: number };

function makeContext(options: { cues?: CaptionCue[]; clips?: Clip[]; durationSec?: number } = {}) {
	const state = {
		cues: options.cues ?? [],
		settings: { ...DEFAULT_AUTO_CAPTION_SETTINGS } as AutoCaptionSettings,
		selected: null as string | null,
	};
	const apply = <T>(current: T, next: unknown) =>
		typeof next === "function" ? (next as (value: T) => T)(current) : (next as T);
	const context = {
		duration: options.durationSec ?? 10,
		videoSourcePath: "/tmp/take.mp4",
		timeline: {
			clipRegions: options.clips ?? [],
			get autoCaptions() {
				return state.cues;
			},
			get autoCaptionSettings() {
				return state.settings;
			},
			get selectedCaptionId() {
				return state.selected;
			},
			setAutoCaptions: (next: unknown) => {
				state.cues = apply(state.cues, next);
			},
			setAutoCaptionSettings: (next: unknown) => {
				state.settings = apply(state.settings, next);
			},
			setSelectedCaptionId: (id: string | null) => {
				state.selected = id;
			},
		},
	} as unknown as EditorOpContext;
	return { state, context };
}

const run = (op: string, payload: unknown, context: EditorOpContext) =>
	captionsOps[op](payload, context) as never;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("captions.set", () => {
	it("replaces the cues in order, enables captions and returns ids", () => {
		const { state, context } = makeContext({
			cues: [{ id: "old", startMs: 0, endMs: 100, text: "old" }],
		});
		const result = run(
			"captions.set",
			{
				cues: [
					{ startMs: 3000, endMs: 4000, text: "  second  " },
					{ startMs: 1000, endMs: 2000, text: "first" },
				],
			},
			context,
		) as { count: number; ids: string[] };
		expect(state.cues.map((cue) => cue.text)).toEqual(["first", "second"]);
		expect(state.cues.map((cue) => cue.id)).toEqual(result.ids);
		expect(state.settings.enabled).toBe(true);
	});

	it("accepts a cue ending exactly at the end of the recording and touching cues", () => {
		const { state, context } = makeContext();
		run(
			"captions.set",
			{
				cues: [
					{ startMs: 0, endMs: 5000, text: "a" },
					{ startMs: 5000, endMs: 10000, text: "b" },
				],
			},
			context,
		);
		expect(state.cues).toHaveLength(2);
	});

	it.each([
		["an empty list", { cues: [] }, /non-empty list/],
		["no list", {}, /non-empty list/],
		["an inverted range", { cues: [{ startMs: 2000, endMs: 1000, text: "x" }] }, /endMs after/],
		[
			"a zero-length range",
			{ cues: [{ startMs: 1000, endMs: 1000, text: "x" }] },
			/endMs after/,
		],
		["a negative start", { cues: [{ startMs: -1, endMs: 1000, text: "x" }] }, /startMs of 0/],
		[
			"a range past the recording",
			{ cues: [{ startMs: 9000, endMs: 10001, text: "x" }] },
			/past the end/,
		],
		[
			"a non-finite time",
			{ cues: [{ startMs: Number.NaN, endMs: 1000, text: "x" }] },
			/must be a number/,
		],
		["blank text", { cues: [{ startMs: 0, endMs: 1000, text: "   " }] }, /must not be empty/],
		[
			"overlapping cues",
			{
				cues: [
					{ startMs: 0, endMs: 2000, text: "a" },
					{ startMs: 1999, endMs: 3000, text: "b" },
				],
			},
			/overlap/,
		],
	])("rejects %s and leaves the captions untouched", (_name, payload, message) => {
		const existing = [{ id: "keep", startMs: 0, endMs: 100, text: "keep" }];
		const { state, context } = makeContext({ cues: existing });
		expect(() => run("captions.set", payload, context)).toThrow(message);
		expect(state.cues).toBe(existing);
		expect(state.settings.enabled).toBe(false);
	});

	it("converts timeline time to recording time through a sped-up clip", () => {
		const { state, context } = makeContext({
			clips: [{ id: "c", startMs: 0, endMs: 5000, speed: 2, sourceStartMs: 0 }],
		});
		run("captions.set", { cues: [{ startMs: 1000, endMs: 2000, text: "fast" }] }, context);
		expect([state.cues[0].startMs, state.cues[0].endMs]).toEqual([2000, 4000]);
	});

	it("rejects a cue that starts in a cut or crosses one", () => {
		const clips = [
			{ id: "a", startMs: 0, endMs: 2000, speed: 1 },
			{ id: "b", startMs: 2000, endMs: 4000, speed: 1, sourceStartMs: 6000 },
		];
		const { context } = makeContext({ clips });
		expect(() =>
			run("captions.set", { cues: [{ startMs: 1000, endMs: 3000, text: "x" }] }, context),
		).toThrow(/crosses a cut/);
		expect(() =>
			run("captions.set", { cues: [{ startMs: 4000, endMs: 4500, text: "x" }] }, context),
		).toThrow(/past the end/);
	});
});

describe("captions.update and captions.remove", () => {
	const cues = [
		{ id: "a", startMs: 0, endMs: 1000, text: "one" },
		{ id: "b", startMs: 2000, endMs: 3000, text: "two" },
	];

	it("changes text and retimes a cue", () => {
		const { state, context } = makeContext({ cues });
		run("captions.update", { id: "b", text: "deux", startMs: 2500, endMs: 3500 }, context);
		const b = state.cues.find((cue) => cue.id === "b");
		expect([b?.text, b?.startMs, b?.endMs]).toEqual(["deux", 2500, 3500]);
	});

	it("rejects an unknown id, no change, half a time, and a retime that overlaps a neighbour", () => {
		const { state, context } = makeContext({ cues });
		expect(() => run("captions.update", { id: "zz", text: "x" }, context)).toThrow(
			/no caption/,
		);
		expect(() => run("captions.update", { id: "a" }, context)).toThrow(/to change/);
		expect(() => run("captions.update", { id: "a", startMs: 5 }, context)).toThrow(/together/);
		expect(() =>
			run("captions.update", { id: "a", startMs: 500, endMs: 2500 }, context),
		).toThrow(/overlap/);
		expect(state.cues).toBe(cues);
	});

	it("removes one cue and clears its selection, or removes all", () => {
		const { state, context } = makeContext({ cues });
		state.selected = "a";
		run("captions.remove", { id: "a" }, context);
		expect(state.cues.map((cue) => cue.id)).toEqual(["b"]);
		expect(state.selected).toBeNull();
		run("captions.remove", { all: true }, context);
		expect(state.cues).toEqual([]);
	});

	it("rejects removing an unknown id, removing from nothing and an ambiguous call", () => {
		const { context } = makeContext({ cues });
		expect(() => run("captions.remove", { id: "zz" }, context)).toThrow(/no caption/);
		expect(() => run("captions.remove", { id: "a", all: true }, context)).toThrow(/not both/);
		expect(() => run("captions.remove", { all: true }, makeContext().context)).toThrow(
			/no captions to remove/,
		);
	});
});

describe("captions.style and captions.animation", () => {
	it("applies valid style fields and the animation by name", () => {
		const { state, context } = makeContext();
		run(
			"captions.style",
			{ fontSize: 40, maxRows: 2, textColor: "#ff0", enabled: true },
			context,
		);
		run("captions.animation", { style: "pop" }, context);
		expect(state.settings).toMatchObject({
			fontSize: 40,
			maxRows: 2,
			textColor: "#ff0",
			enabled: true,
			animationStyle: "pop",
		});
	});

	it("accepts the edges of each range", () => {
		const { state, context } = makeContext();
		run("captions.style", { fontSize: 16, backgroundOpacity: 1, maxWidth: 95 }, context);
		expect(state.settings.fontSize).toBe(16);
	});

	it.each([
		[{ fontSize: 15 }, /from 16 to 72/],
		[{ fontSize: 73 }, /from 16 to 72/],
		[{ maxRows: 1.5 }, /whole number/],
		[{ backgroundOpacity: 1.1 }, /from 0 to 1/],
		[{ textColor: "white" }, /hex colour/],
		[{ fontFamily: "Comic Sans" }, /not a caption style/],
		[{ fontSize: Number.NaN }, /must be a number/],
		[{}, /at least one/],
	])("rejects style %j", (payload, message) => {
		const { state, context } = makeContext();
		const before = state.settings;
		expect(() => run("captions.style", payload, context)).toThrow(message);
		expect(state.settings).toBe(before);
	});

	it("rejects an unknown animation instead of defaulting", () => {
		const { state, context } = makeContext();
		expect(() => run("captions.animation", { style: "spin" }, context)).toThrow(
			/one of: none, fade, rise, pop/,
		);
		expect(state.settings.animationStyle).toBe(DEFAULT_AUTO_CAPTION_SETTINGS.animationStyle);
	});
});

function stubApi(api: Record<string, unknown>) {
	vi.stubGlobal("window", { electronAPI: api });
}

describe("captions.generate from scenes", () => {
	const log = (scenes: unknown[]) => ({ success: true, log: { version: 1, scenes, spans: [] } });

	it("turns titled scenes into cues bounded by the next scene and the caption length", async () => {
		const getAgentActivity = vi.fn().mockResolvedValue(
			log([
				{ startMs: 0, endMs: 6000, failed: false, title: "Payroll Health" },
				{ startMs: 4000, endMs: 9000, failed: false, title: "Run the check" },
				{ startMs: 5000, endMs: 6000, failed: true, title: "Broken" },
				{ startMs: 7000, endMs: 8000, failed: false },
			]),
		);
		stubApi({ getAgentActivity });
		const { state, context } = makeContext();
		await run("captions.generate", { from: "scenes" }, context);
		expect(getAgentActivity).toHaveBeenCalledWith("/tmp/take.mp4");
		expect(state.cues.map((cue) => [cue.text, cue.startMs, cue.endMs])).toEqual([
			["Payroll Health", 0, 2500],
			["Run the check", 4000, 6500],
		]);
		expect(state.settings.enabled).toBe(true);
	});

	it("fails with a reason when there is no scene list or nothing to caption", async () => {
		const { state, context } = makeContext();
		stubApi({ getAgentActivity: vi.fn().mockResolvedValue({ success: true, log: null }) });
		await expect(run("captions.generate", { from: "scenes" }, context)).rejects.toThrow(
			/no scene list/,
		);
		stubApi({
			getAgentActivity: vi
				.fn()
				.mockResolvedValue(log([{ startMs: 0, endMs: 1, failed: true, title: "x" }])),
		});
		await expect(run("captions.generate", { from: "scenes" }, context)).rejects.toThrow(
			/no titled scenes/,
		);
		expect(state.cues).toEqual([]);
	});

	it("times out instead of hanging when the scene list never arrives", async () => {
		vi.useFakeTimers();
		stubApi({ getAgentActivity: vi.fn().mockReturnValue(new Promise(() => undefined)) });
		const { context } = makeContext();
		const pending = run("captions.generate", { from: "scenes" }, context) as Promise<unknown>;
		const assertion = expect(pending).rejects.toThrow(/waiting for the scene list/);
		await vi.advanceTimersByTimeAsync(10_001);
		await assertion;
	});
});

describe("captions.generate from audio", () => {
	const model = { success: true, exists: true, path: "/m/ggml-small.bin" };

	it("rejects an unknown or missing source by name before touching the editor", async () => {
		const { context } = makeContext();
		await expect(run("captions.generate", { from: "voice" }, context)).rejects.toThrow(
			/one of: audio, scenes/,
		);
		await expect(run("captions.generate", {}, context)).rejects.toThrow(
			/one of: audio, scenes/,
		);
	});

	it("rejects a timeout outside its bounds", async () => {
		const { context } = makeContext();
		await expect(
			run("captions.generate", { from: "audio", timeoutMs: 5 }, context),
		).rejects.toThrow(/timeoutMs/);
	});

	it("says what is missing when no speech model is downloaded", async () => {
		stubApi({
			getWhisperSmallModelStatus: vi.fn().mockResolvedValue({ success: true, exists: false }),
		});
		const { context } = makeContext();
		await expect(run("captions.generate", { from: "audio" }, context)).rejects.toThrow(
			/download the Whisper small model/,
		);
	});

	it("applies the recognised cues", async () => {
		const generateAutoCaptions = vi.fn().mockResolvedValue({
			success: true,
			cues: [{ id: "w1", startMs: 100, endMs: 900, text: "hello" }],
		});
		stubApi({
			getWhisperSmallModelStatus: vi.fn().mockResolvedValue(model),
			generateAutoCaptions,
		});
		const { state, context } = makeContext();
		await run("captions.generate", { from: "audio" }, context);
		expect(generateAutoCaptions).toHaveBeenCalledWith({
			videoPath: "/tmp/take.mp4",
			whisperModelPath: "/m/ggml-small.bin",
			language: "auto",
		});
		expect(state.cues[0].text).toBe("hello");
	});

	it("reports an empty result and a failure without changing captions", async () => {
		const { state, context } = makeContext();
		stubApi({
			getWhisperSmallModelStatus: vi.fn().mockResolvedValue(model),
			generateAutoCaptions: vi.fn().mockResolvedValue({ success: true, cues: [] }),
		});
		await expect(run("captions.generate", { from: "audio" }, context)).rejects.toThrow(
			/no speech/,
		);
		stubApi({
			getWhisperSmallModelStatus: vi.fn().mockResolvedValue(model),
			generateAutoCaptions: vi
				.fn()
				.mockResolvedValue({ success: false, error: "whisper crashed" }),
		});
		await expect(run("captions.generate", { from: "audio" }, context)).rejects.toThrow(
			/whisper crashed/,
		);
		expect(state.cues).toEqual([]);
	});

	it("gives up after the cap, says what it waited for, ignores a late result and allows a retry", async () => {
		vi.useFakeTimers();
		let finish: (value: unknown) => void = () => undefined;
		stubApi({
			getWhisperSmallModelStatus: vi.fn().mockResolvedValue(model),
			generateAutoCaptions: vi.fn().mockReturnValue(
				new Promise((resolve) => {
					finish = resolve;
				}),
			),
		});
		const { state, context } = makeContext();
		const first = run(
			"captions.generate",
			{ from: "audio", timeoutMs: 2000 },
			context,
		) as Promise<unknown>;
		const firstFailure = expect(first).rejects.toThrow(
			/waiting for speech recognition to finish/,
		);
		await vi.advanceTimersByTimeAsync(0);
		await expect(run("captions.generate", { from: "audio" }, context)).rejects.toThrow(
			/still being generated/,
		);
		await vi.advanceTimersByTimeAsync(2001);
		await firstFailure;
		finish({ success: true, cues: [{ id: "late", startMs: 0, endMs: 5, text: "late" }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(state.cues).toEqual([]);
		stubApi({ getAgentActivity: vi.fn().mockResolvedValue({ success: true, log: null }) });
		await expect(run("captions.generate", { from: "scenes" }, context)).rejects.toThrow(
			/no scene list/,
		);
	});
});
