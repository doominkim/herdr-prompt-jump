import { test } from "node:test";
import assert from "node:assert/strict";
import { jumpTo } from "../mods/prompt-jump/jump.js";

/** A terminal that shows `screen` and records what was asked of it */
function fakeTerminal(screen) {
  const calls = [];
  const io = {
    hc: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "read") return { code: 0, stdout: JSON.stringify({ how: "screen", text: screen.join("\n") }), stderr: "" };
      return { code: 0, stdout: "{}", stderr: "" };
    },
    sleep: async () => {},
    scroll: async () => {},
  };
  return { io, calls };
}

const prompts = [
  { index: 0, key: "What is a hash map?" },
  { index: 1, key: "And a linked list?" },
];
// Six rows of input box and status sit under the transcript
const footer = ["", "› Ask Codex to do anything", "", "  gpt-5", "", ""];

test("Codex: a prompt on screen after its › marker is found without asking for history", async () => {
  const { io, calls } = fakeTerminal(["› What is a hash map?", "• A key-value store.", "› And a linked list?", ...footer]);
  const out = await jumpTo(io, "t1", "codex", prompts, 0);
  assert.equal(out.found, true);
  assert.equal(calls.some((c) => c.includes("--lines")), false);
});
