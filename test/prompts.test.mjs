import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { promptsOf } from "../mods/prompt-jump/prompts.mjs";

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("Codex: the person's messages, without injected instructions or the duplicate user_message event", async () => {
  const prompts = await promptsOf("codex", fixture("codex-rollout.jsonl"));
  assert.deepEqual(prompts.map((p) => p.text), ["What is a hash map?", "And a linked list?"]);
});

test("each prompt carries the start of the reply that followed it; one not answered yet has none", async () => {
  const prompts = await promptsOf("codex", fixture("codex-rollout.jsonl"));
  assert.equal(prompts[0].reply, "A key-value store.");
  assert.equal(prompts[1].reply, undefined);
});

test("Claude: only the branch on screen, with the first answer after each prompt", async () => {
  const prompts = await promptsOf("claude", fixture("claude-session.jsonl"));
  assert.deepEqual(prompts.map((p) => p.text), ["first question", "second, sent again"]);
  assert.deepEqual(prompts.map((p) => p.reply), ["answer one", "answer two"]);
});

test("omp: synthetic continues are not prompts, and replies skip tool calls", async () => {
  const prompts = await promptsOf("omp", fixture("omp-session.jsonl"));
  assert.deepEqual(prompts.map((p) => p.text), ["omp first", "omp second"]);
  assert.deepEqual(prompts.map((p) => p.reply), ["omp answer", undefined]);
});
