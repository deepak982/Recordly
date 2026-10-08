import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioRegion } from "../../types";
import { audioOps } from "./audio";
import type { EditorOpContext } from "./types";

const resolveSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/exporter/localMediaSource", async (importActual) => ({
	...(await importActual<typeof import("@/lib/exporter/localMediaSource")>()),
	resolveMediaElementSource: resolveSource,
}));

type Clip = { id: string; startMs: number; endMs: number; speed: number; muted?: boolean };
type TrackSettings = Record<string, { volume: number; normalize: boolean }>;

function makeContext(
	options: {
		regions?: AudioRegion[];
		clips?: Clip[];
		tracks?: TrackSettings;
		durationSec?: number;
	} = {},
) {
	const state = {
		regions: options.regions ?? [],
		clips: options.clips ?? [],
		defaults: options.tracks ?? { mic: { volume: 1, normalize: false } },
		byClip: {} as Record<string, TrackSettings>,
		selected: null as string | null,
	};
	const apply = <T>(current: T, next: unknown) =>
		typeof next === "function" ? (next as (value: T) => T)(current) : (next as T);
	const context = {
		duration: options.durationSec ?? 10,
		videoSourcePath: "/tmp/take.mp4",
		timeline: {
			get clipRegions() {
				return state.clips;
			},
			get audioRegions() {
				return state.regions;
			},
			get selectedAudioId() {
				return state.selected;
			},
			get defaultSourceAudioTrackSettings() {
				return state.defaults;
			},
			setAudioRegions: (next: unknown) => {
				state.regions = apply(state.regions, next);
			},
			setSelectedAudioId: (id: string | null) => {
				state.selected = id;
			},
			setClipRegions: (next: unknown) => {
				state.clips = apply(state.clips, next);
			},
			setDefaultSourceAudioTrackSettings: (next: unknown) => {
				state.defaults = apply(state.defaults, next);
			},
			setSourceAudioTrackSettingsByClip: (next: unknown) => {
				state.byClip = apply(state.byClip, next);
			},
		},
		ids: {
			zoom: { current: 1 },
			clip: { current: 1 },
			audio: { current: 1 },
			annotation: { current: 1 },
			annotationZIndex: { current: 1 },
		},
		assertSameRecording: () => undefined,
	} as unknown as EditorOpContext;
	return { state, context };
}

const run = (op: string, payload: unknown, context: EditorOpContext) =>
	audioOps[op](payload, context) as never;

function stubAudio(durationSec: number | "error" | "never") {
	class FakeAudio {
		duration = durationSec === "error" || durationSec === "never" ? 0 : durationSec;
		private listeners: Record<string, () => void> = {};
		addEventListener(name: string, handler: () => void) {
			this.listeners[name] = handler;
		}
		removeAttribute() {}
		load() {}
		set src(_value: string) {
			if (durationSec === "never") return;
			queueMicrotask(() =>
				this.listeners[durationSec === "error" ? "error" : "loadedmetadata"]?.(),
			);
		}
	}
	vi.stubGlobal("Audio", FakeAudio);
}

const region = (over: Partial<AudioRegion> = {}): AudioRegion => ({
	id: "r1",
	startMs: 0,
	endMs: 2000,
	audioPath: "/a.mp3",
	volume: 1,
	trackIndex: 0,
	...over,
});

beforeEach(() => {
	resolveSource.mockImplementation(async (resource: string) => ({
		src: resource,
		revoke: () => undefined,
	}));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("audio.add", () => {
	it("adds a region at the start time, selects it and keeps the file's own length", async () => {
		stubAudio(3);
		const { state, context } = makeContext();
		const result = (await run(
			"audio.add",
			{ path: "/music/theme.mp3", startMs: 1000, volume: 0.4 },
			context,
		)) as {
			id: string;
			trimmed: boolean;
		};
		expect(state.regions).toEqual([
			expect.objectContaining({
				id: result.id,
				startMs: 1000,
				endMs: 4000,
				volume: 0.4,
				audioPath: "/music/theme.mp3",
				trackIndex: 0,
			}),
		]);
		expect(state.selected).toBe(result.id);
		expect(result.trimmed).toBe(false);
	});

	it("trims to durationMs and to the end of the recording, and says so", async () => {
		stubAudio(60);
		const { state, context } = makeContext();
		const result = (await run("audio.add", { path: "/a.wav", startMs: 8000 }, context)) as {
			trimmed: boolean;
		};
		expect([state.regions[0].startMs, state.regions[0].endMs, result.trimmed]).toEqual([
			8000,
			10000,
			true,
		]);
		const second = makeContext();
		await run("audio.add", { path: "/a.wav", durationMs: 1500 }, second.context);
		expect(second.state.regions[0].endMs).toBe(1500);
	});

	it("moves to a free track when the first is taken and refuses a taken explicit track", async () => {
		stubAudio(2);
		const { state, context } = makeContext({ regions: [region({ endMs: 5000 })] });
		await run("audio.add", { path: "/a.mp3", startMs: 1000 }, context);
		expect(state.regions[1].trackIndex).toBe(1);
		await expect(
			run("audio.add", { path: "/a.mp3", startMs: 1000, trackIndex: 0 }, context),
		).rejects.toThrow(/no room/);
		expect(state.regions).toHaveLength(2);
	});

	it.each([
		["a relative path", { path: "a.mp3" }, /absolute path/],
		["no path", {}, /absolute path/],
		["a video file", { path: "/a.mp4" }, /must be an audio file/],
		["a start past the end", { path: "/a.mp3", startMs: 10000 }, /startMs must be/],
		["a negative start", { path: "/a.mp3", startMs: -5 }, /startMs must be/],
		["a volume above 1", { path: "/a.mp3", volume: 1.5 }, /volume must be/],
		["a negative volume", { path: "/a.mp3", volume: -0.1 }, /volume must be/],
		["a zero duration", { path: "/a.mp3", durationMs: 0 }, /durationMs/],
		["a fractional track", { path: "/a.mp3", trackIndex: 0.5 }, /whole number/],
		[
			"a non-finite start",
			{ path: "/a.mp3", startMs: Number.POSITIVE_INFINITY },
			/must be a number/,
		],
	])("rejects %s before reading the file", async (_name, payload, message) => {
		const probe = vi.fn();
		vi.stubGlobal("Audio", probe);
		const { state, context } = makeContext();
		await expect(run("audio.add", payload, context)).rejects.toThrow(message);
		expect(probe).not.toHaveBeenCalled();
		expect(state.regions).toEqual([]);
	});

	it("rejects a file that is missing or not playable and changes nothing", async () => {
		stubAudio("error");
		const { state, context } = makeContext();
		await expect(run("audio.add", { path: "/gone.mp3" }, context)).rejects.toThrow(
			/does not exist or is not audio/,
		);
		expect(state.regions).toEqual([]);
	});

	it("gives up when the media server never answers, and when it fails", async () => {
		vi.useFakeTimers();
		stubAudio(3);
		resolveSource.mockReturnValueOnce(new Promise(() => undefined));
		const first = makeContext();
		const pending = run("audio.add", { path: "/slow.mp3" }, first.context) as Promise<unknown>;
		const assertion = expect(pending).rejects.toThrow(/Timed out reading/);
		await vi.advanceTimersByTimeAsync(10_001);
		await assertion;
		expect(first.state.regions).toEqual([]);
		resolveSource.mockRejectedValueOnce(new Error("media server down"));
		await expect(run("audio.add", { path: "/a.mp3" }, makeContext().context)).rejects.toThrow(
			/Could not open \/a.mp3: media server down/,
		);
	});

	it("releases the player after a failed read", async () => {
		const removeAttribute = vi.fn();
		const revoke = vi.fn();
		resolveSource.mockResolvedValueOnce({ src: "/gone.mp3", revoke });
		class Failing {
			private onError: () => void = () => undefined;
			addEventListener(name: string, handler: () => void) {
				if (name === "error") this.onError = handler;
			}
			removeAttribute = removeAttribute;
			load() {}
			set src(_value: string) {
				queueMicrotask(this.onError);
			}
		}
		vi.stubGlobal("Audio", Failing);
		await expect(
			run("audio.add", { path: "/gone.mp3" }, makeContext().context),
		).rejects.toThrow(/not audio/);
		expect(removeAttribute).toHaveBeenCalledWith("src");
		expect(revoke).toHaveBeenCalledTimes(1);
	});

	it("says there is no recording when its length is unknown", async () => {
		stubAudio(3);
		await expect(
			run("audio.add", { path: "/a.mp3" }, makeContext({ durationSec: 0 }).context),
		).rejects.toThrow(/no recording loaded/);
	});

	it("revokes a source that resolves after the read already timed out", async () => {
		vi.useFakeTimers();
		stubAudio("never");
		const revoke = vi.fn();
		let resolveLate: (value: { src: string; revoke: () => void }) => void = () => undefined;
		resolveSource.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveLate = resolve;
			}),
		);
		const pending = run(
			"audio.add",
			{ path: "/slow.mp3" },
			makeContext().context,
		) as Promise<unknown>;
		const assertion = expect(pending).rejects.toThrow(/Timed out reading/);
		await vi.advanceTimersByTimeAsync(10_001);
		await assertion;
		resolveLate({ src: "/slow.mp3", revoke });
		await vi.advanceTimersByTimeAsync(0);
		expect(revoke).toHaveBeenCalledTimes(1);
	});

	it("never writes a region of no length from fractional times", async () => {
		stubAudio(3);
		const { state, context } = makeContext();
		await expect(
			run("audio.add", { path: "/a.mp3", startMs: 9999.6 }, context),
		).rejects.toThrow(/startMs must be/);
		await expect(
			run("audio.add", { path: "/a.mp3", durationMs: 0.4 }, context),
		).rejects.toThrow(/durationMs/);
		expect(state.regions).toEqual([]);
	});

	it("rejects a zero-length file", async () => {
		stubAudio(0);
		const { context } = makeContext();
		await expect(run("audio.add", { path: "/empty.mp3" }, context)).rejects.toThrow(
			/no playable audio/,
		);
	});

	it("gives up when reading the file never finishes", async () => {
		vi.useFakeTimers();
		stubAudio("never");
		const { state, context } = makeContext();
		const pending = run("audio.add", { path: "/slow.mp3" }, context) as Promise<unknown>;
		const assertion = expect(pending).rejects.toThrow(/Timed out reading/);
		await vi.advanceTimersByTimeAsync(10_001);
		await assertion;
		expect(state.regions).toEqual([]);
	});
});

describe("audio.remove and audio.volume", () => {
	it("removes a region and clears its selection", () => {
		const { state, context } = makeContext({ regions: [region(), region({ id: "r2" })] });
		state.selected = "r1";
		run("audio.remove", { id: "r1" }, context);
		expect(state.regions.map((value) => value.id)).toEqual(["r2"]);
		expect(state.selected).toBeNull();
	});

	it("sets the volume, including both ends of its range", () => {
		const { state, context } = makeContext({ regions: [region()] });
		run("audio.volume", { id: "r1", volume: 0 }, context);
		expect(state.regions[0].volume).toBe(0);
		run("audio.volume", { id: "r1", volume: 1 }, context);
		expect(state.regions[0].volume).toBe(1);
	});

	it.each([
		["audio.remove", { id: "zz" }, /no audio region/],
		["audio.volume", { id: "zz", volume: 0.5 }, /no audio region/],
		["audio.volume", { id: "r1", volume: 1.01 }, /volume must be/],
		["audio.volume", { id: "r1", volume: Number.NaN }, /must be a number/],
		["audio.volume", { volume: 0.5 }, /id must be/],
	])("%s rejects %j and changes nothing", (op, payload, message) => {
		const regions = [region()];
		const { state, context } = makeContext({ regions });
		expect(() => run(op, payload, context)).toThrow(message);
		expect(state.regions).toBe(regions);
	});
});

describe("audio.mute_source", () => {
	const clips = [
		{ id: "a", startMs: 0, endMs: 1000, speed: 1 },
		{ id: "b", startMs: 1000, endMs: 2000, speed: 1 },
	];

	it("mutes every clip, or just one, and unmutes", () => {
		const { state, context } = makeContext({ clips });
		run("audio.mute_source", { muted: true }, context);
		expect(state.clips.map((clip) => clip.muted)).toEqual([true, true]);
		run("audio.mute_source", { muted: false, clipId: "b" }, context);
		expect(state.clips.map((clip) => clip.muted)).toEqual([true, false]);
	});

	it("rejects a non-boolean, an unknown clip and a recording with no clips", () => {
		expect(() =>
			run("audio.mute_source", { muted: "yes" }, makeContext({ clips }).context),
		).toThrow(/true or false/);
		expect(() =>
			run("audio.mute_source", { muted: true, clipId: "zz" }, makeContext({ clips }).context),
		).toThrow(/no clip/);
		expect(() => run("audio.mute_source", { muted: true }, makeContext().context)).toThrow(
			/no clips yet/,
		);
	});
});

describe("audio.source_track", () => {
	it("sets volume for every clip and keeps the other field", () => {
		const { state, context } = makeContext({
			tracks: {
				mic: { volume: 1, normalize: true },
				system: { volume: 1, normalize: false },
			},
		});
		run("audio.source_track", { track: "mic", volume: 0.25 }, context);
		expect(state.defaults.mic).toEqual({ volume: 0.25, normalize: true });
		expect(state.defaults.system).toEqual({ volume: 1, normalize: false });
	});

	it("keeps the clip's own volume when only normalize changes", () => {
		const { state, context } = makeContext({
			clips: [{ id: "a", startMs: 0, endMs: 1, speed: 1 }],
		});
		run("audio.source_track", { track: "mic", volume: 0.3, clipId: "a" }, context);
		run("audio.source_track", { track: "mic", normalize: true, clipId: "a" }, context);
		expect(state.byClip.a.mic).toEqual({ volume: 0.3, normalize: true });
	});

	it("scopes a change to one clip", () => {
		const { state, context } = makeContext({
			clips: [{ id: "a", startMs: 0, endMs: 1, speed: 1 }],
		});
		run("audio.source_track", { track: "mic", normalize: true, clipId: "a" }, context);
		expect(state.byClip.a.mic).toEqual({ volume: 1, normalize: true });
		expect(state.defaults.mic.normalize).toBe(false);
	});

	it.each([
		[{ track: "nope", volume: 0.5 }, /no source track "nope"/],
		[{ track: "mic" }, /volume, normalize/],
		[{ track: "mic", volume: 2 }, /volume must be/],
		[{ track: "mic", normalize: "on" }, /true or false/],
		[{ track: "mic", volume: 0.5, clipId: "zz" }, /no clip/],
	])("rejects %j", (payload, message) => {
		const { state, context } = makeContext();
		const before = state.defaults;
		expect(() => run("audio.source_track", payload, context)).toThrow(message);
		expect(state.defaults).toBe(before);
	});

	it("says so when the tracks have not loaded", () => {
		expect(() =>
			run(
				"audio.source_track",
				{ track: "mic", volume: 1 },
				makeContext({ tracks: {} }).context,
			),
		).toThrow(/not loaded yet/);
	});
});
