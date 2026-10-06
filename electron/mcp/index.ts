import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, clipboard, ipcMain } from "electron";
import { USER_DATA_PATH } from "../appPaths";
import type { RemoteControl } from "./remoteControl";
import { createRemoteExport } from "./remoteExport";
import { createMcpHttpServer, MCP_PATH } from "./server";
import { buildRecordlyMcpServer } from "./tools";

const SETTINGS_FILE = path.join(USER_DATA_PATH, "mcp-server.json");
const PORT = 43831;

type StoredSettings = { enabled: boolean; token: string };

function readSettings(): StoredSettings {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Partial<StoredSettings>;
		return {
			enabled: parsed.enabled === true,
			token: typeof parsed.token === "string" ? parsed.token : "",
		};
	} catch {
		return { enabled: false, token: "" };
	}
}

function writeSettings(settings: StoredSettings) {
	const tempFile = `${SETTINGS_FILE}.${process.pid}.tmp`;
	writeFileSync(tempFile, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
	renameSync(tempFile, SETTINGS_FILE);
}

const createToken = () => randomBytes(32).toString("base64url");

export function setupMcpServer({ isDev, remote }: { isDev: boolean; remote: RemoteControl }) {
	const port = isDev ? PORT + 1 : PORT;
	const url = `http://127.0.0.1:${port}${MCP_PATH}`;
	let settings = readSettings();
	let error: McpServerState["error"] = null;
	let applying = Promise.resolve();
	const remoteExport = createRemoteExport();
	const server = createMcpHttpServer({
		port,
		getToken: () => settings.token,
		buildServer: () => buildRecordlyMcpServer(remote, remoteExport, app.getVersion()),
	});

	function save(next: StoredSettings) {
		writeSettings(next);
		settings = next;
	}

	async function applyNow() {
		error = null;
		if (!settings.enabled) {
			await server.close();
			return;
		}
		try {
			await server.start();
		} catch (startError) {
			const code = (startError as NodeJS.ErrnoException).code;
			error = code === "EADDRINUSE" ? "port-in-use" : "start-failed";
			console.warn("[mcp-server] Could not start:", startError);
		}
	}

	function apply() {
		applying = applying.then(applyNow, applyNow);
		return applying;
	}

	function getState(): McpServerState {
		return {
			enabled: settings.enabled,
			running: server.isRunning(),
			url,
			error,
		};
	}

	if (settings.enabled && !settings.token) {
		try {
			save({ ...settings, token: createToken() });
		} catch (saveError) {
			console.warn("[mcp-server] Could not save a new token:", saveError);
			settings = { ...settings, enabled: false };
		}
	}

	ipcMain.handle("mcp-server:get-state", () => getState());
	ipcMain.handle("mcp-server:set-enabled", async (_, enabled: unknown) => {
		save({ enabled: enabled === true, token: settings.token || createToken() });
		await apply();
		return getState();
	});
	ipcMain.handle("mcp-server:regenerate-token", () => {
		save({ ...settings, token: createToken() });
		return getState();
	});
	ipcMain.handle("mcp-server:copy-setup-command", () => {
		if (!settings.enabled || !settings.token) {
			throw new Error("Turn on AI agent control first.");
		}
		clipboard.writeText(
			`claude mcp add --scope user --transport http recordly ${url} --header "Authorization: Bearer ${settings.token}"`,
		);
	});

	void apply();
	return {
		close: () => {
			applying = applying.then(() => server.close());
			return applying;
		},
	};
}
