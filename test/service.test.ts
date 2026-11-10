import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RexApiError } from "../src/rex/control.js";
import { ServerPool } from "../src/rex/pool.js";
import { RexService, procLabel, shortId } from "../src/rex/service.js";
import { FakeRex } from "./fakeRex.js";

let fake: FakeRex;
let pool: ServerPool;
let svc: RexService;

beforeAll(async () => {
  fake = await FakeRex.start();
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
  pool = new ServerPool({ servers: [{ name: "fake", endpoint: fake.endpoint }] });
  svc = new RexService(pool);
});

afterEach(() => {
  pool.close();
});

function seedTwoSessions() {
  const alpha = fake.addSession({
    id: "11111111-1111-4111-8111-aaaaaabbbbbb",
    label: "alpha",
    windows: [
      {
        label: "main",
        id: "22222222-2222-4222-8222-000000c0ffee",
        blocks: [
          { label: "agent", argv0: "/usr/local/bin/claude", cwd: "/work/a", title: "claude code", records: [{ state: "blocked", app: "claude", kind: "permission", msg: "Allow?", updated_at: "2026-01-01T00:00:01Z" }] },
          { label: "build", argv0: "-zsh", records: [{ state: "working", app: "make", msg: "building", progress: 0.5, updated_at: "2026-01-01T00:00:02Z" }] },
          { label: "idle", argv0: "-zsh" },
        ],
        focused: 1,
      },
      { label: "second", blocks: [{ label: "errpane", records: [{ state: "error", app: "tests", updated_at: "2026-01-01T00:00:03Z" }] }] },
    ],
  });
  const beta = fake.addSession({
    label: "beta",
    windows: [{ label: "only", blocks: [{ label: "fin", records: [{ state: "done", app: "codex", updated_at: "2026-01-01T00:00:04Z" }] }] }],
  });
  return { alpha, beta };
}

describe("shortId and procLabel", () => {
  it("takes the last six hex characters without dashes", () => {
    expect(shortId("11111111-1111-4111-8111-aaaaaabbbbbb")).toBe("bbbbbb");
    expect(shortId("abc")).toBe("abc");
  });

  it("derives the process label", () => {
    expect(procLabel({ argv0: "/usr/local/bin/claude" })).toBe("claude");
    expect(procLabel({ argv0: "-zsh" })).toBe("zsh");
    expect(procLabel({ name: "node", argv0: "" })).toBe("node");
    expect(procLabel({ script: "/x/y/run.sh", argv0: "bash" })).toBe("run.sh");
    expect(procLabel({})).toBeUndefined();
  });
});

describe("overview", () => {
  it("builds the tree with counts, ranking and process labels", async () => {
    seedTwoSessions();
    const [ov] = await svc.overview();
    expect(ov!.online).toBe(true);
    expect(ov!.counts).toEqual({ idle: 1, done: 1, working: 1, error: 1, blocked: 1 });
    const alpha = ov!.sessions!.find((s) => s.label === "alpha")!;
    const beta = ov!.sessions!.find((s) => s.label === "beta")!;
    expect(alpha.state).toBe("blocked");
    expect(alpha.id).toBe("bbbbbb");
    expect(beta.state).toBe("done");
    expect(alpha.tabs.map((t) => [t.tab, t.label, t.state, t.active])).toEqual([
      [1, "main", "blocked", true],
      [2, "second", "error", false],
    ]);
    const panes = alpha.tabs[0]!.panes;
    expect(panes.map((p) => [p.pane, p.label, p.state])).toEqual([
      [1, "agent", "blocked"],
      [2, "build", "working"],
      [3, "idle", "idle"],
    ]);
    expect(panes[0]).toMatchObject({ process: "claude", cwd: "/work/a", title: "claude code", waiting_for: "permission", app: "claude", message: "Allow?" });
    expect(panes[1]).toMatchObject({ process: "zsh", progress: 0.5, focused: true });
    expect(alpha.tabs[0]!.id).toBe("c0ffee");
  });

  it("ranks blocked above error above working above done above idle within a pane", async () => {
    fake.addSession({
      label: "mix",
      windows: [
        {
          blocks: [
            {
              records: [
                { state: "done", updated_at: "2026-01-01T00:00:09Z" },
                { state: "working", updated_at: "2026-01-01T00:00:08Z" },
                { state: "error", updated_at: "2026-01-01T00:00:07Z" },
                { state: "idle", updated_at: "2026-01-01T00:00:10Z" },
              ],
            },
            { records: [{ state: "working", msg: "old", updated_at: "2026-01-01T00:00:01Z" }, { state: "working", msg: "new", updated_at: "2026-01-01T00:00:05Z" }] },
          ],
        },
      ],
    });
    const [ov] = await svc.overview();
    const panes = ov!.sessions![0]!.tabs[0]!.panes;
    expect(panes[0]!.state).toBe("error");
    expect(panes[1]).toMatchObject({ state: "working", message: "new" });
    expect(ov!.sessions![0]!.state).toBe("error");
  });

  it("filters to active panes with activity_only", async () => {
    seedTwoSessions();
    fake.addSession({ label: "quiet", windows: [{ blocks: [{}] }] });
    const [ov] = await svc.overview({ activityOnly: true });
    expect(ov!.counts!.idle).toBe(2);
    expect(ov!.sessions!.map((s) => s.label).sort()).toEqual(["alpha", "beta"]);
    const alpha = ov!.sessions!.find((s) => s.label === "alpha")!;
    expect(alpha.tabs[0]!.panes.map((p) => p.label)).toEqual(["agent", "build"]);
  });

  it("limits to one server and one session", async () => {
    seedTwoSessions();
    const [ov] = await svc.overview({ server: "fake", session: "beta" });
    expect(ov!.sessions!.map((s) => s.label)).toEqual(["beta"]);
  });

  it("reports an unknown server as offline", async () => {
    const [ov] = await svc.overview({ server: "nope" });
    expect(ov!.online).toBe(false);
    expect(ov!.error).toMatch(/unknown server "nope"/);
    expect(ov!.error).toMatch(/fake/);
  });

  it("marks non-terminal blocks without querying them", async () => {
    fake.addSession({ label: "web", windows: [{ blocks: [{ creator_name: "com.example.browser", flavor: "web.view" }] }] });
    const [ov] = await svc.overview();
    const pane = ov!.sessions![0]!.tabs[0]!.panes[0]!;
    expect(pane.process).toBe("web.view");
    expect(fake.blockCalls("program_status")).toHaveLength(0);
  });

  it("records an error on a pane whose status call fails", async () => {
    fake.addSession({ label: "bad", windows: [{ blocks: [{}] }] });
    fake.injectError("block.method:program_status", { code: "internal", message: "boom" });
    const [ov] = await svc.overview();
    expect(ov!.sessions![0]!.tabs[0]!.panes[0]!.error).toMatch(/boom|internal/);
  });

  it("shows the exit of a finished process", async () => {
    fake.addSession({ label: "ex", windows: [{ blocks: [{ lastExit: { exit_code: 3 } }] }] });
    const [ov] = await svc.overview();
    expect(ov!.sessions![0]!.tabs[0]!.panes[0]!.exited).toBe("exit code 3");
  });
});

describe("resolve", () => {
  beforeEach(() => {
    seedTwoSessions();
  });

  it("defaults to the active tab and the focused pane", async () => {
    const r = await svc.resolve({ server: "fake", session: "alpha" }, "pane");
    expect(r.windowIndex).toBe(1);
    expect(r.blockId).toBe(fake.session("alpha").windows[0]!.blocks[1]!.block_id);
  });

  it("defaults to the first tab when the active window is missing", async () => {
    fake.session("alpha").active_window_id = "gone";
    const r = await svc.resolve({ server: "fake", session: "alpha" }, "tab");
    expect(r.windowIndex).toBe(1);
  });

  it("uses the active tab when it is not the first", async () => {
    const s = fake.session("alpha");
    s.active_window_id = s.windows[1]!.window_id;
    const r = await svc.resolve({ server: "fake", session: "alpha" }, "pane");
    expect(r.windowIndex).toBe(2);
    expect(r.blockId).toBe(s.windows[1]!.blocks[0]!.block_id);
  });

  it("resolves tab and pane by 1-based index, number or string", async () => {
    const s = fake.session("alpha");
    const r = await svc.resolve({ server: "fake", session: "alpha", tab: 2, pane: 1 }, "pane");
    expect(r.blockId).toBe(s.windows[1]!.blocks[0]!.block_id);
    const r2 = await svc.resolve({ server: "fake", session: "alpha", tab: "1", pane: "3" }, "pane");
    expect(r2.blockId).toBe(s.windows[0]!.blocks[2]!.block_id);
  });

  it("resolves by label, ignoring case", async () => {
    const s = fake.session("alpha");
    const r = await svc.resolve({ server: "fake", session: "ALPHA", tab: "Second", pane: "errpane" }, "pane");
    expect(r.blockId).toBe(s.windows[1]!.blocks[0]!.block_id);
  });

  it("resolves by short id and full id", async () => {
    const s = fake.session("alpha");
    const bySuffix = await svc.resolve({ server: "fake", session: "bbbbbb", tab: "c0ffee" }, "tab");
    expect(bySuffix.sessionId).toBe(s.session_id);
    expect(bySuffix.windowIndex).toBe(1);
    const byFull = await svc.resolve({ server: "fake", session: s.session_id }, "session");
    expect(byFull.sessionId).toBe(s.session_id);
    const pane = s.windows[0]!.blocks[2]!;
    const byPaneId = await svc.resolve({ server: "fake", session: "alpha", tab: 1, pane: shortId(pane.block_id) }, "pane");
    expect(byPaneId.blockId).toBe(pane.block_id);
  });

  it("fails on an ambiguous label", async () => {
    fake.addSession({ label: "dup", windows: [{ blocks: [{}] }] });
    fake.addSession({ label: "dup", windows: [{ blocks: [{}] }] });
    await expect(svc.resolve({ server: "fake", session: "dup" }, "session")).rejects.toThrow(/session "dup" is ambiguous/);
  });

  it("fails on an ambiguous pane label", async () => {
    fake.addSession({ label: "p", windows: [{ blocks: [{ label: "x" }, { label: "x" }] }] });
    await expect(svc.resolve({ server: "fake", session: "p", pane: "x" }, "pane")).rejects.toThrow(/pane "x" is ambiguous/);
  });

  it("fails with the available choices when nothing matches", async () => {
    await expect(svc.resolve({ server: "fake", session: "zzz" }, "session")).rejects.toThrow(/no session matches "zzz"\. Available: alpha \(bbbbbb\)/);
  });

  it("fails on an out-of-range index", async () => {
    await expect(svc.resolve({ server: "fake", session: "alpha", tab: 9 }, "tab")).rejects.toThrow(/tab 9 does not exist/);
    await expect(svc.resolve({ server: "fake", session: "alpha", tab: 1, pane: 0 }, "pane")).rejects.toThrow(/pane 0 does not exist/);
  });

  it("fails when a session has no tabs", async () => {
    fake.addSession({ label: "empty", windows: [] });
    await expect(svc.resolve({ server: "fake", session: "empty" }, "tab")).rejects.toThrow(/has no tabs/);
  });
});

describe("readPane", () => {
  it("returns the last N lines and drops the blank tail", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    fake.addSession({ label: "r", windows: [{ blocks: [{ screen: `${lines.join("\n")}\n\n  \n` }] }] });
    const r = await svc.readPane({ server: "fake", session: "r" }, 3);
    expect(r.text).toBe("line8\nline9\nline10");
    expect(r.lines).toBe(3);
    expect(r.total_lines).toBe(10);
    expect(r.target).toMatchObject({ server: "fake", session: "r", tab: "1", pane: "1" });
  });

  it("strips carriage returns", async () => {
    fake.addSession({ label: "r", windows: [{ blocks: [{ screen: "a\r\nb\r\n" }] }] });
    const r = await svc.readPane({ server: "fake", session: "r" });
    expect(r.text).toBe("a\nb");
  });

  it("reads the tail through blob_read after too_large", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `row${i}`);
    const screen = `${lines.join("\n")}\n`;
    fake.addSession({ label: "big", windows: [{ blocks: [{ screen, tooLargeAbove: 5, headBytes: Buffer.byteLength("row0\n") }] }] });
    const r = await svc.readPane({ server: "fake", session: "big" }, 100);
    const formats = fake.blockCalls("format");
    expect(formats).toHaveLength(2);
    expect(formats[0]!.payload.args).toEqual({ format: "text", trim: true });
    expect(formats[1]!.payload.args).toMatchObject({ format: "text", trim: true, max_bytes: 983040 });
    const reads = fake.blockCalls("blob_read");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.payload.args).toMatchObject({ id: expect.any(Number), offset: 5, max_bytes: 983040 });
    expect(r.text).toBe("row0\nrow1\nrow2\nrow3\nrow4\nrow5");
  });

  it("starts one byte early and drops the partial first line when the tail is not contiguous", async () => {
    const count = 70000;
    const screen = Array.from({ length: count }, (_, i) => `r${String(i).padStart(7, "0")}`).join("\n") + "\n";
    fake.addSession({ label: "huge", windows: [{ blocks: [{ screen, tooLargeAbove: 5, headBytes: 10 }] }] });
    const r = await svc.readPane({ server: "fake", session: "huge" }, 3);
    const total = Buffer.byteLength(screen);
    expect(fake.blockCalls("blob_read")[0]!.payload.args.offset).toBe(total - 512 * 1024 - 1);
    expect(r.text).toBe(`r${String(count - 3).padStart(7, "0")}\nr${String(count - 2).padStart(7, "0")}\nr${String(count - 1).padStart(7, "0")}`);
    expect(r.total_lines).toBeLessThan(count);
    expect(r.total_lines).toBeGreaterThan(50000);
  });

  it("rethrows other format errors", async () => {
    fake.addSession({ label: "r", windows: [{ blocks: [{ screen: "x" }] }] });
    fake.injectError("block.method:format", { code: "denied", status: 403 });
    const err: unknown = await svc.readPane({ server: "fake", session: "r" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RexApiError);
    expect((err as RexApiError).code).toBe("denied");
  });
});

describe("sendInput", () => {
  it("pastes the text and then presses and releases the keys in order", async () => {
    const s = fake.addSession({ label: "in", windows: [{ blocks: [{}] }] });
    const block = s.windows[0]!.blocks[0]!;
    const res = await svc.sendInput({ server: "fake", session: "in" }, { text: "hello", keys: ["esc", "ctrl+c"], submit: true, delayMs: 5 });
    expect(res.sent).toEqual(["pasted 5 characters", "esc", "ctrl+c", "enter"]);
    const events = fake.calls("block.event").map((c) => c.payload.event);
    expect(events.map((e) => [e.type, e.payload.action ?? e.payload.text, e.payload.key])).toEqual([
      ["paste", "hello", undefined],
      ["key", "press", "escape"],
      ["key", "release", "escape"],
      ["key", "press", "key_c"],
      ["key", "release", "key_c"],
      ["key", "press", "enter"],
      ["key", "release", "enter"],
    ]);
    expect(events[3].payload.mods).toBe("ctrl");
    expect(fake.calls("block.event")[0]!.payload).toMatchObject({ session_id: s.session_id, block_id: block.block_id });
    expect(block.input).toHaveLength(7);
  });

  it("waits for the delay between the paste and the first key", async () => {
    fake.addSession({ label: "in", windows: [{ blocks: [{}] }] });
    const t0 = Date.now();
    await svc.sendInput({ server: "fake", session: "in" }, { text: "x", submit: true, delayMs: 150 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it("types raw text through the write method in type mode", async () => {
    const s = fake.addSession({ label: "in", windows: [{ blocks: [{}] }] });
    const res = await svc.sendInput({ server: "fake", session: "in" }, { text: "ls\r", mode: "type" });
    expect(res.sent).toEqual(["typed 3 characters"]);
    expect(s.windows[0]!.blocks[0]!.writes).toEqual(["ls\r"]);
    expect(fake.calls("block.event")).toHaveLength(0);
  });

  it("sends keys without text", async () => {
    fake.addSession({ label: "in", windows: [{ blocks: [{}] }] });
    const res = await svc.sendInput({ server: "fake", session: "in" }, { keys: ["y"] });
    expect(res.sent).toEqual(["y"]);
    expect(fake.calls("block.event").map((c) => c.payload.event.payload.text)).toEqual(["y", "y"]);
  });

  it("rejects empty input before any request", async () => {
    fake.addSession({ label: "in", windows: [{ blocks: [{}] }] });
    await expect(svc.sendInput({ server: "fake", session: "in" }, {})).rejects.toThrow(/needs text, keys, or submit/);
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects a bad key before any request", async () => {
    fake.addSession({ label: "in", windows: [{ blocks: [{}] }] });
    await expect(svc.sendInput({ server: "fake", session: "in" }, { text: "a", keys: ["banana"] })).rejects.toThrow(/unknown key/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("pool open", () => {
  it("closes the socket and reports an error when attach_all fails", async () => {
    fake.injectError("session.attach_all", { code: "denied", status: 403 }, 1);
    const before = fake.connectionCount;
    const out = await svc.listServers();
    expect(out[0]).toMatchObject({ online: false });
    expect(out[0]!.error).toMatch(/session.attach_all.*denied/);
    expect(fake.connectionCount).toBe(before + 1);
    const again = await svc.listServers();
    expect(again[0]!.online).toBe(true);
  });
});

describe("create", () => {
  it("createSession sends the payload and types the command", async () => {
    const res = await svc.createSession("fake", { label: "proj", cwd: "/srv/proj", command: "claude", tabLabel: "first" });
    const call = fake.calls("session.create")[0]!;
    expect(call.payload).toEqual({
      label: "proj",
      initial_windows: [{ window_label: "first", layout: { block: { flavor: "com.superlogical.terminal.shell", options: { cwd: "/srv/proj" } } } }],
    });
    const s = fake.session("proj");
    expect(res).toMatchObject({ server: "fake", session_id: s.session_id, session: shortId(s.session_id), started: "claude" });
    expect(s.windows[0]!.blocks[0]!.writes).toEqual(["claude\r"]);
    expect(s.windows[0]!.blocks[0]!.cwd).toBe("/srv/proj");
    expect(res.block_id).toBe(s.windows[0]!.blocks[0]!.block_id);
  });

  it("createSession without options sends empty block options and no write", async () => {
    const res = await svc.createSession("fake", {});
    expect(fake.calls("session.create")[0]!.payload).toEqual({ initial_windows: [{ layout: { block: { flavor: "com.superlogical.terminal.shell", options: {} } } }] });
    expect(res.started).toBeNull();
    expect(fake.blockCalls("write")).toHaveLength(0);
  });

  it("createTab sends new_window and reports the tab number", async () => {
    const s = fake.addSession({ label: "t", windows: [{ blocks: [{}] }] });
    const res = await svc.createTab({ server: "fake", session: "t" }, { label: "logs", cwd: "/var/log", command: "tail -f x" });
    expect(fake.calls("session.new_window")[0]!.payload).toEqual({
      session_id: s.session_id,
      layout: { block: { flavor: "com.superlogical.terminal.shell", options: { cwd: "/var/log" } } },
      focus: false,
      window_label: "logs",
    });
    expect(res.tab).toBe(2);
    expect(s.windows).toHaveLength(2);
    expect(s.windows[1]!.blocks[0]!.writes).toEqual(["tail -f x\r"]);
  });

  it("createTab passes focus", async () => {
    fake.addSession({ label: "t", windows: [{ blocks: [{}] }] });
    await svc.createTab({ server: "fake", session: "t" }, { focus: true });
    expect(fake.calls("session.new_window")[0]!.payload.focus).toBe(true);
  });

  it("createPane inherits the cwd of the focused pane", async () => {
    const s = fake.addSession({ label: "p", windows: [{ blocks: [{ cwd: "/a" }, { cwd: "/b" }], focused: 1 }] });
    const res = await svc.createPane({ server: "fake", session: "p" }, { label: "extra", command: "htop" });
    const call = fake.calls("session.new_split")[0]!;
    expect(call.payload).toMatchObject({
      session_id: s.session_id,
      side: "after",
      focus: false,
      layout: { block: { flavor: "com.superlogical.terminal.shell", options: { cwd: "/b" }, label: "extra" } },
    });
    expect(call.payload.anchor_id).toEqual(expect.any(String));
    expect(call.payload.direction).toMatch(/^(horizontal|vertical)$/);
    expect(s.windows[0]!.blocks).toHaveLength(3);
    expect(s.windows[0]!.blocks[2]!.cwd).toBe("/b");
    expect(s.windows[0]!.blocks[2]!.writes).toEqual(["htop\r"]);
    expect(res.block_id).toBe(s.windows[0]!.blocks[2]!.block_id);
  });

  it("createPane uses an explicit cwd and skips the process lookup", async () => {
    fake.addSession({ label: "p", windows: [{ blocks: [{ cwd: "/a" }] }] });
    await svc.createPane({ server: "fake", session: "p" }, { cwd: "/explicit" });
    expect(fake.calls("session.new_split")[0]!.payload.layout.block.options).toEqual({ cwd: "/explicit" });
    expect(fake.blockCalls("process")).toHaveLength(0);
  });

  it("createPane survives a failing cwd lookup", async () => {
    fake.addSession({ label: "p", windows: [{ blocks: [{ cwd: "/a" }] }] });
    fake.injectError("block.method:process", { code: "internal" });
    await svc.createPane({ server: "fake", session: "p" }, {});
    expect(fake.calls("session.new_split")[0]!.payload.layout.block.options).toEqual({});
  });
});

describe("close and rename", () => {
  let s: ReturnType<FakeRex["addSession"]>;

  beforeEach(() => {
    s = fake.addSession({ label: "c", windows: [{ label: "w1", blocks: [{ label: "b1" }, { label: "b2" }] }, { label: "w2", blocks: [{ label: "b3" }] }] });
  });

  it("closeSession calls session.destroy", async () => {
    const res = await svc.closeSession({ server: "fake", session: "c" });
    expect(fake.calls("session.destroy")[0]!.payload).toEqual({ session_id: s.session_id });
    expect(res).toMatchObject({ closed: "session", session: "c", session_id: s.session_id });
    expect(fake.sessions).toHaveLength(0);
  });

  it("closeTab calls session.close_window", async () => {
    const wid = s.windows[1]!.window_id;
    const res = await svc.closeTab({ server: "fake", session: "c", tab: "w2" });
    expect(fake.calls("session.close_window")[0]!.payload).toEqual({ session_id: s.session_id, window_id: wid });
    expect(res).toMatchObject({ closed: "tab", tab: "2", tab_label: "w2" });
    expect(s.windows.map((w) => w.label)).toEqual(["w1"]);
  });

  it("closePane calls block.close", async () => {
    const blockId = s.windows[0]!.blocks[1]!.block_id;
    const res = await svc.closePane({ server: "fake", session: "c", tab: 1, pane: 2 });
    expect(fake.calls("block.close")[0]!.payload).toEqual({ session_id: s.session_id, block_id: blockId });
    expect(res).toMatchObject({ closed: "pane", pane: "2", block_id: blockId });
    expect(s.windows[0]!.blocks.map((b) => b.label)).toEqual(["b1"]);
  });

  it("renames a session", async () => {
    const res = await svc.rename({ server: "fake", session: "c" }, "session", "renamed");
    expect(fake.calls("session.set_label")[0]!.payload).toEqual({ session_id: s.session_id, label: "renamed" });
    expect(res).toMatchObject({ renamed: "session", label: "renamed" });
    expect(s.label).toBe("renamed");
  });

  it("renames a tab", async () => {
    const wid = s.windows[1]!.window_id;
    await svc.rename({ server: "fake", session: "c", tab: 2 }, "tab", "tabby");
    expect(fake.calls("session.set_window_label")[0]!.payload).toEqual({ session_id: s.session_id, window_id: wid, label: "tabby" });
    expect(s.windows[1]!.label).toBe("tabby");
  });

  it("renames a pane", async () => {
    const bid = s.windows[0]!.blocks[0]!.block_id;
    await svc.rename({ server: "fake", session: "c", tab: 1, pane: 1 }, "pane", "paney");
    expect(fake.calls("session.set_block_label")[0]!.payload).toEqual({ session_id: s.session_id, block_id: bid, label: "paney" });
    expect(s.windows[0]!.blocks[0]!.label).toBe("paney");
  });
});

describe("connections", () => {
  it("fails with a clear error for an unknown server", async () => {
    await expect(svc.readPane({ server: "nope", session: "x" })).rejects.toThrow(/unknown server "nope". Known servers: fake/);
  });

  it("reports a refused connection", async () => {
    const p = new ServerPool({ servers: [{ name: "dead", endpoint: "http://127.0.0.1:1" }], connectTimeoutMs: 2000 });
    const out = await new RexService(p).listServers();
    expect(out[0]).toMatchObject({ name: "dead", online: false });
    expect(out[0]!.error).toBeTruthy();
    p.close();
  });

  it("sends hello with the agent client info and attaches", async () => {
    await svc.overview();
    const hello = fake.hellos.at(-1);
    expect(hello).toMatchObject({ type: "hello", api_revision: 11, client: { kind: "agent", name: "rex-mcp" } });
    expect(fake.calls("session.attach_all")[0]!.payload).toEqual({ event_scope: "session" });
  });

  it("lists server state", async () => {
    fake.addSession({ label: "a", windows: [] });
    const [st] = await svc.listServers();
    expect(st).toMatchObject({ name: "fake", online: true, version: "9.9.9-fake", apiRevision: 11, sessions: 1, source: "config" });
  });

  it("reconnects on the next call after the connection drops", async () => {
    fake.addSession({ label: "a", windows: [{ blocks: [{ screen: "hi\n" }] }] });
    await svc.readPane({ server: "fake", session: "a" });
    const before = fake.connectionCount;
    fake.dropConnections();
    await new Promise((r) => setTimeout(r, 100));
    const r = await svc.readPane({ server: "fake", session: "a" });
    expect(r.text).toBe("hi");
    expect(fake.connectionCount).toBe(before + 1);
  });

  it("rejects the in-flight call when the connection drops", async () => {
    fake.addSession({ label: "a", windows: [{ blocks: [{}] }] });
    const conn = await pool.get("fake");
    const closed = new Promise((r) => conn.once("close", r));
    fake.dropConnections();
    await closed;
    await expect(conn.call("session.list")).rejects.toThrow(/connection closed/);
  });

  it("surfaces API errors as RexApiError with the code", async () => {
    const conn = await pool.get("fake");
    const err: unknown = await conn.call("session.view", { session_id: "nope" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RexApiError);
    expect((err as RexApiError).code).toBe("not_found");
    expect((err as Error).message).toMatch(/^session\.view:/);
  });
});
