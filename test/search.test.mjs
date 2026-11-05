import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPrompts } from "../mods/prompt-jump/search.js";

const prompts = [
  { index: 0, text: "Explain binary search" },
  { index: 1, text: "Rewrite it in TypeScript" },
  { index: 2, text: "dev 마이그레이션 실행하고 테스트 데이터도 넣어줘" },
  { index: 3, text: "push하고 배포 돌렸어" },
];
const indices = (list) => list.map((p) => p.index);

test("an empty or blank query keeps every prompt", () => {
  assert.deepEqual(indices(searchPrompts(prompts, "")), [0, 1, 2, 3]);
  assert.deepEqual(indices(searchPrompts(prompts, "   ")), [0, 1, 2, 3]);
});

test("a word matches anywhere in a prompt, ignoring case", () => {
  assert.deepEqual(indices(searchPrompts(prompts, "typescript")), [1]);
  assert.deepEqual(indices(searchPrompts(prompts, "SEARCH")), [0]);
});

test("several words must all appear, in any order", () => {
  assert.deepEqual(indices(searchPrompts(prompts, "데이터 dev")), [2]);
  assert.deepEqual(indices(searchPrompts(prompts, "데이터 배포")), []);
});

test("words match across line breaks and runs of spaces in the prompt", () => {
  const multi = [{ index: 0, text: "first line\n\nsecond   line" }];
  assert.deepEqual(indices(searchPrompts(multi, "line second")), [0]);
  assert.deepEqual(indices(searchPrompts(multi, "line\nsecond")), [0]);
});
