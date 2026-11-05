// Prompt Jump: the prompts typed into the focused agent's session (Claude Code or omp), oldest first.
// Clicking one scrolls that agent's terminal to it. Clicking this panel keeps the last agent shown.
//
// prompts.mjs (run with node) reads the list: terminal -> session file -> requests. Jumping runs
// here, on Herdr's built-in hc (no shell, no node): jump.js scrolls Herdr's view of a terminal with
// host history (omp) and pages a full-screen program (Claude's fullscreen TUI) by its own keys.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, focused, terminals, agents, run, theme, appHome, notify } from "herdr";
import { jumpTo } from "./jump.js";

const HELPER = () => `${appHome()}/mods/prompt-jump/prompts.mjs`;
const SUPPORTED = new Set(["claude", "omp"]);
const POLL_MS = 800;
const WORKING_RELOAD_MS = 4000;

/** "claude" | "omp" | null for a core terminal */
function kindOf(t) {
  const app = t?.report?.app ?? t?.program?.agent ?? t?.program?.key ?? "";
  const argv = (t?.argv ?? []).join(" ");
  if (/claude/.test(app) || /(^|\/)claude(\s|$)/.test(argv)) return "claude";
  if (/^omp$/.test(app)) return "omp";
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
    cx.timer.every(POLL_MS, (acx) => this.poll(acx));
    this.poll(cx);
  }

  poll(cx) {
    const f = focused();
    const address = f?.terminal ?? null;
    const all = terminals();
    if (address && address !== this.target) {
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
      if (address !== this.target) return;
      this.error = out.error ?? null;
      if (!out.error) {
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
      this.jumping = null;
      acx.notify();
    });
  }

  render(_cx) {
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
                      ? `${this.prompts.length} prompt${this.prompts.length === 1 ? "" : "s"}`
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
            .child(`${this.kind === "omp" ? "omp" : "Claude"} · ${this.target} · ${this.title || ""}`),
        ),
      )
      .when(!!this.unsupported, (el) =>
        el.child(div().text_size(11).text_color(t.dim).child(`${this.unsupported} is not supported yet (Claude Code and omp only)`)),
      );

    let body;
    if (!this.target) {
      body = div().p(12).text_size(12).text_color(t.dim).child("Focus a Claude Code or omp terminal to list its prompts here");
    } else if (this.error) {
      body = div().p(12).text_size(12).text_color(t.blocked ?? t.muted).child(this.error);
    } else if (this.prompts.length === 0) {
      body = div().p(12).text_size(12).text_color(t.dim).child(this.loading ? "" : "No prompts yet");
    } else {
      body = v_flex()
        .id("prompt-jump-list")
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .py(4)
        .children(
          this.prompts.map((p) => {
            const on = this.active === p.index;
            return h_flex()
              .id(`prompt-jump-${p.index}`)
              .items_start()
              .gap(8)
              .px(12)
              .py(5)
              .border_l(2)
              .border_color(on ? t.accent : t.chrome)
              .when(on, (el) => el.bg(t.selected))
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.jump(p.index, cx))
              .child(
                this.jumping === p.index
                  ? div()
                      .w(22)
                      .flex_none()
                      .text_size(11)
                      .text_color(t.accent)
                      .frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80)
                  : div()
                      .w(22)
                      .flex_none()
                      .text_size(11)
                      .text_color(on ? t.accent : t.dim)
                      .child(String(p.index + 1)),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .text_size(12)
                  .max_h(34)
                  .overflow_hidden()
                  .text_color(on ? t.foreground : p.compacted && this.kind === "claude" ? t.dim : t.muted)
                  .child(p.text.replace(/\s+/g, " ")),
              )
              .when(p.compacted && this.kind === "claude", (el) =>
                el.child(
                  div()
                    .flex_none()
                    .px(5)
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(10)
                    .text_color(t.dim)
                    .child("compacted"),
                ),
              );
          }),
        );
    }

    return v_flex().id("root").size_full().bg(t.chrome).child(header).child(body);
  }
}
