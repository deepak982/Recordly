import { isAbsoluteLocalPath } from "@/lib/exporter/localMediaSource";
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

function requireClip(id: string, context: EditorOpContext) {
	const ids = context.timeline.clipRegions.map((clip) => clip.id);
	if (!ids.includes(id)) {
		throw new Error(`There is no clip with id "${id}". Clips: ${ids.join(", ")}.`);
	}
}

function requireVolume(value: unknown) {
	const volume = requireFiniteNumber(value, "volume");
	if (volume < 0 || volume > 1) throw new Error("volume must be from 0 (silent) to 1 (full).");
	return volume;
}

function requireAudioRegion(id: string, context: EditorOpContext) {
	const region = context.timeline.audioRegions.find((value) => value.id === id);
	if (!region) {
		const ids = context.timeline.audioRegions.map((value) => value.id);
		throw new Error(
			`There is no audio region with id "${id}". ${ids.length > 0 ? `Audio regions: ${ids.join(", ")}.` : "There are no audio regions; add one with audio.add."}`,
		);
	}
	return region;
}

async function resolveReadableUrl(audioPath: string) {
	const getUrl = window.electronAPI?.getLocalMediaUrl;
	if (!getUrl) throw new Error("Audio files can only be read inside the Recordly app.");
	const result = await getUrl(audioPath);
	if (!result.success) {
		throw new Error(
			`Recordly is not allowed to read ${audioPath}. Only files you have chosen in Recordly can be read, so pick the file with the Add audio control once, or check that the path exists, is a file and is an mp3, wav or ogg.`,
		);
	}
	return result.url;
}

function probeAudioDurationMs(audioPath: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const audio = new Audio();
		let settled = false;
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			audio.removeAttribute("src");
			audio.load();
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
							`${audioPath} was found but the editor could not decode it. It has no audio track or uses a format the editor cannot play.`,
						),
					),
				),
			{ once: true },
		);
		resolveReadableUrl(audioPath).then(
			(src) => {
				if (!settled) audio.src = src;
			},
			(error) => finish(() => reject(error)),
		);
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
		if (totalMs <= 0)
			throw new Error(
				"There is no recording loaded to add audio to. Call get_editor_state to check that durationMs is above 0.",
			);
		const startMs = Math.round(
			args.startMs === undefined ? 0 : requireFiniteNumber(args.startMs, "startMs"),
		);
		if (startMs < 0 || startMs >= totalMs) {
			throw new Error(
				`startMs must be from 0 up to the end of the recording at ${totalMs} ms.`,
			);
		}
		const volume = args.volume === undefined ? 1 : requireVolume(args.volume);
		let requestedMs: number | undefined;
		if (args.durationMs !== undefined) {
			requestedMs = Math.round(requireFiniteNumber(args.durationMs, "durationMs"));
			if (requestedMs <= 0) throw new Error("durationMs must be more than 0.");
		}
		let trackIndex: number | undefined;
		if (args.trackIndex !== undefined) {
			trackIndex = requireFiniteNumber(args.trackIndex, "trackIndex");
			if (!Number.isInteger(trackIndex) || trackIndex < 0) {
				throw new Error("trackIndex must be a whole number of 0 or more.");
			}
		}

		const supplied = args.fileDurationMs;
		const fileMs =
			typeof supplied === "number" && Number.isFinite(supplied) && supplied > 0
				? supplied
				: await probeAudioDurationMs(path);
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
			startMs,
			endMs: startMs + Math.round(placement.durationMs),
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
				"The timeline has no clips yet. Call get_editor_state until its clips list is not empty, then try again.",
			);
		}
		let targets = clips;
		if (args.clipId !== undefined) {
			const clipId = requireId(args.clipId, "clipId");
			requireClip(clipId, context);
			targets = clips.filter((clip) => clip.id === clipId);
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
		if (!context.videoSourcePath) throw new Error("There is no recording loaded.");
		const known = Object.keys(context.timeline.defaultSourceAudioTrackSettings);
		if (known.length === 0) {
			throw new Error(
				'The recording\'s sound tracks are not available. Call get_editor_state and read sourceAudio.status: "loading" means they are still being read, so retry in a moment; "none" means this recording captured no audio and there is nothing to adjust; "ready" means they are listed in sourceAudio.default.',
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
		requireClip(clipId, context);
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
