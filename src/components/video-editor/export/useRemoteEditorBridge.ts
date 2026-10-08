import { useEffect, useRef } from "react";
import type { useAppearanceState } from "../state/useAppearanceState";
import type { useTimelineState } from "../state/useTimelineState";
import { getTimelineDurationMs } from "../types";
import { runEditorOp } from "./editorOps";
import type { EditorOpContext } from "./editorOps/types";

type Input = {
	ready: boolean;
	duration: number;
	videoSourcePath: string | null;
	timeline: ReturnType<typeof useTimelineState>;
	appearance: ReturnType<typeof useAppearanceState>;
	history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
	ids: EditorOpContext["ids"];
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

function runOp(op: string, payload: unknown, editor: Editor) {
	if (op === "get_state") return getState(editor);
	return runEditorOp(op, payload, {
		duration: editor.duration,
		videoSourcePath: editor.videoSourcePath,
		timeline: editor.timeline,
		appearance: editor.appearance,
		history: editor.history,
		ids: editor.ids,
	});
}

export function useRemoteEditorBridge(input: Input) {
	const latestRef = useRef(input);
	latestRef.current = input;
	const queueRef = useRef<Promise<unknown>>(Promise.resolve());

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
					const run = queueRef.current.then(() =>
						runOp(request.op, request.payload, latestRef.current),
					);
					queueRef.current = run.catch(() => undefined);
					reply({ ok: true, data: await run });
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
