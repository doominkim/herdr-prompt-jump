import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { alive, waking, forwardOpenRequest, initialOpenNonce } from "../mods/prompt-jump/relay.js";
import { searchPrompts } from "../mods/prompt-jump/search.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a cold-open target loads after the previous terminal's pending load finishes", async () => {
  // Only native host imports are replaced; select, poll, takeOpen, load and visible run unchanged.
  const source = (await readFile(new URL("../mods/prompt-jump/main.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "")
    .replace("export default class PromptJump", "globalThis.PromptJump = class PromptJump");
  const request = { terminal: "B", n: "cold-open-B" };
  const state = new Map([
    ["prompt-jump.open", forwardOpenRequest(request, null, null, 10_000, Date.now())],
  ]);
  const terminals = [
    { address: "A", title: "Previous session", report: { app: "omp" } },
    { address: "B", title: "Requested session", report: { app: "omp" } },
  ];
  const pendingA = deferred();
  const pendingB = deferred();
  const loads = [];
  const tasks = [];
  const published = [];
  const host = {
    View: class {},
    alive, waking, initialOpenNonce, searchPrompts,
    shared: (key) => state.get(key),
    setShared: (key, value) => state.set(key, value),
    focused: () => ({ terminal: "A" }),
    terminals: () => terminals,
    agents: () => terminals.map(({ address }) => ({ address, status: "idle" })),
    appHome: () => "/test/herdr",
    run() {},
    InputState: {
      new: () => ({ on() {}, set_value() {}, release() {} }),
    },
    VirtualListScrollHandle: {
      new: () => ({ scroll_to_bottom() {}, release() {} }),
    },
    exec: async (_command, args) => {
      const address = args[2];
      loads.push(address);
      assert.ok(address === "A" || address === "B");
      const out = await (address === "A" ? pendingA.promise : pendingB.promise);
      return { code: 0, stdout: JSON.stringify(out), stderr: "" };
    },
  };
  runInNewContext(source, host, { filename: "mods/prompt-jump/main.js" });
  const panel = new host.PromptJump();
  const cx = {
    timer: { every() {} },
    spawn(work) {
      const task = work(cx);
      tasks.push(task);
      return task;
    },
    notify: () => published.push(Array.from(panel.visible(), (prompt) => prompt.text)),
  };

  panel.searchBox = host.InputState.new();
  panel.scroll = host.VirtualListScrollHandle.new();
  panel.lastFocused = "A";
  panel.lastOpen = initialOpenNonce(state.get("prompt-jump.open"), Date.now());
  panel.select("A", "omp", terminals[0], cx);
  const firstLoad = tasks[0];
  assert.deepEqual(loads, ["A"]);
  panel.takeOpen(cx);
  await tasks.at(-1);
  assert.equal(panel.target, "B");
  panel.poll(cx); // B is idle and its status has not changed; polling cannot rescue a skipped initial load.
  assert.deepEqual(loads, ["A"]);

  pendingA.resolve({ file: "/sessions/A.jsonl", prompts: [{ index: 0, text: "Stale A prompt" }] });
  await firstLoad;
  assert.deepEqual(Array.from(panel.visible()), [], "the obsolete terminal must never replace the requested list");
  assert.deepEqual(loads, ["A", "B"], "the idle requested terminal must load after the obsolete request completes");

  pendingB.resolve({ file: "/sessions/B.jsonl", prompts: [{ index: 0, text: "Requested B prompt" }] });
  await tasks.at(-1);
  assert.deepEqual(Array.from(panel.visible(), (prompt) => prompt.text), ["Requested B prompt"]);
  assert.equal(panel.file, "/sessions/B.jsonl");
  assert.equal(panel.error, null);
  assert.equal(published.some((prompts) => prompts.includes("Stale A prompt")), false);
  panel.poll(cx);
  assert.deepEqual(loads, ["A", "B"], "an idle target does not need retries or another status transition");
});
