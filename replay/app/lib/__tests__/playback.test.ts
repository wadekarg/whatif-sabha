import { describe, it, expect } from "vitest";
import { turnDurationMs, indexAtTime, totalDurationMs } from "../playback";
import type { ReplayTurn } from "../types";

const turn = (message: string): ReplayTurn => ({
  character: "x", message, round: 0, phase: "opening",
});

describe("turnDurationMs", () => {
  it("returns a minimum floor for tiny messages", () => {
    expect(turnDurationMs(turn("hi"), 1)).toBeGreaterThanOrEqual(1200);
  });

  it("scales with message length", () => {
    const short = turnDurationMs(turn("a".repeat(20)), 1);
    const long = turnDurationMs(turn("a".repeat(400)), 1);
    expect(long).toBeGreaterThan(short);
  });

  it("divides by speed", () => {
    const t = turn("a".repeat(180));
    expect(turnDurationMs(t, 1)).toBeCloseTo(turnDurationMs(t, 2) * 2, -1);
  });
});

describe("indexAtTime", () => {
  const turns = [turn("a".repeat(180)), turn("a".repeat(180)), turn("a".repeat(180))];

  it("returns 0 at t=0", () => {
    expect(indexAtTime(turns, 0, 1)).toBe(0);
  });

  it("advances after each turn's duration elapses", () => {
    const d1 = turnDurationMs(turns[0], 1);
    expect(indexAtTime(turns, d1 - 1, 1)).toBe(0);
    expect(indexAtTime(turns, d1 + 1, 1)).toBe(1);
  });

  it("clamps to last index past the end", () => {
    expect(indexAtTime(turns, 10_000_000, 1)).toBe(turns.length - 1);
  });

  it("returns -1 for empty input", () => {
    expect(indexAtTime([], 0, 1)).toBe(-1);
  });
});

describe("totalDurationMs", () => {
  it("sums all turn durations", () => {
    const turns = [turn("a".repeat(180)), turn("a".repeat(180))];
    const total = totalDurationMs(turns, 1);
    expect(total).toBeCloseTo(
      turnDurationMs(turns[0], 1) + turnDurationMs(turns[1], 1),
      -1,
    );
  });
});
