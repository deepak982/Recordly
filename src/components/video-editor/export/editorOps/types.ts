import type { MutableRefObject } from "react";
import type { useAppearanceState } from "../../state/useAppearanceState";
import type { useTimelineState } from "../../state/useTimelineState";

export type EditorOpContext = {
	// Seconds of the source recording, not milliseconds and not the edited length.
	duration: number;
	videoSourcePath: string | null;
	timeline: ReturnType<typeof useTimelineState>;
	appearance: ReturnType<typeof useAppearanceState>;
	history: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
	// The editor's own counters, so an op's ids are the same as a hand edit's.
	ids: {
		zoom: MutableRefObject<number>;
		clip: MutableRefObject<number>;
		audio: MutableRefObject<number>;
		annotation: MutableRefObject<number>;
		annotationZIndex: MutableRefObject<number>;
	};
};

export function nextId(ref: MutableRefObject<number>, prefix: string): string {
	const value = ref.current;
	ref.current = value + 1;
	return `${prefix}-${value}`;
}

export type EditorOp = (payload: unknown, context: EditorOpContext) => unknown;

export type EditorOpMap = Record<string, EditorOp>;

export function requireObject(payload: unknown, op: string): Record<string, unknown> {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error(`${op} needs an object of arguments.`);
	}
	return payload as Record<string, unknown>;
}

export function requireFiniteNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${field} must be a number.`);
	}
	return value;
}
