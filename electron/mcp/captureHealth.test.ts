import { expect, it } from "vitest";
import { describeMachine, parseSwapUsedRatio } from "./captureHealth";

it("says nothing when the machine can keep up", () => {
	expect(describeMachine({ loadPerCore: 0.4, swapUsedRatio: 0.1 })).toBeNull();
	expect(describeMachine({ loadPerCore: 1.49, swapUsedRatio: 0.79 })).toBeNull();
	expect(describeMachine({ loadPerCore: 0, swapUsedRatio: null })).toBeNull();
});

it("warns about a busy machine without claiming to know about memory", () => {
	const health = describeMachine({ loadPerCore: 2.6, swapUsedRatio: null });
	expect(health?.loadPerCore).toBe(2.6);
	expect(health).not.toHaveProperty("swapUsedRatio");
	expect(health?.note).toContain("2.6x this machine's cores");
	expect(health?.note).not.toContain("swap");
	expect(health?.note).toContain("Raise every timeoutMs");
});

it("warns about exhausted memory even when the load looks fine", () => {
	const health = describeMachine({ loadPerCore: 0.2, swapUsedRatio: 0.96 });
	expect(health?.swapUsedRatio).toBe(0.96);
	expect(health?.note).toContain("swap is 96% full");
	expect(health?.note).not.toContain("this machine's cores");
});

it("reports both reasons when both are true", () => {
	const health = describeMachine({ loadPerCore: 2.55, swapUsedRatio: 0.96 });
	expect(health?.note).toContain("cores");
	expect(health?.note).toContain("and swap is 96% full");
	expect(health?.loadPerCore).toBe(2.6);
});

it("reads the swap figures macOS prints, and refuses to guess otherwise", () => {
	expect(
		parseSwapUsedRatio("total = 23552.00M  used = 22592.31M  free = 959.69M  (encrypted)"),
	).toBeCloseTo(0.959, 3);
	expect(parseSwapUsedRatio("total = 0.00M  used = 0.00M  free = 0.00M")).toBeNull();
	expect(parseSwapUsedRatio("")).toBeNull();
	expect(parseSwapUsedRatio("total = 2048.00M")).toBeNull();
	expect(parseSwapUsedRatio("total = abcM  used = 1.00M")).toBeNull();
	expect(parseSwapUsedRatio("total = 100.00M  used = 400.00M  free = 0.00M")).toBe(1);
});
