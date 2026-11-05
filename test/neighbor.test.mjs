import { test } from "node:test";
import assert from "node:assert/strict";
import { neighbor } from "../mods/prompt-jump/jump.js";

const list = (n, compacted = []) =>
  Array.from({ length: n }, (_, index) => ({ index, key: `p${index}`, ...(compacted.includes(index) ? { compacted: true } : {}) }));

test("previous with no jump yet goes to the latest prompt", () => {
  assert.equal(neighbor(list(5), null, -1, "omp"), 4);
});

test("previous from a jumped prompt goes to the one before it", () => {
  assert.equal(neighbor(list(5), 3, -1, "omp"), 2);
});

test("previous stops at the first prompt", () => {
  assert.equal(neighbor(list(5), 1, -1, "omp"), 0);
  assert.equal(neighbor(list(5), 0, -1, "omp"), null);
});

test("next goes to the one after and stops at the latest prompt", () => {
  assert.equal(neighbor(list(5), 3, 1, "omp"), 4);
  assert.equal(neighbor(list(5), 4, 1, "omp"), null);
});

test("next with no jump yet does nothing: the view is already past the latest prompt", () => {
  assert.equal(neighbor(list(5), null, 1, "omp"), null);
});

test("an empty list has nowhere to go", () => {
  assert.equal(neighbor([], null, -1, "omp"), null);
});

test("Claude skips prompts from before a compaction: they are not on screen", () => {
  const prompts = list(5, [0, 1]);
  assert.equal(neighbor(prompts, 3, -1, "claude"), 2);
  assert.equal(neighbor(prompts, 2, -1, "claude"), null);
});

test("only Claude hides compacted prompts; omp draws every prompt it kept", () => {
  assert.equal(neighbor(list(5, [0, 1]), 2, -1, "omp"), 1);
});

test("steps follow the list it is given: a filtered list with gaps steps to the next shown prompt", () => {
  const shown = [0, 3, 7].map((index) => ({ index, key: `p${index}` }));
  assert.equal(neighbor(shown, 3, -1, "omp"), 0);
  assert.equal(neighbor(shown, 3, 1, "omp"), 7);
  assert.equal(neighbor(shown, null, -1, "omp"), 7);
});
