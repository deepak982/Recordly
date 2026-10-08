import { annotationsOps } from "./annotations";
import { audioOps } from "./audio";
import { captionsOps } from "./captions";
import { cardsOps } from "./cards";
import { historyOps } from "./history";
import { lookOps } from "./look";
import { timelineOps } from "./timeline";
import type { EditorOpContext, EditorOpMap } from "./types";
import { zoomOps } from "./zoom";

const ops: EditorOpMap = {
	...timelineOps,
	...zoomOps,
	...annotationsOps,
	...captionsOps,
	...audioOps,
	...lookOps,
	...historyOps,
	...cardsOps,
};

export function runEditorOp(op: string, payload: unknown, context: EditorOpContext) {
	const handler = ops[op];
	if (!handler) throw new Error(`The editor does not support "${op}".`);
	return handler(payload, context);
}

export type { EditorOpContext, EditorOpMap } from "./types";
