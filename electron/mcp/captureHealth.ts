import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MachineReading = {
	loadPerCore: number;
	swapUsedRatio: number | null;
};

export type CaptureHealth = {
	loadPerCore: number;
	swapUsedRatio?: number;
	note: string;
};

const BUSY_LOAD_PER_CORE = 1.5;
const TIGHT_SWAP_RATIO = 0.8;

export function describeMachine(reading: MachineReading): CaptureHealth | null {
	const busy = reading.loadPerCore >= BUSY_LOAD_PER_CORE;
	const swapping = reading.swapUsedRatio !== null && reading.swapUsedRatio >= TIGHT_SWAP_RATIO;
	if (!busy && !swapping) {
		return null;
	}

	const reasons: string[] = [];
	if (busy) {
		reasons.push(
			`other work is using about ${reading.loadPerCore.toFixed(1)}x this machine's cores`,
		);
	}
	if (swapping && reading.swapUsedRatio !== null) {
		reasons.push(
			`swap is ${Math.round(reading.swapUsedRatio * 100)}% full, so memory is exhausted`,
		);
	}

	return {
		loadPerCore: Math.round(reading.loadPerCore * 10) / 10,
		...(reading.swapUsedRatio === null
			? {}
			: { swapUsedRatio: Math.round(reading.swapUsedRatio * 100) / 100 }),
		note:
			`This machine is under pressure: ${reasons.join(", and ")}. Capture takes a core of ` +
			"its own on top, so the app being recorded can load several times slower than it did " +
			"unrecorded. Raise every timeoutMs well above the rehearsal's timings, or ask the user " +
			"to close what they are not using before the take.",
	};
}

export function parseSwapUsedRatio(swapusage: string): number | null {
	const total = swapusage.match(/total\s*=\s*([\d.]+)M/);
	const used = swapusage.match(/used\s*=\s*([\d.]+)M/);
	if (!total || !used) {
		return null;
	}

	const totalMb = Number(total[1]);
	const usedMb = Number(used[1]);
	if (!Number.isFinite(totalMb) || !Number.isFinite(usedMb) || totalMb <= 0) {
		return null;
	}
	return Math.min(1, usedMb / totalMb);
}

async function readSwapUsedRatio(): Promise<number | null> {
	if (process.platform !== "darwin") {
		return null;
	}

	try {
		const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], {
			timeout: 1000,
		});
		return parseSwapUsedRatio(stdout);
	} catch {
		return null;
	}
}

export async function readCaptureHealth(): Promise<CaptureHealth | null> {
	try {
		const cores = Math.max(1, os.cpus().length);
		return describeMachine({
			loadPerCore: os.loadavg()[0] / cores,
			swapUsedRatio: await readSwapUsedRatio(),
		});
	} catch {
		return null;
	}
}
