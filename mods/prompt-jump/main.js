// Prompt Jump: the prompts typed into the focused agent's session (Claude Code, Codex or omp), oldest first.
// Clicking one scrolls that agent's terminal to it. Clicking this panel keeps the last agent shown.
// `prompt-jump.prev` / `prompt-jump.next` (keys.json, cmd-shift-up/down) step from the last one jumped to.
//
// prompts.mjs (run with node) reads the list: terminal -> session file -> requests. Jumping runs
// here, on Herdr's built-in hc (no shell, no node): jump.js scrolls Herdr's view of a terminal with
// host history (omp) and pages a full-screen program (Claude's fullscreen TUI) by its own keys.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { exec, hc, focused, terminals, agents, run, theme, appHome, notify, nextCommand, props, shared, setShared } from "herdr";
import { jumpTo, neighbor, spyActive, screen, fullScreen, transcriptRows, viewAtBottom, isFullScreen, MARKER } from "./jump.js";
import { searchPrompts } from "./search.js";
import { alive, waking, forwardOpenRequest, initialOpenNonce } from "./relay.js";

const HELPER = () => `${appHome()}/mods/prompt-jump/prompts.mjs`;
const SUPPORTED = new Set(["claude", "codex", "omp"]);
const LABEL = { claude: "Claude", codex: "Codex", omp: "omp" };
const POLL_MS = 800;
const WORKING_RELOAD_MS = 4000;
const RELAY_KEY = "prompt-jump.relay";
const PANEL_KEY = "prompt-jump.panel";
const STEP_KEY = "prompt-jump.step";
// Another mod asks for a terminal's prompts: setShared("prompt-jump.open", { terminal, n: <unique> })
const OPEN_KEY = "prompt-jump.open";
const RELAY_BEAT_MS = 30000;
const PANEL_BEAT_MS = 10000;
const SHARED_MS = 120;
const SPY_MS = 350;
const ROW_HEIGHT = 44; // two 12px lines (34px) and 5px above and below

/** -1 / +1 for the prev / next key commands, else null */
const stepOf = (command) => ({ prev: -1, next: 1 })[String(command).split(".").pop()] ?? null;

/** A relay heard from recently is the one forwarding keys */
const relayAlive = () => alive(shared(RELAY_KEY), RELAY_BEAT_MS, Date.now());

/** "claude" | "omp" | null for a core terminal */
function kindOf(t) {
  const app = t?.report?.app ?? t?.program?.agent ?? t?.program?.key ?? "";
  const argv = (t?.argv ?? []).join(" ");
  if (/claude/.test(app) || /(^|\/)claude(\s|$)/.test(argv)) return "claude";
  if (/^omp$/.test(app)) return "omp";
  if (/^codex$/.test(app) || /(^|\/)codex(\s|$)/.test(argv)) return "codex";
  return app ? app : null;
}

async function helper(args) {
  const r = await exec("node", [HELPER(), ...args]);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300) };
  }
}

export default class PromptJump extends View {
  init(_props, cx) {
    // The relay copy: an empty floating block that is always shown, so key commands reach it even while the
    // panel is toggled off (Herdr delivers <mod>.<command> to shown copies only). It forwards each key
    // through shared state to the panel, which stays alive while hidden. A panel copy starts only once it is
    // shown, so with no panel beating, the key shows it and the starting copy takes that key.
    this.relay = (props() ?? {}).role === "relay";
    if (this.relay) {
      const beat = () => setShared(RELAY_KEY, { at: Date.now() });
      beat();
      cx.timer.every(RELAY_BEAT_MS, () => beat());
      this.lastOpen = shared(OPEN_KEY)?.n ?? null;
      cx.timer.every(SHARED_MS, () => {
        const request = forwardOpenRequest(shared(OPEN_KEY), this.lastOpen, shared(PANEL_KEY), PANEL_BEAT_MS, Date.now());
        if (!request) return;
        this.lastOpen = request.n;
        if (request.wake) {
          setShared(OPEN_KEY, request);
          run("layout.show", { id: "prompt-jump" });
        }
      });
      cx.spawn(async () => {
        let n = 0;
        for (;;) {
          const dir = stepOf(await nextCommand());
          if (!dir) continue;
          const at = Date.now();
          const wake = !alive(shared(PANEL_KEY), PANEL_BEAT_MS, at);
          setShared(STEP_KEY, wake ? { dir, n: `${at}-${++n}`, at, wake } : { dir, n: `${at}-${++n}`, at });
          if (wake) run("layout.show", { id: "prompt-jump" });
        }
      });
      return;
    }
    const beat = () => setShared(PANEL_KEY, { at: Date.now() });
    beat();
    cx.timer.every(PANEL_BEAT_MS, () => beat());
    this.target = null; // terminal address shown
    this.kind = null;
    this.title = "";
    this.prompts = [];
    this.file = null;
    this.error = null;
    this.loading = false;
    this.unsupported = null; // focused agent kind we cannot read
    this.active = null; // last request jumped to
    this.jumping = null;
    this.lastLoad = 0;
    this.lastStatus = null;
    // A step forwarded before this copy started is not for it, unless it is the one that showed it
    const lastStep = shared(STEP_KEY);
    this.lastStep = lastStep && !waking(lastStep, Date.now()) ? lastStep.n : null;
    this.lastOpen = initialOpenNonce(shared(OPEN_KEY), Date.now());
    this.lastFocused = undefined; // the first poll counts as a focus change
    this.scroll = VirtualListScrollHandle.new();
    this.query = "";
    this.searchBox = InputState.new({ placeholder: "Search prompts…" });
    this.searchBox.on("change", (_e, acx) => {
      this.query = this.searchBox.value();
      acx.notify();
    });
    cx.timer.every(POLL_MS, (acx) => this.poll(acx));
    this.poll(cx);
    // Requests through shared state (the relay's keys, another mod's open). A hidden panel doesn't render,
    // but its timers run: check here, often enough that a key feels immediate. Reading shared costs nothing.
    cx.timer.every(SHARED_MS, (acx) => {
      this.takeStep(acx);
      this.takeOpen(acx);
    });
    // Claude and Codex draw their own view: read it to highlight the prompt being read
    this.spySig = null;
    this.jumpSig = null;
    this.spying = false;
    cx.timer.every(SPY_MS, (acx) => this.spy(acx));
    // Keys straight to a shown panel, when no relay forwards them
    cx.spawn(async (acx) => {
      for (;;) {
        const dir = stepOf(await nextCommand());
        if (dir && !relayAlive()) this.step(dir, acx);
      }
    });
  }

  async close() {
    if (this.relay) {
      setShared(RELAY_KEY, null);
      return;
    }
    setShared(PANEL_KEY, null);
    this.searchBox.release();
    this.scroll.release();
  }

  /** The prompts the list shows: all of them, or those matching the search box */
  visible() {
    return searchPrompts(this.prompts, this.query);
  }

  /**
   * A request from another mod (a herdr-ticket session row) to list a terminal's prompts. The panel shows that
   * terminal until a different agent terminal is focused, and shows itself if it was toggled off.
   */
  takeOpen(cx) {
    const o = shared(OPEN_KEY);
    if (!o || o.n === this.lastOpen) return;
    this.lastOpen = o.n;
    if (o.wake) setShared(OPEN_KEY, { ...o, wake: false });
    cx.spawn(async (acx) => {
      const t = terminals().find((x) => x.address === o.terminal);
      const kind = kindOf(t);
      if (!t || !SUPPORTED.has(kind)) {
        notify({ title: "Prompt Jump", body: `${o.terminal} is not a Claude Code, Codex or omp terminal`, level: "warning", timeout: 4000 });
        return;
      }
      if (o.terminal !== this.target) this.select(o.terminal, kind, t, acx);
      run("layout.show", { id: "prompt-jump" });
    });
  }

  /**
   * Highlight the prompt on the terminal's screen (Claude, Codex). Skipped while a jump runs, and until the screen
   * changes after one: the jumped prompt may land low on screen, where the rule would pick the one before it.
   */
  spy(cx) {
    if (this.spying || this.jumping !== null || !this.target || !isFullScreen(this.kind) || !this.prompts.length) return;
    const address = this.target;
    this.spying = true;
    cx.spawn(async (acx) => {
      try {
        const all = await fullScreen(hc, address);
        const rows = transcriptRows(all);
        const sig = all.join("\n");
        if (address !== this.target || sig === this.spySig || sig === this.jumpSig) return;
        this.spySig = sig;
        this.jumpSig = null;
        // Compacted Claude prompts are not on screen: placing request lines must not count them
        const onScreen = this.kind === "claude" ? this.prompts.filter((p) => !p.compacted) : this.prompts;
        const index = spyActive(rows, MARKER[this.kind], onScreen, { atBottom: viewAtBottom(this.kind, all) === true });
        if (index === null || index === this.active) return;
        this.active = index;
        const at = this.visible().findIndex((p) => p.index === index);
        if (at >= 0) this.scroll.scroll_to_item(at, "center");
        acx.notify();
      } catch {
        // A terminal that ended or can't be read: the next poll deals with it
      } finally {
        this.spying = false;
      }
    });
  }

  /** A key forwarded by the relay. The one that showed this panel waits for its first list. */
  takeStep(cx) {
    const s = shared(STEP_KEY);
    if (!s || s.n === this.lastStep) return;
    if (waking(s, Date.now()) && (!this.target || this.loading || !this.lastLoad)) return;
    this.lastStep = s.n;
    this.step(s.dir, cx);
  }

  /** Jump to the prompt before or after the last one jumped to (from the bottom when there is none) */
  step(dir, cx) {
    if (this.jumping !== null || !this.target) return;
    // Steps stay inside the search results; a jumped prompt hidden by the search steps from the bottom
    const shown = this.visible();
    const from = shown.some((p) => p.index === this.active) ? this.active : null;
    const index = neighbor(shown, from, dir, this.kind);
    if (index === null) return;
    // Keep the list on the row the key moved to
    const at = shown.findIndex((p) => p.index === index);
    if (at >= 0) this.scroll.scroll_to_item(at, "center");
    this.jump(index, cx);
  }

  poll(cx) {
    const f = focused();
    const address = f?.terminal ?? null;
    const all = terminals();
    // Follow focus when it moves, not every poll: a terminal opened on request stays until focus changes
    const moved = address !== this.lastFocused;
    this.lastFocused = address;
    if (moved && address && address !== this.target) {
      const t = all.find((x) => x.address === address);
      const kind = kindOf(t);
      if (kind && SUPPORTED.has(kind)) {
        this.select(address, kind, t, cx);
        return;
      }
      // An agent we cannot read says so; a shell or a mod keeps the last agent
      const isAgent = agents().some((a) => a.address === address);
      const next = isAgent ? kind : null;
      if (next !== this.unsupported) {
        this.unsupported = next;
        cx.notify();
      }
      return;
    }
    if (address === this.target && this.unsupported) {
      this.unsupported = null;
      cx.notify();
    }
    if (!this.target) return;
    const t = all.find((x) => x.address === this.target);
    if (!t) {
      this.target = null;
      this.prompts = [];
      cx.notify();
      return;
    }
    // New requests arrive while it works and when a turn ends
    const status = agents().find((a) => a.address === this.target)?.status ?? null;
    const changed = status !== this.lastStatus;
    this.lastStatus = status;
    if (changed || (status === "working" && Date.now() - this.lastLoad > WORKING_RELOAD_MS)) this.load(cx);
  }

  select(address, kind, t, cx) {
    this.target = address;
    this.kind = kind;
    this.title = t?.title ?? "";
    this.unsupported = null;
    this.prompts = [];
    this.file = null;
    this.error = null;
    this.active = null;
    // A search belongs to the session it was typed for
    this.query = "";
    this.searchBox.set_value("");
    this.lastStatus = agents().find((a) => a.address === address)?.status ?? null;
    this.load(cx);
    cx.notify();
  }

  load(cx) {
    if (this.loading || !this.target) return;
    const address = this.target;
    this.loading = true;
    this.lastLoad = Date.now();
    cx.spawn(async (acx) => {
      let out;
      try {
        out = await helper(["prompts", address]);
      } catch (e) {
        out = { error: String(e?.message ?? e) };
      }
      this.loading = false;
      if (address !== this.target) {
        this.load(acx);
        return;
      }
      this.error = out.error ?? null;
      if (!out.error) {
        // A new prompt was sent: the view follows it to the bottom, so stepping starts there again
        if ((out.prompts ?? []).length > this.prompts.length && this.prompts.length) this.active = null;
        this.prompts = out.prompts ?? [];
        this.file = out.file ?? null;
        if (!out.file) this.error = "No session file found for this terminal";
      }
      const t = terminals().find((x) => x.address === address);
      if (t?.title) this.title = t.title;
      acx.notify();
    });
  }

  jump(index, cx) {
    if (this.jumping !== null || !this.target) return;
    const address = this.target;
    this.jumping = index;
    this.active = index;
    cx.notify();
    const prompts = this.prompts;
    const agent = this.kind;
    cx.spawn(async (acx) => {
      const io = {
        hc: (args) => hc(args),
        sleep: (ms) => acx.sleep(ms),
        scroll: async (args) => run("terminal.scroll", args),
      };
      let out;
      try {
        out = await jumpTo(io, address, agent, prompts, index);
      } catch (e) {
        out = { error: String(e?.message ?? e) };
      }
      if (out.error || !out.found) {
        notify({
          title: "Prompt Jump",
          body: out.error
            ? `Could not jump: ${out.error}`
            : out.compacted
              ? "Sent before the conversation was compacted: Claude only shows what came after"
              : out.mode === "history"
              ? "This prompt has scrolled out of the terminal history"
              : "Could not find this prompt on screen",
          level: "warning",
          timeout: 4000,
        });
      }
      // The screen the jump left: the spy waits until it changes (the person scrolls or the agent writes)
      if (out.found && isFullScreen(agent)) {
        try {
          this.jumpSig = (await fullScreen(hc, address)).join("\n");
        } catch {}
      }
      this.jumping = null;
      acx.notify();
    });
  }

  row(p, t) {
    const on = this.active === p.index;
    const compacted = p.compacted && this.kind === "claude";
    return h_flex()
      .h(ROW_HEIGHT)
      .items_start()
      .gap(8)
      .px(12)
      .py(5)
      .border_l(2)
      .border_color(on ? t.accent : t.chrome)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      // The start of the answer that followed, after resting the pointer on the row
      .when(!!p.reply, (el) => el.tooltip(p.reply))
      .child(
        this.jumping === p.index
          ? div().w(22).flex_none().text_size(11).text_color(t.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80)
          : div().w(22).flex_none().text_size(11).text_color(on ? t.accent : t.dim).child(String(p.index + 1)),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .text_size(12)
          .max_h(34)
          .overflow_hidden()
          .text_color(on ? t.foreground : compacted ? t.dim : t.muted)
          .child(p.text.replace(/\s+/g, " ")),
      )
      .when(compacted, (el) =>
        el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child("compacted")),
      );
  }

  render(cx) {
    if (this.relay) return div();
    const t = theme();
    const header = v_flex()
      .px(12)
      .pt(10)
      .pb(8)
      .gap(2)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Prompt Jump"))
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .text_color(this.jumping !== null ? t.accent : t.dim)
              .child(
                this.jumping !== null
                  ? `Jumping to #${this.jumping + 1}…`
                  : this.loading
                    ? "Reading…"
                    : this.target
                      ? this.query.trim()
                        ? `${this.visible().length} of ${this.prompts.length}`
                        : `${this.prompts.length} prompt${this.prompts.length === 1 ? "" : "s"}`
                      : "",
              ),
          ),
      )
      .when(!!this.target, (el) =>
        el.child(
          div()
            .text_size(11)
            .text_color(t.muted)
            .truncate()
            .child(`${LABEL[this.kind] ?? this.kind} · ${this.target} · ${this.title || ""}`),
        ),
      )
      .when(!!this.unsupported, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child(`${this.unsupported} is not supported yet (Claude Code, Codex and omp only)`)),
      );

    let body;
    if (!this.target) {
      body = div().p(12).text_size(12).text_color(t.dim).child("Focus a Claude Code, Codex or omp terminal to list its prompts here");
    } else if (this.error) {
      body = div().p(12).text_size(12).text_color(t.blocked ?? t.muted).child(this.error);
    } else if (this.prompts.length === 0) {
      body = div().p(12).text_size(12).text_color(t.dim).child(this.loading ? "" : "No prompts yet");
    } else {
      const prompts = this.visible();
      if (!prompts.length) {
        body = div().p(12).text_size(12).text_color(t.dim).child("No prompts match the search");
      } else {
      // A virtual list with fixed-height rows, so a key step can bring its row into view (scroll_to_item).
      // Rows can't carry handlers inside a virtual list: one on_item_click for the list, keyed by index.
      body = v_flex()
        .relative()
        .flex_1()
        .min_h(0)
        .child(
          v_virtual_list("prompt-jump-list", prompts.length, ROW_HEIGHT, (i) => String(prompts[i].index), (range) =>
            prompts.slice(range.start, range.end).map((p) => this.row(p, t)),
          )
            .size_full()
            .track_scroll(this.scroll)
            .on_item_click((key, cx) => this.jump(Number(key), cx)),
        )
        .child(Scrollbar.vertical("prompt-jump-list").absolute().inset_0());
      }
    }

    const search = div()
      .px(12)
      .py(8)
      .border_b(1)
      .border_color(t.border)
      .child(
        Input.new(this.searchBox)
          .h(28)
          .px(8)
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .bg(t.raised)
          .text_size(12)
          .accessibility_label("Search prompts"),
      );
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.chrome)
      .child(header)
      .when(!!this.target && !this.error && this.prompts.length > 0, (el) => el.child(search))
      .child(body);
  }
}
