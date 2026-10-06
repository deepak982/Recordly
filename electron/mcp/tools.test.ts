import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./remoteControl", () => ({ MAX_COUNTDOWN_SECONDS: 10 }));

import type { RemoteControl } from "./remoteControl";
import type { RemoteExport } from "./remoteExport";
import { buildRecordlyMcpServer } from "./tools";

function setup(state = "idle") {
	const remote = {
		getStatus: () => ({ state, lastRecordingPath: "/rec/recording-1.mp4" }),
		startRecording: vi.fn(async () => {
			throw new Error("No capture source is selected.");
		}),
	} as unknown as RemoteControl;
	const remoteExport = {
		getStatus: () => ({ state: "idle", progress: null, outputPath: null, error: null }),
		exportVideo: vi.fn(async (_args, opts?: { onProgress?: (pct: number) => void }) => {
			opts?.onProgress?.(50);
			return { status: "done" as const, path: "/out/demo.mp4" };
		}),
	} as unknown as RemoteExport;
	const handler = createMcpHandler(() => buildRecordlyMcpServer(remote, remoteExport, "1.0.0"));

	async function call(method: string, params?: Record<string, unknown>) {
		const response = await handler.fetch(
			new Request("http://127.0.0.1/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": "2025-11-25",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			}),
		);
		const text = await response.text();
		const messages = response.headers.get("content-type")?.includes("text/event-stream")
			? text
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => JSON.parse(line.slice("data:".length)))
			: [JSON.parse(text)];
		return { result: messages.at(-1).result, messages };
	}

	return { remote, remoteExport, call };
}

describe("buildRecordlyMcpServer", () => {
	it("exposes the full recording and export tool set", async () => {
		const { call } = setup();
		const { result } = await call("tools/list");
		expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
			"cancel_recording",
			"export_video",
			"get_status",
			"list_sources",
			"pause_recording",
			"resume_recording",
			"select_source",
			"start_recording",
			"stop_recording",
		]);
	});

	it("returns controller refusals as tool errors the agent can read", async () => {
		const { call } = setup();
		const { result } = await call("tools/call", { name: "start_recording", arguments: {} });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("No capture source is selected.");
	});

	it("rejects an out-of-range countdown before reaching the controller", async () => {
		const { call, remote } = setup();
		const { result } = await call("tools/call", {
			name: "start_recording",
			arguments: { countdownSeconds: 60 },
		});
		expect(result.isError).toBe(true);
		expect(remote.startRecording).not.toHaveBeenCalled();
	});

	it("exports the last recording and streams progress when asked", async () => {
		const { call, remoteExport } = setup();
		const { result, messages } = await call("tools/call", {
			name: "export_video",
			arguments: { outputPath: "/out/demo.mp4" },
			_meta: { progressToken: "p1" },
		});
		expect(JSON.parse(result.content[0].text)).toEqual({
			status: "done",
			path: "/out/demo.mp4",
		});
		expect(remoteExport.exportVideo).toHaveBeenCalledWith(
			{ outputPath: "/out/demo.mp4", videoPath: "/rec/recording-1.mp4" },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(messages).toContainEqual(
			expect.objectContaining({
				method: "notifications/progress",
				params: { progressToken: "p1", progress: 50, total: 100 },
			}),
		);
	});

	it.each([
		"recording",
		"paused",
		"stopping",
	])("refuses to export while the recorder is %s", async (state) => {
		const { call, remoteExport } = setup(state);
		const { result } = await call("tools/call", { name: "export_video", arguments: {} });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("stop_recording");
		expect(remoteExport.exportVideo).not.toHaveBeenCalled();
	});

	it("includes export progress in get_status", async () => {
		const { call } = setup();
		const { result } = await call("tools/call", { name: "get_status", arguments: {} });
		expect(JSON.parse(result.content[0].text)).toMatchObject({
			state: "idle",
			export: { state: "idle" },
		});
	});
});
