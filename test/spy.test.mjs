import { test } from "node:test";
import assert from "node:assert/strict";
import { spyActive, viewAtBottom } from "../mods/prompt-jump/jump.js";

const prompts = Array.from({ length: 8 }, (_, index) => ({ index, key: `prompt ${index}` }));
/** A 10-row transcript with request lines at the given rows */
function screen(rows) {
  const lines = Array.from({ length: 10 }, (_, i) => `  answer text ${i}`);
  for (const [row, index] of Object.entries(rows)) lines[row] = `❯ prompt ${index}`;
  return lines;
}

test("the last request in the top half is the one being read", () => {
  assert.equal(spyActive(screen({ 1: 3, 4: 4, 8: 5 }), "❯", prompts), 4);
});

test("with requests only in the bottom half, the answer above belongs to the request before the first one", () => {
  assert.equal(spyActive(screen({ 6: 5, 9: 6 }), "❯", prompts), 4);
});

test("the very first prompt in the bottom half is still the first: there is none before it", () => {
  assert.equal(spyActive(screen({ 7: 0 }), "❯", prompts), 0);
});

test("nothing on screen but an answer says nothing", () => {
  assert.equal(spyActive(screen({}), "❯", prompts), null);
});

test("the latest prompt on screen, even low down, means the latest answer is being read", () => {
  assert.equal(spyActive(screen({ 2: 6, 8: 7 }), "❯", prompts), 7);
});

test("identical prompts are told apart by their unique neighbours on screen", () => {
  const dup = [
    { index: 0, key: "start" },
    { index: 1, key: "ok" },
    { index: 2, key: "middle" },
    { index: 3, key: "ok" },
    { index: 4, key: "end" },
  ];
  const lines = Array.from({ length: 10 }, (_, i) => `  answer ${i}`);
  lines[1] = "❯ middle";
  lines[3] = "❯ ok";
  lines[8] = "❯ end";
  assert.equal(spyActive(lines, "❯", dup), 4);
  lines[8] = "  answer";
  assert.equal(spyActive(lines, "❯", dup), 3);
});

test("at the bottom the latest answer is being read, even with its prompt scrolled off the top", () => {
  assert.equal(spyActive(screen({}), "❯", prompts, { atBottom: true }), 7);
  assert.equal(spyActive(screen({ 1: 5 }), "❯", prompts, { atBottom: true }), 7);
});

test("scrolled up, a screen of answer only still says nothing", () => {
  assert.equal(spyActive(screen({}), "❯", prompts, { atBottom: false }), null);
});

test("Claude is scrolled up only when its Jump to bottom hint sits just above the input box", () => {
  const box = ["─".repeat(40), "❯ ", "─".repeat(40), "  Opus | ~/repo", "  auto mode on"];
  const body = ["  answer", "  answer"];
  assert.equal(viewAtBottom("claude", [...body, "  more answer", "", ...box]), true);
  assert.equal(viewAtBottom("claude", [...body, "  more answer  Jump to bottom: fn+↓", "", ...box]), false);
  assert.equal(viewAtBottom("claude", [...body, "  … Jump to bottom (click) ↓", "", ...box]), false);
});

test("the same words written in the transcript, away from the input box, are not the hint", () => {
  const box = ["─".repeat(40), "❯ ", "─".repeat(40), "  Opus | ~/repo", "  auto mode on"];
  const lines = ["  Claude shows a Jump to bottom hint when scrolled up", "  a", "  b", "  c", "  d", "", ...box];
  assert.equal(viewAtBottom("claude", lines), true);
});

test("without an input box to place the hint, or for another program, the bottom is unknown", () => {
  assert.equal(viewAtBottom("claude", ["  just text"]), null);
  assert.equal(viewAtBottom("codex", ["  some answer"]), null);
});
