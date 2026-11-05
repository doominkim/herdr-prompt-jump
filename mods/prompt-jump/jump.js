// Finding a request on a terminal and bringing it into view. Pure: the caller hands in
// `hc(args) -> Promise<{code, stdout, stderr}>`, `sleep(ms)` and `scroll(args)` (Herdr's terminal.scroll),
// so the panel runs it on Herdr's built-in hc and prompts.mjs runs the same code from a shell.
//
// Two kinds of terminal:
// - With host history (omp): find the request line and scroll Herdr's view so it sits at the top.
// - A full-screen program (Claude's fullscreen TUI keeps no host history): page the program's own view.
//   Start from what is on screen: a request visible there says which way the target is.

const norm = (s) => s.replace(/\s+/g, " ");

export const MARKER = { claude: "❯", omp: "" };

/**
 * A request line starts with the request, after the program's prompt marker (Claude: "❯") or nothing but
 * indentation (omp draws requests as an indented block), so the same words inside an answer don't count.
 */
export function isRequestLine(line, key, marker) {
  if (!key) return false;
  const l = norm(line);
  const at = l.indexOf(key);
  if (at < 0) return false;
  return l.slice(0, at).trim() === marker;
}

/** Index of the line showing the request: the `n`-th match from the bottom (0-based) */
export function findLine(lines, key, marker, n) {
  let seen = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isRequestLine(lines[i], key, marker)) continue;
    if (seen++ === n) return i;
  }
  return -1;
}

async function json(hc, args) {
  const r = await hc([...args, "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `hc ${args[0]} failed`).trim());
  return JSON.parse(r.stdout);
}

/**
 * Brings request `index` of `prompts` ({index, key}[]) into view on terminal `address`.
 * Returns {mode, found, ...}; never throws for "not found".
 */
export async function jumpTo({ hc, sleep, scroll }, address, agent, prompts, index) {
  const target = prompts[index];
  if (!target) return { error: "no such request" };
  // Claude's fullscreen view begins at the last compaction: nothing before it is on screen
  if (agent === "claude" && target.compacted) return { mode: "screen", found: false, compacted: true };
  const marker = MARKER[agent] ?? "";
  // Later requests starting the same way sit below it; skip that many matches from the bottom
  const later = prompts.slice(index + 1).filter((p) => p.key === target.key).length;
  // Asking a full-screen program's terminal for history costs about a second, and nothing cheaper says which kind
  // it is. Claude (fullscreen TUI) pages first and falls back to history if its keys move nothing; omp has history.
  if (agent === "claude") {
    const paged = await pageTo({ hc, sleep }, address, marker, prompts, index, later);
    if (paged.found || paged.moved) return paged;
  }
  const read = await json(hc, ["read", address, "--lines", "100000"]);
  if (read.how === "history") {
    const lines = read.text.replace(/\n$/, "").split("\n");
    const at = findLine(lines, target.key, marker, later);
    if (at < 0) return { mode: "history", found: false };
    const rows = (await json(hc, ["get", address])).rows ?? 0;
    // Put the request near the top: the view's bottom row goes `rows - 3` lines below it
    const up = Math.max(0, lines.length - 1 - at - Math.max(0, rows - 3));
    await scroll({ terminal: address, to: "bottom" });
    if (up > 0) await scroll({ terminal: address, lines: -up });
    return { mode: "history", found: true, up };
  }
  if (agent === "claude") return { mode: "screen", found: false };
  return pageTo({ hc, sleep }, address, marker, prompts, index, later);
}

// ------------------------------------------------------------ full-screen programs

/** The transcript part of the screen: the input box and status rows at the bottom are not */
async function screen(hc, address) {
  const lines = (await json(hc, ["read", address])).text.split("\n");
  return lines.slice(0, Math.max(1, lines.length - 6));
}

/**
 * Press `key` and return the redrawn screen, or null if it didn't move (top or bottom reached, or keys the
 * program ignores). The redraw has usually landed by the time `hc keys` returns, so read at once and only
 * then poll briefly.
 */
async function press(hc, sleep, address, key, before, patience = 300) {
  await hc(["keys", address, key]);
  const was = before.join("\n");
  for (let waited = 0; ; waited += 15) {
    const now = await screen(hc, address);
    if (now.join("\n") !== was) return now;
    if (waited >= patience) return null;
    await sleep(15);
  }
}

/**
 * How many rows the view moved between two screens of equal height: the smallest shift that lines the old
 * rows up with the new ones. A screen with no overlap at all counts as wholly new.
 */
function shiftBetween(prev, next, down) {
  const n = Math.min(prev.length, next.length);
  for (let s = 1; s < n; s++) {
    let same = true;
    for (let i = 0; i < n - s && same; i++) same = down ? next[i] === prev[i + s] : next[i + s] === prev[i];
    if (same) return s;
  }
  return n;
}

/** Indices of the requests on screen, when their first words name exactly one request */
function visibleIndices(lines, marker, prompts) {
  const byKey = new Map();
  for (const p of prompts) byKey.set(p.key, byKey.has(p.key) ? null : p.index);
  const out = [];
  for (const line of lines)
    for (const [key, idx] of byKey) if (idx !== null && isRequestLine(line, key, marker)) out.push(idx);
  return out;
}

/**
 * Full-screen programs. Start from whichever is nearest the target, counted in requests: where the screen is
 * now (when a request on it names one entry), the top (ctrl+home) or the bottom (ctrl+end).
 */
async function pageTo({ hc, sleep }, address, marker, prompts, index, later, maxPages = 400) {
  const target = prompts[index];
  // Requests before a compaction aren't drawn: they don't count for order or distance
  prompts = prompts.filter((p) => !p.compacted);
  const first = prompts[0]?.index ?? 0;
  const earlier = prompts.filter((p) => p.index < index && p.key === target.key).length;
  const unique = earlier === 0 && later === 0;
  let lines = await screen(hc, address);
  let moved = false;

  const seenNow = unique ? visibleIndices(lines, marker, prompts) : [];
  const fromHere = seenNow.length ? Math.min(...seenNow.map((i) => Math.abs(i - index))) : Infinity;
  const fromTop = index - first;
  const fromBottom = (prompts[prompts.length - 1]?.index ?? index) - index;

  // Directed from here: what is on screen says up or down
  if (fromHere <= Math.min(fromTop, fromBottom)) {
    for (let page = 0; page <= maxPages; page++) {
      if (lines.some((l) => isRequestLine(l, target.key, marker))) return { mode: "screen", found: true, moved, pages: page };
      const seen = visibleIndices(lines, marker, prompts);
      // Nothing to steer by (inside one long answer), or the target lies between two shown requests
      if (!seen.length) break;
      const key = Math.min(...seen) > index ? "pageup" : Math.max(...seen) < index ? "pagedown" : null;
      if (!key) break;
      const next = await press(hc, sleep, address, key, lines);
      if (!next) break;
      moved = true;
      lines = next;
    }
  }

  // From the nearer end, counting matching lines in walking order; each line once (pages overlap)
  const down = fromTop <= fromBottom;
  const skip = down ? earlier : later;
  // Already at that end: the screen stays put, so don't wait long for a redraw
  const anchored = await press(hc, sleep, address, down ? "ctrl+home" : "ctrl+end", lines, 90);
  if (anchored) {
    moved = true;
    lines = anchored;
  }
  // Count each match once. After a page, only the rows that scrolled in are new: going down they are at the
  // bottom, going up at the top. Identical short prompts ("ok") can only be told apart this way.
  let seen = 0;
  let fresh = lines;
  for (let page = 0; page <= maxPages; page++) {
    const hits = [];
    for (const l of fresh) if (isRequestLine(l, target.key, marker)) hits.push(l);
    if (!down) hits.reverse();
    for (const _ of hits) if (seen++ === skip) return { mode: "screen", found: true, moved, pages: page };
    const next = await press(hc, sleep, address, down ? "pagedown" : "pageup", lines);
    if (!next) return { mode: "screen", found: false, moved, pages: page };
    const shift = shiftBetween(lines, next, down);
    fresh = down ? next.slice(next.length - shift) : next.slice(0, shift);
    moved = true;
    lines = next;
  }
  return { mode: "screen", found: false, moved, pages: maxPages };
}
