import { test } from "node:test";
import assert from "node:assert/strict";
import { alive, waking, WAKE_MS } from "../mods/prompt-jump/relay.js";

const now = 1_000_000;

test("a copy is running while its last beat is younger than two and a half periods", () => {
  assert.equal(alive({ at: now - 24_999 }, 10_000, now), true);
  assert.equal(alive({ at: now - 25_000 }, 10_000, now), false);
});

test("a copy that never beat, or cleared its beat on close, is not running", () => {
  assert.equal(alive(null, 10_000, now), false);
  assert.equal(alive(undefined, 10_000, now), false);
});

test("a step that woke the panel is still for it while younger than the wake window", () => {
  assert.equal(waking({ dir: -1, n: "a", at: now - (WAKE_MS - 1), wake: true }, now), true);
  assert.equal(waking({ dir: -1, n: "a", at: now - WAKE_MS, wake: true }, now), false);
});

test("an ordinary step, forwarded to a running panel, never wakes one started later", () => {
  assert.equal(waking({ dir: -1, n: "a", at: now }, now), false);
  assert.equal(waking(null, now), false);
});
