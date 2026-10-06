import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./remoteControl", () => ({ MAX_COUNTDOWN_SECONDS: 10 }));

import type { AgentControl } from "./agentControl";
import type { RemoteControl } from "./remoteControl";
import type { RemoteExport } from "./remoteExport";
import { buildRecordlyMcpServer } from "./tools";

function setup(
	state = "idle",
	{
		controlEnabled = true,
		platform = "darwin",
	}: { controlEnabled?: boolean; platform?: NodeJS.Platform } = {},
) {
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
	const agent = {
		perform: vi.fn(async (steps: unknown[]) => ({ performed: steps.length })),
		openUrl: vi.fn(async (url: string) => ({ url, source: { id: "window:9:0" } })),
		screenshot: vi.fn(async () => ({
			data: "aGk=",
			mimeType: "image/jpeg",
			width: 1568,
			height: 980,
			scale: 0.5,
			originX: 0,
			originY: 0,
		})),
		findElements: vi.fn(async () => ({ elements: [], truncated: false })),
	} as unknown as AgentControl & Record<string, ReturnType<typeof vi.fn>>;
	const handler = createMcpHandler(() =>
		buildRecordlyMcpServer(remote, remoteExport, "1.0.0", {
			agent,
			isControlEnabled: () => controlEnabled,
			platform,
		}),
	);

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

	return { remote, remoteExport, agent, call };
}

describe("buildRecordlyMcpServer", () => {
	it("exposes the full recording and export tool set", async () => {
		const { call } = setup();
		const { result } = await call("tools/list");
		expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
			"cancel_recording",
			"click",
			"drag",
			"export_video",
			"find_elements",
			"get_status",
			"list_sources",
			"move_pointer",
			"open_url",
			"pause_recording",
			"perform",
			"press_key",
			"resume_recording",
			"screenshot",
			"scroll",
			"select_source",
			"start_recording",
			"stop_recording",
			"type_text",
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

	it.each([
		["open_url", { url: "https://example.com" }],
		["click", { x: 1, y: 2 }],
		["drag", { fromX: 1, fromY: 2, toX: 3, toY: 4 }],
		["move_pointer", { x: 1, y: 2 }],
		["scroll", { x: 1, y: 2, deltaY: 100 }],
		["type_text", { text: "hi" }],
		["press_key", { key: "enter" }],
		["perform", { steps: [{ action: "wait", ms: 10 }] }],
	])("refuses %s while the mouse and keyboard switch is off", async (name, args) => {
		const { call, agent } = setup("idle", { controlEnabled: false });
		const { result } = await call("tools/call", { name, arguments: args });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Let agents use the mouse and keyboard");
		expect(agent.perform).not.toHaveBeenCalled();
		expect(agent.openUrl).not.toHaveBeenCalled();
	});

	it("serves screenshot and find_elements with only the main switch", async () => {
		const { call, agent } = setup("idle", { controlEnabled: false });
		const { result } = await call("tools/call", { name: "screenshot", arguments: {} });
		expect(result.content[0]).toEqual({ type: "image", data: "aGk=", mimeType: "image/jpeg" });
		expect(JSON.parse(result.content[1].text)).toMatchObject({
			width: 1568,
			height: 980,
			scale: 0.5,
			hint: expect.stringContaining("scale"),
		});
		const found = await call("tools/call", {
			name: "find_elements",
			arguments: { text: "Save" },
		});
		expect(found.result.isError).toBeFalsy();
		expect(agent.findElements).toHaveBeenCalledWith({ text: "Save" });
	});

	it("keeps the whole-window screenshot output unchanged", async () => {
		const { call, agent } = setup();
		const { result } = await call("tools/call", { name: "screenshot", arguments: {} });
		expect(agent.screenshot).toHaveBeenCalledWith(undefined);
		expect(JSON.parse(result.content[1].text)).toEqual({
			width: 1568,
			height: 980,
			scale: 0.5,
			hint: "Window point = image pixel × scale. Pass window points to click, drag, move_pointer, scroll and perform.",
		});
	});

	it("zooms into a region and returns its origin", async () => {
		const { call, agent } = setup();
		agent.screenshot.mockResolvedValueOnce({
			data: "aGk=",
			mimeType: "image/jpeg",
			width: 600,
			height: 400,
			scale: 0.5,
			originX: 200,
			originY: 100,
		});
		const region = { x: 200, y: 100, width: 300, height: 200 };
		const { result } = await call("tools/call", { name: "screenshot", arguments: { region } });
		expect(agent.screenshot).toHaveBeenCalledWith(region);
		expect(JSON.parse(result.content[1].text)).toEqual({
			width: 600,
			height: 400,
			scale: 0.5,
			originX: 200,
			originY: 100,
			hint: "Only the region is shown. Window point = (originX + pixel x × scale, originY + pixel y × scale).",
		});
		const { description } = (await call("tools/list")).result.tools.find(
			(tool: { name: string }) => tool.name === "screenshot",
		);
		expect(description).toContain("point = origin + pixel × scale");
	});

	it.each([
		{ x: 0, y: 0, width: 0, height: 10 },
		{ x: 0, y: 0, width: 10 },
	])("refuses a bad screenshot region %o before reaching the agent", async (region) => {
		const { call, agent } = setup();
		const { result } = await call("tools/call", { name: "screenshot", arguments: { region } });
		expect(result.isError).toBe(true);
		expect(agent.screenshot).not.toHaveBeenCalled();
	});

	it("turns single-action tools into one-step perform calls", async () => {
		const { call, agent } = setup();
		const calls: [string, Record<string, unknown>][] = [
			["click", { x: 5, y: 6, count: 3, button: "right", modifiers: ["command", "shift"] }],
			[
				"drag",
				{ fromX: 1, fromY: 2, toX: 30, toY: 40, modifiers: ["option"], durationMs: 900 },
			],
			["scroll", { x: 5, y: 6, deltaY: -200, deltaX: 10, modifiers: ["shift"] }],
			["press_key", { key: "a", modifiers: ["cmd"] }],
			["press_key", { key: "right", repeat: 5 }],
			["press_key", { key: "?" }],
			["type_text", { text: "héllo 👋\n\t" }],
		];
		for (const [name, args] of calls) {
			const { result } = await call("tools/call", { name, arguments: args });
			expect(result.isError).toBeFalsy();
		}
		const actions: Record<string, string> = {
			click: "click",
			drag: "drag",
			scroll: "scroll",
			press_key: "key",
			type_text: "type",
		};
		calls.forEach(([name, args], index) => {
			expect(agent.perform).toHaveBeenNthCalledWith(index + 1, [
				{ action: actions[name], ...args },
			]);
		});
	});

	it("accepts every step shape in perform", async () => {
		const { call, agent } = setup();
		const steps = [
			{ action: "move", x: 1, y: 1, durationMs: 500 },
			{ action: "click", x: 2, y: 2, count: 2, modifiers: ["cmd"] },
			{ action: "drag", fromX: 0, fromY: 0, toX: 9, toY: 9, button: "left" },
			{ action: "scroll", x: 3, y: 3, deltaY: 400, modifiers: ["ctrl"] },
			{ action: "type", text: "Hello" },
			{ action: "key", key: "z", modifiers: ["cmd", "shift"], repeat: 2 },
			{ action: "wait", ms: 30_000 },
		];
		const { result } = await call("tools/call", { name: "perform", arguments: { steps } });
		expect(result.isError).toBeFalsy();
		expect(agent.perform).toHaveBeenCalledWith(steps);
	});

	it("validates perform steps before reaching the controller", async () => {
		const { call, agent } = setup();
		for (const steps of [
			[{ action: "wait", ms: 30_001 }],
			[{ action: "click", x: 0, y: 0, count: 4 }],
			[{ action: "key", key: "a", repeat: 101 }],
			[{ action: "key", key: "a", repeat: 0 }],
			[{ action: "key", key: "" }],
			[{ action: "key", key: "x".repeat(33) }],
			[{ action: "key", key: "a", modifiers: ["cmd", "shift", "alt", "ctrl", "fn", "cmd"] }],
			[{ action: "click", x: 0, y: 0, modifiers: [""] }],
			[{ action: "click", x: -1, y: 0 }],
			[{ action: "drag", fromX: 0, fromY: 0, toX: -5, toY: 0 }],
			[{ action: "drag", fromX: 0, fromY: 0 }],
			[{ action: "scroll", x: 0, y: 0, deltaY: 1_000_000 }],
			[{ action: "type", text: "" }],
			[{ action: "hover", x: 0, y: 0 }],
			[],
			Array.from({ length: 201 }, () => ({ action: "wait", ms: 0 })),
		]) {
			const { result } = await call("tools/call", { name: "perform", arguments: { steps } });
			expect(result.isError).toBe(true);
		}
		expect(agent.perform).not.toHaveBeenCalled();
	});

	it("teaches a generic workflow, key reference and recovery on macOS", async () => {
		const { call } = setup();
		const init = await call("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		const instructions: string = init.result.instructions;
		for (const needle of [
			"open_url",
			"list_sources → select_source",
			"screenshot",
			"find_elements",
			"start_recording",
			"perform",
			"stop_recording",
			"export_video",
			"pixel × scale",
			"landscape",
			"the user took over",
			"Let agents use the mouse and keyboard",
		]) {
			expect(instructions).toContain(needle);
		}
		const { result } = await call("tools/list");
		const pressKey = result.tools.find((tool: { name: string }) => tool.name === "press_key");
		for (const needle of [
			"enter (return)",
			"cmd (command/meta/super/win/windows)",
			"alt (option/opt)",
			"fn",
			"repeat",
			"forward delete",
		]) {
			expect(pressKey.description).toContain(needle);
		}
		expect(JSON.stringify(result.tools) + instructions).not.toMatch(
			/Auditor|Configuration|Onboarding|stanch|Chrome/,
		);
		const tooLong = [
			["instructions", instructions],
			...result.tools.map((tool: { name: string; description: string }) => [
				tool.name,
				tool.description,
			]),
		].filter(([, text]) => text.length > 2048);
		expect(tooLong.map(([name, text]) => `${name}: ${text.length}`)).toEqual([]);
	});

	it.each([
		["darwin", "open_url with https://example.com", "perform"],
		["linux", "share dialog", "user performs the demo"],
		["win32", "select_source", "user performs the demo"],
	] as const)("serves the record_demo prompt on %s", async (platform, expected, flow) => {
		const { call } = setup("idle", { platform });
		const listed = await call("prompts/list");
		expect(listed.result.prompts).toEqual([
			expect.objectContaining({
				name: "record_demo",
				arguments: expect.arrayContaining([
					expect.objectContaining({ name: "goal", required: true }),
					expect.objectContaining({ name: "url" }),
					expect.objectContaining({ name: "app" }),
					expect.objectContaining({ name: "output_path" }),
				]),
			}),
		]);
		const { result } = await call("prompts/get", {
			name: "record_demo",
			arguments: {
				goal: "creating a project",
				url: "https://example.com",
				output_path: "/out/demo.mp4",
			},
		});
		const text: string = result.messages[0].content.text;
		expect(text).toContain("creating a project");
		expect(text).toContain(expected);
		expect(text).toContain(flow);
		expect(text).toContain('outputPath "/out/demo.mp4"');
		if (platform !== "darwin") expect(text).not.toContain("open_url");
	});

	it("requires a goal for record_demo", async () => {
		const { call } = setup();
		const { result, messages } = await call("prompts/get", {
			name: "record_demo",
			arguments: {},
		});
		expect(result).toBeUndefined();
		expect(messages.at(-1).error).toBeDefined();
	});

	it.each([
		"win32",
		"linux",
	] as const)("offers only the recording tools and their flow on %s", async (platform) => {
		const { call } = setup("idle", { platform });
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
		const descriptions = JSON.stringify(result.tools);
		expect(descriptions).not.toContain("Raises the window");
		expect(descriptions).not.toContain("pid");
		const init = await call("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		expect(init.result.instructions).not.toContain("open_url");
		expect(init.result.instructions).toContain("list_sources → select_source");
	});
});
