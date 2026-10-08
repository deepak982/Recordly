import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	BLACK_LUMA_MAX,
	FLAT_LUMA_SPREAD_MAX,
	MAX_VERIFY_SAMPLES,
	verifyExportedFrames,
} from "./exportVerify";
import type { RunFfmpeg } from "./remoteEditor";

let dir: string;
let file: string;
let empty: string;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-verify-"));
	file = path.join(dir, "out.mp4");
	empty = path.join(dir, "empty.mp4");
	fs.writeFileSync(file, "x");
	fs.writeFileSync(empty, "");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const stats = (ylow: number, yhigh: number) =>
	Buffer.from(
		`frame:0 pts:0\nlavfi.signalstats.YLOW=${ylow}\nlavfi.signalstats.YHIGH=${yhigh}\n`,
	);
const REAL = stats(30, 200);

function fake(frameAt: (seconds: number) => Buffer | Error) {
	const calls: string[][] = [];
	const runFfmpeg: RunFfmpeg = vi.fn(async (_binary, args, { timeoutMs }) => {
		calls.push(args);
		expect(timeoutMs).toBeGreaterThan(0);
		const out = frameAt(Number(args[args.indexOf("-ss") + 1]));
		if (out instanceof Error) throw out;
		return out;
	});
	return { runFfmpeg, calls };
}

const run = (runFfmpeg: RunFfmpeg, over = {}) =>
	verifyExportedFrames(file, { binary: "/ffmpeg", runFfmpeg, durationMs: 80_000, ...over });

describe("verifyExportedFrames", () => {
	it("reports nothing for a file whose every sampled frame has content", async () => {
		const { runFfmpeg, calls } = fake(() => REAL);
		const result = await run(runFfmpeg);
		expect(result).toEqual({ checked: 8, emptyAtMs: [], warnings: [] });
		expect(calls).toHaveLength(8);
		expect(Number(calls[0][calls[0].indexOf("-ss") + 1])).toBeGreaterThanOrEqual(0.2);
	});

	it("reports a black frame and a flat frame separately, with timestamps", async () => {
		const { runFfmpeg } = fake((s) =>
			s < 6 ? stats(16, 16) : s > 70 ? stats(100, 100) : REAL,
		);
		const result = await run(runFfmpeg);
		expect(result.emptyAtMs).toHaveLength(2);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toMatch(/completely black/);
		expect(result.warnings[1]).toMatch(/single flat colour/);
		expect(result.warnings[0]).toContain(`${(result.emptyAtMs[0] / 1000).toFixed(1)} s`);
		expect(result.warnings[1]).toContain(`${(result.emptyAtMs[1] / 1000).toFixed(1)} s`);
	});

	it("treats a frame just above the flatness threshold as content, and at it as flat", async () => {
		const above = await run(fake(() => stats(100, 100 + FLAT_LUMA_SPREAD_MAX + 1)).runFfmpeg);
		expect(above.emptyAtMs).toEqual([]);
		const at = await run(fake(() => stats(100, 100 + FLAT_LUMA_SPREAD_MAX)).runFfmpeg);
		expect(at.emptyAtMs).toHaveLength(8);
		const dark = await run(fake(() => stats(0, BLACK_LUMA_MAX + 30)).runFfmpeg);
		expect(dark.emptyAtMs).toEqual([]);
		const black = await run(fake(() => stats(0, BLACK_LUMA_MAX)).runFfmpeg);
		expect(black.warnings[0]).toMatch(/black/);
	});

	it("warns, and does not throw, when ffmpeg cannot decode", async () => {
		const { runFfmpeg } = fake(() =>
			Object.assign(new Error("boom"), { stderr: "Invalid data" }),
		);
		const result = await run(runFfmpeg);
		expect(result.checked).toBe(0);
		expect(result.warnings.join("\n")).toContain("Invalid data");
	});

	it("warns when ffmpeg returns no picture stats", async () => {
		const result = await run(fake(() => Buffer.alloc(0)).runFfmpeg);
		expect(result.checked).toBe(0);
		expect(result.warnings[0]).toMatch(/no picture/);
	});

	it("probes the duration from ffmpeg when none is given", async () => {
		const runFfmpeg: RunFfmpeg = vi.fn(async (_b, args) => {
			if (!args.includes("-ss")) {
				throw Object.assign(new Error("exit 1"), {
					stderr: "Duration: 00:01:20.00, start",
				});
			}
			return REAL;
		});
		const result = await run(runFfmpeg, { durationMs: undefined, samples: 2 });
		expect(result.checked).toBe(2);
	});

	it("says so when the length cannot be read", async () => {
		const runFfmpeg: RunFfmpeg = vi.fn(async () => {
			throw Object.assign(new Error("x"), { code: "ENOENT" });
		});
		const result = await run(runFfmpeg, { durationMs: undefined });
		expect(result.warnings[0]).toMatch(/FFmpeg was not found/);
	});

	it("stops and warns when the signal is already aborted", async () => {
		const { runFfmpeg, calls } = fake(() => REAL);
		const controller = new AbortController();
		controller.abort();
		const result = await run(runFfmpeg, { signal: controller.signal });
		expect(calls).toHaveLength(0);
		expect(result.warnings[0]).toMatch(/canceled/);
	});

	it("refuses a missing, empty, relative or folder path before running ffmpeg", async () => {
		const { runFfmpeg, calls } = fake(() => REAL);
		const opts = { binary: "/ffmpeg", runFfmpeg, durationMs: 1000 };
		await expect(verifyExportedFrames(path.join(dir, "no.mp4"), opts)).rejects.toThrow(
			/no exported file/,
		);
		await expect(verifyExportedFrames(empty, opts)).rejects.toThrow(/empty/);
		await expect(verifyExportedFrames("out.mp4", opts)).rejects.toThrow(/absolute/);
		await expect(verifyExportedFrames(dir, opts)).rejects.toThrow(/folder/);
		expect(calls).toHaveLength(0);
	});

	it("refuses sample counts out of bounds", async () => {
		const { runFfmpeg, calls } = fake(() => REAL);
		for (const samples of [0, -1, 1.5, Number.NaN, MAX_VERIFY_SAMPLES + 1]) {
			await expect(run(runFfmpeg, { samples })).rejects.toThrow(/samples/);
		}
		expect((await run(runFfmpeg, { samples: MAX_VERIFY_SAMPLES })).checked).toBe(
			MAX_VERIFY_SAMPLES,
		);
		expect(calls).toHaveLength(MAX_VERIFY_SAMPLES);
	});

	it("samples the middle of a clip shorter than the edge margins", async () => {
		const { runFfmpeg, calls } = fake(() => REAL);
		const result = await run(runFfmpeg, { durationMs: 300 });
		expect(result.checked).toBe(1);
		expect(calls[0][calls[0].indexOf("-ss") + 1]).toBe("0.150");
	});
});
