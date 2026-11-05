#!/usr/bin/env node
// Helper for the Prompt Jump mod: finds the session file behind a herdr-core terminal and lists the
// requests the person typed, then finds a request on the terminal's screen to jump to it.
//
//   node prompts.mjs prompts <terminal>         -> {agent, file, prompts: [{index, text, key}]}
//   node prompts.mjs locate <terminal> <index>  -> jumps there (jump.js, as the panel does)
//
// Prompt filtering follows Illithid's transcript reader (github.com/doominkim/illithid, src/engine/scan/transcript.ts):
// only human-typed user text, with injections, system reminders and command output removed.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const HOME = homedir();
const HC = process.env.HC_BIN || "hc";

// ------------------------------------------------------------ user text cleanup (Illithid rules)

const INJECTED_PREFIX = [
  "# AGENTS.md", "Caveat:", "<environment_context", "<teammate-message", "<task-notification",
  "<cross-session-message", "<local-command-stdout", "<local-command-caveat", "<bash-stdout",
  "<bash-stderr", "<bash-input", "<user-memory-input", "<INSTRUCTIONS>", "<ide_selection",
  "<ide_opened_file", "<recommended_plugins", "<codex_internal_context", "<turn_aborted",
  "<user_shell_command", "[Request interrupted",
];

const stripTag = (text, tag) => text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "g"), "");

export function cleanUserText(raw) {
  let t = String(raw ?? "").trim();
  if (!t) return undefined;
  t = stripTag(t, "system-reminder").trim();
  if (!t) return undefined;
  if (INJECTED_PREFIX.some((p) => t.startsWith(p))) return undefined;
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t)?.[1]?.trim();
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1]?.trim();
    return args ? `${cmd} ${args}` : cmd;
  }
  if (/^<command-message>/.test(t)) return undefined;
  t = t
    .replace(/<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/g, (_, inner) => `[pasted content] ${inner.trim()}`)
    .replace(/<pasted_content\b[^>]*\/>/g, "[pasted content]")
    .trim();
  return t || undefined;
}

export function userTextOf(content) {
  const texts = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content))
    for (const p of content)
      if (p && (p.type === "text" || p.type === "input_text") && typeof p.text === "string") texts.push(p.text);
  const real = texts.map(cleanUserText).filter(Boolean);
  return real.length ? real.join("\n\n") : undefined;
}

// ------------------------------------------------------------ terminal -> session file

function hcJson(args) {
  return JSON.parse(execFileSync(HC, [...args, "--json"], { encoding: "utf8", maxBuffer: 64 << 20 }));
}

/** Seconds the process has been running (ps etime: [[dd-]hh:]mm:ss) */
function elapsedSeconds(pid) {
  try {
    const s = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
    const parts = rest.split(":").map(Number);
    while (parts.length < 3) parts.unshift(0);
    return Number(d) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  } catch {
    return null;
  }
}

function agentOf(term) {
  const app = term.status?.app ?? "";
  const argv = (term.foreground?.argv ?? []).join(" ");
  if (app === "claude-code" || app === "claude" || /(^|\/)claude(\s|$)/.test(argv)) return "claude";
  if (app === "omp" || /(^|\/)omp(\s|$)/.test(argv)) return "omp";
  if (app === "codex" || /(^|\/)codex(\s|$)/.test(argv)) return "codex";
  return null;
}

function claudeSessionFile(pid) {
  const meta = join(HOME, ".claude/sessions", `${pid}.json`);
  if (!existsSync(meta)) return null;
  const id = JSON.parse(readFileSync(meta, "utf8")).sessionId;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const root = join(HOME, ".claude/projects");
  for (const dir of readdirSync(root)) {
    const f = join(root, dir, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** First `n` lines of a file without reading all of it */
function headLines(path, n, bytes = 16384) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const len = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, len).toString("utf8").split("\n").slice(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * omp keeps no pid -> session record. Candidates: session files written since the process started whose
 * header cwd is the process cwd. The terminal title carries the session title, so a title match wins;
 * otherwise the most recently written one.
 */
function ompSessionFile(pid, cwd, title) {
  const root = join(HOME, ".omp/agent/sessions");
  if (!existsSync(root)) return null;
  const age = elapsedSeconds(pid);
  const since = age === null ? 0 : Date.now() - (age + 60) * 1000;
  const found = [];
  for (const dir of readdirSync(root)) {
    let names;
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const f = join(root, dir, name);
      const st = statSync(f);
      if (st.mtimeMs < since) continue;
      let head = {};
      let sessionTitle = "";
      for (const line of headLines(f, 2)) {
        try {
          const r = JSON.parse(line);
          if (r.type === "title" && typeof r.title === "string") sessionTitle = r.title;
          if (r.type === "session") head = r;
        } catch {}
      }
      if (head.cwd !== cwd) continue;
      if (!sessionTitle && typeof head.title === "string") sessionTitle = head.title;
      found.push({ f, mtime: st.mtimeMs, titled: !!sessionTitle && title.includes(sessionTitle) });
    }
  }
  found.sort((a, b) => Number(b.titled) - Number(a.titled) || b.mtime - a.mtime);
  return found[0]?.f ?? null;
}

/** Every process below `pid` (Codex's launcher runs the real binary as a child) */
function descendants(pid) {
  const out = [];
  const queue = [pid];
  while (queue.length && out.length < 200) {
    const p = queue.shift();
    let kids = "";
    try {
      kids = execFileSync("pgrep", ["-P", String(p)], { encoding: "utf8" });
    } catch {}
    for (const k of kids.split("\n").map(Number).filter(Boolean)) {
      out.push(k);
      queue.push(k);
    }
  }
  return out;
}

const ROLLOUT = /\/\.codex\/(sessions|archived_sessions)\/.*\/rollout-[^/]*\.jsonl$/;

/**
 * Codex keeps its rollout file open while it runs, in the binary its launcher starts. Find it among the
 * process tree's open files; without one, the newest rollout since the process started whose session_meta
 * cwd is the terminal's folder.
 */
function codexSessionFile(pid, cwd) {
  const open = [];
  for (const p of [pid, ...descendants(pid)]) {
    let names = "";
    try {
      names = execFileSync("lsof", ["-p", String(p), "-Fn"], { encoding: "utf8" });
    } catch {}
    for (const line of names.split("\n")) if (line.startsWith("n") && ROLLOUT.test(line.slice(1))) open.push(line.slice(1));
  }
  if (open.length) return open.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const root = join(HOME, ".codex/sessions");
  if (!existsSync(root)) return null;
  const age = elapsedSeconds(pid);
  const since = age === null ? 0 : Date.now() - (age + 60) * 1000;
  const found = [];
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      if (depth < 3) {
        try {
          if (statSync(f).isDirectory()) walk(f, depth + 1);
        } catch {}
        continue;
      }
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const st = statSync(f);
      if (st.mtimeMs < since) continue;
      try {
        if (JSON.parse(headLines(f, 1)[0]).payload?.cwd === cwd) found.push({ f, mtime: st.mtimeMs });
      } catch {}
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.f ?? null;
}

export function resolveSession(address) {
  const term = hcJson(["get", address]);
  const agent = agentOf(term);
  const pid = term.foreground?.pid;
  if (!agent || !pid) return { agent, file: null };
  const cwd = term.foreground?.cwd ?? term.cwd;
  const file =
    agent === "claude"
      ? claudeSessionFile(pid)
      : agent === "codex"
        ? codexSessionFile(pid, cwd)
        : ompSessionFile(pid, cwd, String(term.title ?? ""));
  return { agent, file };
}

// ------------------------------------------------------------ session file -> requests

async function eachJsonLine(path, fn) {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      fn(JSON.parse(line));
    } catch {}
  }
}

/**
 * Claude lines form a tree through parentUuid: a rewind or an edited resend hangs a new branch off an earlier
 * message, and the abandoned branch stays in the file. Walk back from the last message to keep only the branch
 * on screen. A compaction starts a root whose logicalParentUuid points at the message before it.
 */
function claudeActiveBranch(records) {
  // Attachments and system lines are links in the chain too
  const msgs = records.filter((r) => typeof r.uuid === "string");
  const byId = new Map(msgs.map((r) => [r.uuid, r]));
  let cur = [...msgs].reverse().find((r) => !r.isSidechain);
  if (!cur) return [];
  const chain = [];
  const seen = new Set();
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    const up = cur.parentUuid ?? cur.logicalParentUuid;
    cur = typeof up === "string" ? byId.get(up) : undefined;
  }
  return chain.reverse();
}

/**
 * Claude requests, oldest first. Claude's fullscreen view starts at the last compaction, so requests before a
 * compact_boundary are marked compacted: listed, but not on screen to jump to.
 */
async function claudePrompts(path) {
  const records = [];
  await eachJsonLine(path, (l) => records.push(l));
  const out = [];
  for (const l of claudeActiveBranch(records)) {
    if (l.type === "system" && l.subtype === "compact_boundary") {
      for (const p of out) p.compacted = true;
      continue;
    }
    const m = l.message;
    if (l.type === "assistant" && m?.role === "assistant" && !l.isSidechain) {
      addReply(out, textBlocks(m.content, "text"));
      continue;
    }
    // isCompactSummary: the summary Claude feeds itself after a compaction, not something typed
    if (l.type !== "user" || m?.role !== "user" || l.isMeta || l.isSidechain || l.isCompactSummary) continue;
    const text = userTextOf(m.content);
    if (text) out.push({ text });
  }
  return out;
}

/** Entries on the active branch, oldest first (Illithid's ompActiveBranch) */
function ompActiveBranch(records) {
  const entries = records.filter((r) => r.type !== "title" && r.type !== "session");
  const byId = new Map();
  for (const r of entries) if (typeof r.id === "string") byId.set(r.id, r);
  if (!byId.size) return entries;
  let cur;
  for (let i = entries.length - 1; i >= 0 && !cur; i--) if (typeof entries[i].id === "string") cur = entries[i];
  const chain = [];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
  }
  return chain.reverse();
}

async function ompPrompts(path) {
  const records = [];
  await eachJsonLine(path, (r) => records.push(r));
  const out = [];
  for (const r of ompActiveBranch(records)) {
    const m = r.type === "message" ? r.message : undefined;
    if (m?.role === "assistant") {
      addReply(out, textBlocks(m.content, "text"));
      continue;
    }
    if (!m || m.role !== "user" || m.synthetic) continue;
    const text = userTextOf(m.content);
    if (text) out.push({ text });
  }
  return out;
}

/** Codex rollout: the person's messages are `response_item` user messages (the `event_msg` copy is skipped) */
async function codexPrompts(path) {
  const out = [];
  await eachJsonLine(path, (l) => {
    const p = l.payload;
    if (l.type !== "response_item" || p?.type !== "message") return;
    if (p.role === "user") {
      const text = userTextOf(p.content);
      if (text) out.push({ text });
    } else if (p.role === "assistant") addReply(out, textBlocks(p.content, "output_text"));
  });
  return out;
}

/** The text blocks of a message's content: `type` blocks (or plain `text`) with something in them */
function textBlocks(content, type) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && (b.type === type || b.type === "text") && typeof b.text === "string" && b.text.trim())
    .map((b) => b.text)
    .join("\n\n");
}

const REPLY_MAX = 280;

/** The first answer after the latest prompt becomes its reply preview (later ones in the turn are ignored) */
function addReply(out, text) {
  const last = out[out.length - 1];
  const t = text.trim();
  if (!last || last.reply !== undefined || !t) return;
  last.reply = t.length > REPLY_MAX ? `${t.slice(0, REPLY_MAX)}…` : t;
}

/** The prompts of a session file, oldest first: [{text, reply?, compacted?}] */
export function promptsOf(agent, path) {
  if (agent === "claude") return claudePrompts(path);
  if (agent === "codex") return codexPrompts(path);
  return ompPrompts(path);
}

/**
 * The text to list: a prompt another terminal sent with `hc send` arrives wrapped as
 * `<hc from="t7">…</hc>`; the wrapper stays in the screen key (the program draws it) but not in the list.
 */
export function listText(text) {
  return text.replace(/^<hc from="[^"]*">([\s\S]*?)<\/hc>$/, "$1").trim() || text;
}

/** What a request looks like on screen: its first line, whitespace collapsed, at most 40 characters */
export function screenKey(text) {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return first.replace(/\s+/g, " ").trim().slice(0, 40);
}

export async function listPrompts(address) {
  const { agent, file } = resolveSession(address);
  if (!file) return { agent, file: null, prompts: [] };
  const texts = await promptsOf(agent, file);
  return {
    agent,
    file,
    prompts: texts.map(({ text: raw, reply, compacted }, index) => {
      const t = listText(raw);
      return {
      index,
      text: t.length > 300 ? `${t.slice(0, 300)}…` : t,
      key: screenKey(raw),
      ...(reply ? { reply } : {}),
      ...(compacted ? { compacted: true } : {}),
      };
    }),
  };
}

// ------------------------------------------------------------ jumping (shell runs of the panel's jump.js)

async function locate(address, index) {
  const { jumpTo } = await import("./jump.js");
  const { agent, prompts } = await listPrompts(address);
  const run = (cmd, args) => {
    try {
      return { code: 0, stdout: execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 }), stderr: "" };
    } catch (e) {
      return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message) };
    }
  };
  const io = {
    hc: async (args) => run(HC, args),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    scroll: async (args) => {
      const flags = Object.entries(args).flatMap(([k, v]) => [`--${k}`, String(v)]);
      run("herdr-app", ["do", "terminal.scroll", ...flags]);
    },
  };
  return jumpTo(io, address, agent, prompts, index);
}

// ------------------------------------------------------------ cli

async function main() {
  const [cmd, address, index] = process.argv.slice(2);
  let out;
  if (cmd === "prompts" && address) out = await listPrompts(address);
  else if (cmd === "locate" && address && index !== undefined) out = await locate(address, Number(index));
  else out = { error: "usage: prompts.mjs prompts <terminal> | locate <terminal> <index>" };
  process.stdout.write(JSON.stringify(out));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) }));
    process.exitCode = 1;
  });
}
