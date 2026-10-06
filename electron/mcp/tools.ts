import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { MAX_COUNTDOWN_SECONDS, type RemoteControl } from "./remoteControl";
import type { RemoteExport } from "./remoteExport";

const INSTRUCTIONS =
	"Recordly records the screen and turns recordings into polished demo videos " +
	"(automatic zoom on clicks, smooth cursor). Typical flow: list_sources → select_source " +
	'(e.g. { name: "Chrome" }) → start_recording → perform the demo → stop_recording (returns the ' +
	"saved video path and opens the editor) → export_video. Call get_status at any time to see the " +
	"recorder state. Tools refuse with a clear message instead of showing dialogs; relay permission " +
	"errors to the user, who must fix them in System Settings.";

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function buildRecordlyMcpServer(
	remote: RemoteControl,
	remoteExport: RemoteExport,
	version: string,
) {
	const server = new McpServer({ name: "recordly", version }, { instructions: INSTRUCTIONS });

	server.registerTool(
		"get_status",
		{
			description:
				"Current recorder state (idle, starting, countdown, recording, paused, stopping, " +
				"finalizing), the " +
				"selected capture source, the path of the last recording, macOS permission status, and " +
				"the state/progress of the last export.",
			annotations: { readOnlyHint: true },
		},
		async () => textResult({ ...remote.getStatus(), export: remoteExport.getStatus() }),
	);

	server.registerTool(
		"list_sources",
		{
			description:
				"List capturable screens and windows (id, name, type, appName). Use an id or name with select_source.",
			annotations: { readOnlyHint: true },
		},
		async () => textResult(await remote.listSources()),
	);

	server.registerTool(
		"select_source",
		{
			description:
				"Choose what to record, by exact id or by a case-insensitive name substring (matched against " +
				"the source name and app name). Fails if no source or more than one matches, listing the " +
				"candidates. Raises the window without stealing focus.",
			inputSchema: z.object({
				id: z.string().min(1).optional().describe("Exact source id from list_sources"),
				name: z.string().min(1).optional().describe('Name substring, e.g. "Chrome"'),
			}),
		},
		async (args) => textResult(await remote.selectSource(args)),
	);

	server.registerTool(
		"start_recording",
		{
			description:
				"Start recording the selected source. Returns once capture is actually running (after the " +
				"countdown). Refuses if no source is selected, permissions are missing, or a recording is " +
				"already running or still being saved.",
			inputSchema: z.object({
				countdownSeconds: z
					.number()
					.int()
					.min(0)
					.max(MAX_COUNTDOWN_SECONDS)
					.optional()
					.describe("Countdown before capture starts; defaults to the user's setting"),
			}),
		},
		async (args) => textResult(await remote.startRecording(args)),
	);

	server.registerTool(
		"pause_recording",
		{ description: "Pause the running recording." },
		async () => {
			await remote.pauseRecording();
			return textResult({ state: "paused" });
		},
	);

	server.registerTool(
		"resume_recording",
		{ description: "Resume a paused recording." },
		async () => {
			await remote.resumeRecording();
			return textResult({ state: "recording" });
		},
	);

	server.registerTool(
		"stop_recording",
		{
			description:
				"Stop and save the recording. Returns the saved video path once it is written; the editor " +
				"then opens with automatic zooms applied.",
		},
		async () => textResult(await remote.stopRecording()),
	);

	server.registerTool(
		"cancel_recording",
		{
			description:
				"Discard the running recording, or abort the countdown before capture starts.",
			annotations: { destructiveHint: true },
		},
		async () => {
			await remote.cancelRecording();
			return textResult({ cancelled: true });
		},
	);

	server.registerTool(
		"export_video",
		{
			description:
				"Export the last recording to a video file with no dialog, using the editor's current look " +
				"(automatic zooms, cursor, background). Waits for the editor to finish loading, then returns " +
				'the saved path. A very long export returns { status: "still-exporting" } — then poll ' +
				"get_status until export.state is done or failed.",
			inputSchema: z.object({
				outputPath: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Absolute path ending in .mp4 or .gif; defaults to the recordings folder",
					),
				format: z.enum(["mp4", "gif"]).optional().describe("Defaults to mp4"),
				quality: z
					.enum(["medium", "good", "high", "source"])
					.optional()
					.describe("Defaults to good"),
				overwrite: z
					.boolean()
					.optional()
					.describe("Replace an existing file at outputPath"),
			}),
		},
		async (args, ctx) => {
			const { state, lastRecordingPath } = remote.getStatus();
			if (state !== "idle" && state !== "finalizing") {
				throw new Error(
					`Recordly is ${state}. Finish with stop_recording before calling export_video.`,
				);
			}
			const progressToken = ctx.mcpReq._meta?.progressToken;
			const onProgress =
				progressToken === undefined
					? undefined
					: (progress: number) =>
							void ctx.mcpReq
								.notify({
									method: "notifications/progress",
									params: { progressToken, progress, total: 100 },
								})
								.catch(() => undefined);
			return textResult(
				await remoteExport.exportVideo(
					{ ...args, videoPath: lastRecordingPath },
					{ signal: ctx.mcpReq.signal, onProgress },
				),
			);
		},
	);

	return server;
}
