import type { ReplayTurn } from "./types";

// ~18 chars/sec is a calm reading pace.
const CHARS_PER_SEC = 18;
const MIN_MS = 1200;
const POST_TURN_BEAT_MS = 400;

export function turnDurationMs(turn: ReplayTurn, speed: number): number {
  const chars = turn.message?.length ?? 0;
  const readMs = (chars / CHARS_PER_SEC) * 1000 + POST_TURN_BEAT_MS;
  const floored = Math.max(MIN_MS, readMs);
  return floored / Math.max(speed, 0.01);
}

export function totalDurationMs(turns: ReplayTurn[], speed: number): number {
  let total = 0;
  for (const t of turns) total += turnDurationMs(t, speed);
  return total;
}

export function indexAtTime(
  turns: ReplayTurn[],
  elapsedMs: number,
  speed: number,
): number {
  if (turns.length === 0) return -1;
  let cursor = 0;
  for (let i = 0; i < turns.length; i++) {
    cursor += turnDurationMs(turns[i], speed);
    if (elapsedMs < cursor) return i;
  }
  return turns.length - 1;
}

export function timeAtIndex(
  turns: ReplayTurn[],
  index: number,
  speed: number,
): number {
  let cursor = 0;
  for (let i = 0; i < index && i < turns.length; i++) {
    cursor += turnDurationMs(turns[i], speed);
  }
  return cursor;
}
