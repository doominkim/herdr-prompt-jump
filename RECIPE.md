# Prompt Jump

A panel beside the terminals that lists, oldest first, the prompts the person typed into the focused Claude Code or omp session. Clicking one scrolls that agent's terminal so the prompt is in view.

![Prompt Jump](preview.png)

## What you see

- A block about 320px wide (min 220, max 560) on the `chrome` background, toggled with F7 (`layout.toggle:prompt-jump`).
- Header (12px horizontal, 10px top / 8px bottom padding, 1px `border` bottom edge):
  - "Prompt Jump" (12px, semibold, `foreground`), with the count on the right ("7 prompts", 11px, `dim`). While reading it says "Reading…". While jumping it says "Jumping to #N…" in `accent`.
  - Below, one truncated 11px `muted` line: `Claude · t7 · <terminal title>` or `omp · t7 · <terminal title>`.
  - When an agent other than these two is focused: "<agent> is not supported yet (Claude Code and omp only)" (11px, `dim`).
- List (scrolls with a scrollbar, 4px vertical padding). Each row is 12px horizontal and 5px vertical padding, 8px gap:
  - The number (22px column, 11px, `dim`). The clicked row's number is `accent`. While that row is jumping, the number is a braille spinner (`.frames`, 80ms).
  - The prompt with whitespace collapsed (12px, `muted`, at most 34px tall, i.e. about two lines, overflow hidden).
  - A 2px left border, `accent` on the clicked row and `chrome` otherwise. The clicked row also has a `selected` background. Rows get the `hover` background on hover.
  - Claude prompts from before a compaction: `dim` text and a small "compacted" tag (10px, `raised` background, 4px radius).
- Empty states (12px, `dim`, 12px padding): "Focus a Claude Code or omp terminal to list its prompts here", "No prompts yet". Errors such as "No session file found for this terminal" appear in `blocked`.

## How it behaves

- Every 800ms it checks `focused().terminal`. A focused terminal whose agent is Claude Code or omp becomes the panel's session. Anything else keeps the last session: a shell, this panel itself (clicking it makes `terminal` null) or another mod.
- The list reloads when the session's agent status changes, and every 4s while it is `working`.
- Clicking a row jumps (one jump at a time; later clicks are ignored until it ends):
  - First, Claude Code: page its fullscreen view. If the target is not unique or no request on screen says which way to go, start from the nearer end (`ctrl+home` if it is in the first half of the on-screen prompts, else `ctrl+end`). Then step `pagedown`/`pageup`, counting matches only in the rows that scrolled in. If neither the keys nor the anchor move the screen, fall back to history.
  - History (omp, or a Claude Code without fullscreen): read the terminal with `hc read --lines 100000`, find the prompt line, then `terminal.scroll {to: "bottom"}` and `terminal.scroll {lines: -(distance - rows + 3)}` so the prompt is near the top.
  - Not found shows a warning toast for 4s: "This prompt has scrolled out of the terminal history", "Could not find this prompt on screen", or, for compacted Claude prompts (no paging), "Sent before the conversation was compacted: Claude only shows what came after".
- A prompt line is the prompt's first 40 characters, with whitespace collapsed. It starts right after the program's prompt marker (`❯` for Claude Code, only indentation for omp), so the same words inside an answer don't count.

## Built from

- One block in the person's layout: `{ "id": "prompt-jump", "type": "block", "content": { "mod": "prompt-jump" } }`. `mod.json` is `{ "place": "none" }`.
- `main.js`: the `View`. It uses `focused()`, `terminals()`, `agents()`, `theme()`, `run("terminal.scroll", …)`, `notify(…)`, `exec("node", [prompts.mjs, "prompts", <terminal>])` for the list, the built-in `hc([...])` for jumps, and `cx.sleep`.
- `jump.js`: pure jump logic taking `{ hc, sleep, scroll }`, used by the panel and by `prompts.mjs locate`.
- `prompts.mjs` (node):
  - Resolving the session: `hc get <t> --json` gives `foreground.pid`, `cwd`, `title` and `status.app`.
    - Claude: `~/.claude/sessions/<pid>.json` holds `sessionId`, and the transcript is `~/.claude/projects/*/<sessionId>.jsonl`.
    - omp: the `~/.omp/agent/sessions/*/*.jsonl` files modified since the process started (`ps -o etime=`, minus 60s) whose line-2 header `cwd` matches. Prefer the one whose line-1 `title` is inside the terminal title, else the newest.
  - Filtering: Illithid's `cleanUserText` (strip `<system-reminder>`; drop injected prefixes such as `<task-notification`, `Caveat:`, `<local-command-stdout`; slash commands as `name args`; pasted content as `[pasted content] …`). Plus `isMeta`, `isSidechain` and `isCompactSummary` lines are dropped, and synthetic omp messages too.
  - Active branch:
    - Claude: walk `parentUuid` (or `logicalParentUuid` across a compaction) back from the last line that has a `uuid` of any type, and reverse. Every prompt before a `system`/`compact_boundary` line is `compacted`.
    - omp: walk `parentId` from the last entry.
  - A prompt sent from another terminal with `hc send` is saved and drawn as `<hc from="t7">…</hc>`. The list shows it unwrapped, but the screen key keeps the wrapper.

## Watch out

- `hc read --lines N` on a full-screen program costs about 1.2s (herdr-core collects the program's own history). So Claude Code pages first and reads history only as a fallback, and the paging reads use plain `hc read`.
- `hc keys` paces keys at about 33ms each. Sending several keys in one call is no faster than separate calls.
- When the app first sees a mod folder without `mod.json`, it docks a copy into the layout by itself. Install the folder whole (`install-mod.sh` builds it aside, then moves it).
- Run node by name through `exec`. The app's environment must have it on `PATH`.
- `pane.focus` from a shell races the person using the window. Don't script screenshots of the panel while someone works in it.

## Done when

- Focusing a Claude Code terminal lists its prompts. Rewound and compaction-summary messages are not in the list, and pre-compaction prompts show "compacted".
- Clicking the panel itself keeps the list.
- Clicking a Claude Code prompt one page away lands it on screen in under 100ms. A compacted one warns at once without paging.
- Clicking an omp prompt still in history scrolls it to the top of the view.
- Two identical prompts ("ok" twice) each jump to their own place.
- `herdr-app check ~/.config/herdr-app/mods/prompt-jump` passes.
