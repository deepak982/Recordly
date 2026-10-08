import { isAbsoluteLocalPath, resolveMediaElementSource } from "@/lib/exporter/localMediaSource";
import type { SourceAudioTrackSetting } from "../../audio/audioTypes";
import { resolveAudioPlacement } from "../../timeline/hooks/utils/timelineAudioPlacement";
import { type AudioRegion, getTimelineDurationMs } from "../../types";
import {
	type EditorOpContext,
	type EditorOpMap,
	nextId,
	requireFiniteNumber,
	requireObject,
} from "./types";

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"];
const PROBE_TIMEOUT_MS = 10 * 1000;

function requireId(value: unknown, field: string) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${field} must be a non-empty string.`);
	}
	return value;
}

function requireVolume(value: unknown) {
	const volume = requireFiniteNumber(value, "volume");
	if (volume < 0 || volume > 1) throw new Error("volume must be from 0 (silent) to 1 (full).");
	return volume;
}

function requireAudioRegion(id: string, context: EditorOpContext) {
	const region = context.timeline.audioRegions.find((value) => value.id === id);
	if (!region) throw new Error(`There is no audio region with id "${id}".`);
	return region;
}

async function probeAudioDurationMs(audioPath: string): Promise<number> {
	const resolved = await resolveMediaElementSource(audioPath);
	return new Promise<number>((resolve, reject) => {
		const audio = new Audio();
		const finish = (settle: () => void) => {
			clearTimeout(timer);
			audio.removeAttribute("src");
			audio.load();
			resolved.revoke();
			settle();
		};
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(
						new Error(
							`Timed out reading ${audioPath}. The file may be on a slow or missing drive.`,
						),
					),
				),
			PROBE_TIMEOUT_MS,
		);
		audio.addEventListener(
			"loadedmetadata",
			() => finish(() => resolve(Math.round(audio.duration * 1000))),
			{ once: true },
		);
		audio.addEventListener(
			"error",
			() =>
				finish(() =>
					reject(
						new Error(
							`${audioPath} does not exist or is not audio the editor can play.`,
						),
					),
				),
			{ once: true },
		);
		audio.src = resolved.src;
	});
}

export const audioOps: EditorOpMap = {
	"audio.add": async (payload, context) => {
		const args = requireObject(payload, "audio.add");
		const path = args.path;
		if (typeof path !== "string" || !isAbsoluteLocalPath(path)) {
			throw new Error("path must be the absolute path of an audio file on this computer.");
		}
		if (!AUDIO_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) {
			throw new Error(`path must be an audio file: ${AUDIO_EXTENSIONS.join(", ")}.`);
		}
		const totalMs = getTimelineDurationMs(
			context.timeline.clipRegions,
			Math.round(context.duration * 1000),
		);
		if (totalMs <= 0) throw new Error("There is no recording loaded to add audio to.");
		const startMs =
			args.startMs === undefined ? 0 : requireFiniteNumber(args.startMs, "startMs");
		if (startMs < 0 || startMs >= totalMs) {
			throw new Error(
				`startMs must be from 0 up to the end of the recording at ${totalMs} ms.`,
			);
		}
		const volume = args.volume === undefined ? 1 : requireVolume(args.volume);
		let requestedMs: number | undefined;
		if (args.durationMs !== undefined) {
			requestedMs = requireFiniteNumber(args.durationMs, "durationMs");
			if (requestedMs <= 0) throw new Error("durationMs must be more than 0.");
		}
		let trackIndex: number | undefined;
		if (args.trackIndex !== undefined) {
			trackIndex = requireFiniteNumber(args.trackIndex, "trackIndex");
			if (!Number.isInteger(trackIndex) || trackIndex < 0) {
				throw new Error("trackIndex must be a whole number of 0 or more.");
			}
		}

		const fileMs = await probeAudioDurationMs(path);
		if (!Number.isFinite(fileMs) || fileMs <= 0) {
			throw new Error(`${path} has no playable audio.`);
		}
		const wantedMs = Math.min(fileMs, requestedMs ?? fileMs);
		const placement = resolveAudioPlacement({
			audioRegions: context.timeline.audioRegions,
			startPos: startMs,
			totalMs,
			audioDurationMs: wantedMs,
			preferredTrackIndex: trackIndex,
		});
		if (!placement) {
			throw new Error(
				"There is no room for this audio at that time. Pick another startMs or trackIndex.",
			);
		}
		const region: AudioRegion = {
			id: nextId(context.ids.audio, "audio"),
			startMs: Math.round(startMs),
			endMs: Math.round(startMs + placement.durationMs),
			audioPath: path,
			volume,
			normalize: false,
			trackIndex: placement.trackIndex,
		};
		context.timeline.setAudioRegions((current) => [...current, region]);
		context.timeline.setSelectedAudioId(region.id);
		return {
			id: region.id,
			startMs: region.startMs,
			endMs: region.endMs,
			trackIndex: placement.trackIndex,
			trimmed: placement.durationMs < wantedMs,
		};
	},

	"audio.remove": (payload, context) => {
		const id = requireId(requireObject(payload, "audio.remove").id, "id");
		requireAudioRegion(id, context);
		context.timeline.setAudioRegions((current) => current.filter((region) => region.id !== id));
		if (context.timeline.selectedAudioId === id) context.timeline.setSelectedAudioId(null);
		return { removed: id };
	},

	"audio.volume": (payload, context) => {
		const args = requireObject(payload, "audio.volume");
		const id = requireId(args.id, "id");
		const volume = requireVolume(args.volume);
		requireAudioRegion(id, context);
		context.timeline.setAudioRegions((current) =>
			current.map((region) => (region.id === id ? { ...region, volume } : region)),
		);
		return { id, volume };
	},

	"audio.mute_source": (payload, context) => {
		const args = requireObject(payload, "audio.mute_source");
		if (typeof args.muted !== "boolean") throw new Error("muted must be true or false.");
		const clips = context.timeline.clipRegions;
		if (clips.length === 0) {
			throw new Error(
				"The recording has no clips yet, and the source sound is muted per clip. Split or trim the recording once, then mute it.",
			);
		}
		let targets = clips;
		if (args.clipId !== undefined) {
			const clipId = requireId(args.clipId, "clipId");
			targets = clips.filter((clip) => clip.id === clipId);
			if (targets.length === 0) throw new Error(`There is no clip with id "${clipId}".`);
		}
		const ids = new Set(targets.map((clip) => clip.id));
		const muted = args.muted;
		context.timeline.setClipRegions((current) =>
			current.map((clip) => (ids.has(clip.id) ? { ...clip, muted } : clip)),
		);
		return { muted, clips: [...ids] };
	},

	"audio.source_track": (payload, context) => {
		const args = requireObject(payload, "audio.source_track");
		const track = requireId(args.track, "track");
		const known = Object.keys(context.timeline.defaultSourceAudioTrackSettings);
		if (known.length === 0) {
			throw new Error(
				"The recording's sound tracks have not loaded yet. Try again in a moment.",
			);
		}
		if (!known.includes(track)) {
			throw new Error(`There is no source track "${track}". Tracks: ${known.join(", ")}.`);
		}
		if (args.volume === undefined && args.normalize === undefined) {
			throw new Error("Give volume, normalize, or both.");
		}
		const volume = args.volume === undefined ? undefined : requireVolume(args.volume);
		if (args.normalize !== undefined && typeof args.normalize !== "boolean") {
			throw new Error("normalize must be true or false.");
		}
		const normalize = args.normalize as boolean | undefined;
		const change = (
			previous: SourceAudioTrackSetting | undefined,
		): SourceAudioTrackSetting => ({
			volume: volume ?? previous?.volume ?? 1,
			normalize: normalize ?? previous?.normalize ?? false,
		});
		if (args.clipId === undefined) {
			context.timeline.setDefaultSourceAudioTrackSettings((current) => ({
				...current,
				[track]: change(current[track]),
			}));
			return { track, scope: "every clip", volume, normalize };
		}
		const clipId = requireId(args.clipId, "clipId");
		if (!context.timeline.clipRegions.some((clip) => clip.id === clipId)) {
			throw new Error(`There is no clip with id "${clipId}".`);
		}
		context.timeline.setSourceAudioTrackSettingsByClip((current) => {
			const base = {
				...context.timeline.defaultSourceAudioTrackSettings,
				...(current[clipId] ?? {}),
			};
			return { ...current, [clipId]: { ...base, [track]: change(base[track]) } };
		});
		return { track, scope: clipId, volume, normalize };
	},
};
