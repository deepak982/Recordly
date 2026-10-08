import { useEffect, useRef } from "react";
import type { useTimelineState } from "../state/useTimelineState";
import { getTimelineDurationMs } from "../types";

type Input = {
	ready: boolean;
	duration: number;
	videoSourcePath: string | null;
	timeline: ReturnType<typeof useTimelineState>;
};

type Editor = Input;

function getState({ duration, videoSourcePath, timeline }: Editor) {
	const sourceDurationMs = Math.round(duration * 1000);
	return {
		videoPath: videoSourcePath,
		durationMs: getTimelineDurationMs(timeline.clipRegions, sourceDurationMs),
		sourceDurationMs,
		clips: timeline.clipRegions,
		zooms: timeline.zoomRegions,
		annotations: timeline.annotationRegions,
		audio: timeline.audioRegions,
		captions: timeline.autoCaptions,
	};
}

function runOp(op: string, _payload: unknown, editor: Editor) {
	switch (op) {
		case "get_state":
			return getState(editor);
		default:
			throw new Error(`The editor does not support "${op}".`);
	}
}

export function useRemoteEditorBridge(input: Input) {
	const latestRef = useRef(input);
	latestRef.current = input;

	useEffect(
		() =>
			window.electronAPI.onRemoteEditorRequest?.(async (request) => {
				const reply = (result: Omit<RemoteEditorResult, "id">) =>
					window.electronAPI.sendRemoteEditorResult({ id: request.id, ...result });
				const editor = latestRef.current;
				if (!editor.ready) {
					reply({ ok: false, error: "The editor is still loading the recording." });
					return;
				}
				try {
					reply({
						ok: true,
						data: await runOp(request.op, request.payload, latestRef.current),
					});
				} catch (error) {
					reply({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		[],
	);
}
