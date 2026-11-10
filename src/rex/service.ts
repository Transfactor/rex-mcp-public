import { setTimeout as sleep } from "node:timers/promises";
import { RexApiError, type RexControl } from "./control.js";
import { parseKey } from "./keys.js";
import { errText, type ServerPool, type ServerState } from "./pool.js";

export const SHELL_FLAVOR = "com.superlogical.terminal.shell";
const TERMINAL_CREATOR = "com.superlogical.terminal";
const STATE_RANK = ["idle", "done", "working", "error", "blocked"] as const;
export type ActivityState = (typeof STATE_RANK)[number];

interface ViewBlock {
  block_id: string | null;
  creator_name?: string;
  flavor?: string;
  label?: string;
}

interface LayoutNode {
  rect: [number, number, number, number];
  block_id?: string | null;
  split?: { before: LayoutNode; after: LayoutNode } | null;
}

interface ViewLayer {
  layer_id: string;
  kind: string;
  layout: LayoutNode | null;
  blocks: ViewBlock[] | null;
}

interface ViewWindow {
  window_id: string | null;
  label?: string;
  focused_block_id?: string | null;
  zoomed_block_id?: string | null;
  layers: ViewLayer[] | null;
}

export interface SessionView {
  session_id: string | null;
  label?: string;
  active_window_id?: string | null;
  windows: ViewWindow[] | null;
}

interface StatusRecord {
  id?: string;
  app?: string;
  effective_app?: string;
  state: string;
  kind?: string;
  msg?: string;
  title?: string;
  progress?: number | null;
  updated_at: string;
}

interface ProcInfo {
  name?: string;
  argv0?: string;
  script?: string;
  cwd?: string;
}

interface ProcessResult {
  foreground?: ProcInfo | null;
  child?: ProcInfo | null;
  last_exit?: { exit_code: number; error?: string } | null;
}

export interface PaneRef {
  server: string;
  session: string;
  tab?: string | number;
  pane?: string | number;
}

export interface PaneInfo {
  pane: number;
  id: string;
  block_id: string;
  label?: string;
  title?: string;
  process?: string;
  cwd?: string;
  state: ActivityState;
  waiting_for?: string;
  app?: string;
  message?: string;
  progress?: number;
  updated_at?: string;
  exited?: string;
  focused?: boolean;
  floating?: boolean;
  error?: string;
}

export interface TabInfo {
  tab: number;
  id: string;
  window_id: string;
  label?: string;
  active: boolean;
  state: ActivityState;
  panes: PaneInfo[];
}

export interface SessionInfo {
  id: string;
  session_id: string;
  label?: string;
  state: ActivityState;
  tabs: TabInfo[];
}

export interface ServerOverview {
  server: string;
  online: boolean;
  error?: string;
  counts?: Record<ActivityState, number>;
  sessions?: SessionInfo[];
}

export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(-6);
}

function rank(s: string): number {
  const i = STATE_RANK.indexOf(s as ActivityState);
  return i < 0 ? 0 : i;
}

function maxState(states: ActivityState[]): ActivityState {
  let best: ActivityState = "idle";
  for (const s of states) if (rank(s) > rank(best)) best = s;
  return best;
}

function matchById(id: string, ref: string): boolean {
  if (id === ref) return true;
  const bare = id.replace(/^[a-z_]+:/, "");
  if (bare === ref) return true;
  const compact = bare.replace(/-/g, "");
  return ref.length >= 4 && /^[0-9a-f]+$/i.test(ref) && compact.toLowerCase().endsWith(ref.toLowerCase());
}

function pick<T>(kind: string, ref: string, items: T[], id: (t: T) => string, label: (t: T) => string | undefined): T {
  const byId = items.filter((t) => matchById(id(t), ref));
  if (byId.length === 1) return byId[0]!;
  const byLabel = items.filter((t) => label(t)?.toLowerCase() === ref.toLowerCase());
  if (byLabel.length === 1) return byLabel[0]!;
  const hits = byId.length > 1 ? byId : byLabel;
  if (hits.length > 1) {
    throw new Error(`${kind} "${ref}" is ambiguous: ${hits.map((h) => `${label(h) ?? ""} (${shortId(id(h))})`).join(", ")}`);
  }
  const all = items.map((t) => `${label(t) ?? ""} (${shortId(id(t))})`).join(", ") || "none";
  throw new Error(`no ${kind} matches "${ref}". Available: ${all}`);
}

function asIndex(ref: string | number | undefined): number | undefined {
  if (typeof ref === "number") return ref;
  if (typeof ref === "string" && /^\d{1,3}$/.test(ref)) return Number(ref);
  return undefined;
}

export function tabWindows(view: SessionView): ViewWindow[] {
  return (view.windows ?? []).filter((w) => w.window_id);
}

export function windowBlocks(w: ViewWindow): { block: ViewBlock; floating: boolean }[] {
  const out: { block: ViewBlock; floating: boolean }[] = [];
  for (const layer of w.layers ?? []) {
    for (const b of layer.blocks ?? []) if (b.block_id) out.push({ block: b, floating: layer.kind !== "tiled" });
  }
  return out;
}

function leafRects(node: LayoutNode | null, out: { block_id: string; rect: LayoutNode["rect"] }[] = []) {
  if (!node) return out;
  if (node.block_id) out.push({ block_id: node.block_id, rect: node.rect });
  if (node.split) {
    leafRects(node.split.before, out);
    leafRects(node.split.after, out);
  }
  return out;
}

export function chooseSplit(w: ViewWindow): { anchor_id?: string; direction: "horizontal" | "vertical" } {
  const tiled = (w.layers ?? []).find((l) => l.kind === "tiled");
  const leaves = leafRects(tiled?.layout ?? null);
  if (leaves.length === 0) return { direction: "horizontal" };
  const largest = leaves.reduce((a, b) => (b.rect[2] * b.rect[3] > a.rect[2] * a.rect[3] ? b : a));
  // Terminal windows are about twice as wide as tall in pixels, so a fractional width of w counts as 2w.
  return { anchor_id: largest.block_id, direction: largest.rect[2] * 2 >= largest.rect[3] ? "horizontal" : "vertical" };
}

export function procLabel(p: ProcInfo): string | undefined {
  const raw = p.script || p.argv0 || p.name;
  if (!raw) return undefined;
  return raw.replace(/^-/, "").split("/").pop() || raw;
}

function stripBlankTail(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end);
}

export interface Resolved {
  conn: RexControl;
  sessionId: string;
  view: SessionView;
  window?: ViewWindow;
  windowIndex?: number;
  blockId?: string;
}

export interface CreateOptions {
  label?: string;
  cwd?: string;
  command?: string;
  focus?: boolean;
}

export interface InputOptions {
  text?: string;
  keys?: string[];
  submit?: boolean;
  mode?: "paste" | "type";
  delayMs?: number;
}

export class RexService {
  private readonly pool: ServerPool;

  constructor(pool: ServerPool) {
    this.pool = pool;
  }

  listServers(): Promise<ServerState[]> {
    return this.pool.states();
  }

  get discoveryError(): string | undefined {
    return this.pool.lastDiscoveryError;
  }

  async overview(opts: { server?: string; activityOnly?: boolean; session?: string } = {}): Promise<ServerOverview[]> {
    const names = opts.server ? [opts.server] : await this.pool.names();
    return Promise.all(names.map((n) => this.serverOverview(n, opts.activityOnly ?? false, opts.session)));
  }

  private async serverOverview(server: string, activityOnly: boolean, sessionRef?: string): Promise<ServerOverview> {
    let conn: RexControl;
    try {
      conn = await this.pool.get(server);
    } catch (e) {
      return { server, online: false, error: errText(e) };
    }
    try {
      const list = await conn.call<{ sessions: { session_id: string; label: string }[] | null }>("session.list");
      let sessions = list.sessions ?? [];
      if (sessionRef) sessions = [pick("session", sessionRef, sessions, (s) => s.session_id, (s) => s.label)];
      const infos = await Promise.all(sessions.map((s) => this.sessionInfo(conn, s.session_id)));
      const counts = Object.fromEntries(STATE_RANK.map((s) => [s, 0])) as Record<ActivityState, number>;
      for (const s of infos) for (const t of s.tabs) for (const p of t.panes) counts[p.state]++;
      let out = infos;
      if (activityOnly) {
        out = infos
          .map((s) => ({
            ...s,
            tabs: s.tabs.map((t) => ({ ...t, panes: t.panes.filter((p) => p.state !== "idle") })).filter((t) => t.panes.length > 0),
          }))
          .filter((s) => s.tabs.length > 0);
      }
      return { server, online: true, counts, sessions: out };
    } catch (e) {
      return { server, online: false, error: errText(e) };
    }
  }

  private async sessionInfo(conn: RexControl, sessionId: string): Promise<SessionInfo> {
    const view = await conn.call<SessionView>("session.view", { session_id: sessionId });
    const tabs = await Promise.all(
      tabWindows(view).map(async (w, i): Promise<TabInfo> => {
        const blocks = windowBlocks(w);
        const panes = await Promise.all(blocks.map((b, j) => this.paneInfo(conn, sessionId, w, b.block, j + 1, b.floating)));
        const wid = w.window_id ?? "";
        return {
          tab: i + 1,
          id: shortId(wid),
          window_id: wid,
          label: w.label,
          active: wid === view.active_window_id,
          state: maxState(panes.map((p) => p.state)),
          panes,
        };
      }),
    );
    return { id: shortId(sessionId), session_id: sessionId, label: view.label, state: maxState(tabs.map((t) => t.state)), tabs };
  }

  private async paneInfo(conn: RexControl, sessionId: string, w: ViewWindow, b: ViewBlock, index: number, floating: boolean): Promise<PaneInfo> {
    const blockId = b.block_id!;
    const info: PaneInfo = { pane: index, id: shortId(blockId), block_id: blockId, state: "idle" };
    if (b.label) info.label = b.label;
    if (blockId === w.focused_block_id) info.focused = true;
    if (floating) info.floating = true;
    if (b.creator_name && b.creator_name !== TERMINAL_CREATOR) {
      info.process = b.flavor ?? b.creator_name;
      return info;
    }
    const [status, title, proc] = await Promise.allSettled([
      conn.blockMethod<{ records: StatusRecord[] }>(sessionId, blockId, "program_status", {}, 8000),
      conn.blockMethod<{ title?: string }>(sessionId, blockId, "title", {}, 8000),
      conn.blockMethod<ProcessResult>(sessionId, blockId, "process", {}, 8000),
    ]);
    if (title.status === "fulfilled" && title.value.title) info.title = title.value.title;
    if (proc.status === "fulfilled") {
      const fg = proc.value.foreground ?? proc.value.child;
      if (fg) {
        const label = procLabel(fg);
        if (label) info.process = label;
        if (fg.cwd) info.cwd = fg.cwd;
      }
      const ex = proc.value.last_exit;
      if (ex) info.exited = ex.error ?? `exit code ${ex.exit_code}`;
    }
    if (status.status === "fulfilled") {
      let best: StatusRecord | undefined;
      for (const r of status.value.records ?? []) {
        if (!best || rank(r.state) > rank(best.state) || (rank(r.state) === rank(best.state) && r.updated_at > best.updated_at)) best = r;
      }
      if (best) {
        info.state = STATE_RANK[rank(best.state)]!;
        if (best.kind) info.waiting_for = best.kind;
        const app = best.effective_app ?? best.app;
        if (app) info.app = app;
        const msg = best.msg || best.title;
        if (msg) info.message = msg;
        if (typeof best.progress === "number") info.progress = best.progress;
        info.updated_at = best.updated_at;
      }
    }
    if (status.status === "rejected") info.error = errText(status.reason);
    return info;
  }

  async resolve(ref: { server: string; session: string; tab?: string | number; pane?: string | number }, level: "session" | "tab" | "pane"): Promise<Resolved> {
    const conn = await this.pool.get(ref.server);
    const list = await conn.call<{ sessions: { session_id: string; label: string }[] | null }>("session.list");
    const s = pick("session", ref.session, list.sessions ?? [], (x) => x.session_id, (x) => x.label);
    const view = await conn.call<SessionView>("session.view", { session_id: s.session_id });
    const out: Resolved = { conn, sessionId: s.session_id, view };
    if (level === "session") return out;

    const windows = tabWindows(view);
    let wi: number;
    const tIdx = asIndex(ref.tab);
    if (ref.tab === undefined || ref.tab === "") {
      wi = windows.findIndex((w) => w.window_id === view.active_window_id);
      if (wi < 0) wi = 0;
      if (windows.length === 0) throw new Error(`session "${view.label}" has no tabs`);
    } else if (tIdx !== undefined) {
      if (tIdx < 1 || tIdx > windows.length) throw new Error(`tab ${tIdx} does not exist: session "${view.label}" has ${windows.length} tabs`);
      wi = tIdx - 1;
    } else {
      const w = pick("tab", String(ref.tab), windows, (x) => x.window_id!, (x) => x.label);
      wi = windows.indexOf(w);
    }
    out.window = windows[wi]!;
    out.windowIndex = wi + 1;
    if (level === "tab") return out;

    const blocks = windowBlocks(out.window).map((b) => b.block);
    if (blocks.length === 0) throw new Error(`tab "${out.window.label}" has no panes`);
    const pIdx = asIndex(ref.pane);
    if (ref.pane === undefined || ref.pane === "") {
      out.blockId = out.window.zoomed_block_id ?? out.window.focused_block_id ?? blocks[0]!.block_id!;
    } else if (pIdx !== undefined) {
      if (pIdx < 1 || pIdx > blocks.length) throw new Error(`pane ${pIdx} does not exist: tab "${out.window.label}" has ${blocks.length} panes`);
      out.blockId = blocks[pIdx - 1]!.block_id!;
    } else {
      out.blockId = pick("pane", String(ref.pane), blocks, (x) => x.block_id!, (x) => x.label).block_id!;
    }
    return out;
  }

  async readPane(ref: PaneRef, lines = 80): Promise<{ text: string; lines: number; total_lines: number; target: Record<string, string> }> {
    const r = await this.resolve(ref, "pane");
    const content = await this.capture(r.conn, r.sessionId, r.blockId!);
    const all = stripBlankTail(content.replace(/\r/g, "").split("\n"));
    const n = Math.max(1, Math.min(lines, 5000));
    const tail = all.slice(-n);
    return { text: tail.join("\n"), lines: tail.length, total_lines: all.length, target: this.target(ref.server, r) };
  }

  private async capture(conn: RexControl, sessionId: string, blockId: string): Promise<string> {
    try {
      const f = await conn.blockMethod<{ content: string }>(sessionId, blockId, "format", { format: "text", trim: true });
      return f.content;
    } catch (e) {
      if (!(e instanceof RexApiError) || e.code !== "too_large") throw e;
    }
    const first = await conn.blockMethod<{ content: string; id?: number; total?: number }>(sessionId, blockId, "format", {
      format: "text",
      trim: true,
      max_bytes: 983040,
    });
    if (first.id === undefined || first.total === undefined) return first.content;
    const headBytes = Buffer.byteLength(first.content);
    const start = Math.max(headBytes, first.total - 512 * 1024);
    const contiguous = start === headBytes;
    let offset = contiguous ? start : start - 1;
    let out = "";
    for (let i = 0; i < 16; i++) {
      const part = await conn.blockMethod<{ data: string; eof?: boolean }>(sessionId, blockId, "blob_read", { id: first.id, offset, max_bytes: 983040 });
      out += part.data;
      offset += Buffer.byteLength(part.data);
      if (part.eof || part.data.length === 0) break;
    }
    if (contiguous) return first.content + out;
    const nl = out.indexOf("\n");
    return nl >= 0 ? out.slice(nl + 1) : out;
  }

  async sendInput(ref: PaneRef, opts: InputOptions): Promise<{ sent: string[]; target: Record<string, string> }> {
    const keys = [...(opts.keys ?? []), ...(opts.submit ? ["enter"] : [])];
    const parsed = keys.map(parseKey);
    if (!opts.text && parsed.length === 0) throw new Error("send_input needs text, keys, or submit");
    const r = await this.resolve(ref, "pane");
    const sent: string[] = [];
    const target = { session_id: r.sessionId, block_id: r.blockId! };
    if (opts.text) {
      if (opts.mode === "type") await r.conn.blockMethod(r.sessionId, r.blockId!, "write", { data: opts.text });
      else await r.conn.call("block.event", { ...target, event: { type: "paste", payload: { text: opts.text } } });
      sent.push(`${opts.mode === "type" ? "typed" : "pasted"} ${opts.text.length} characters`);
      if (parsed.length > 0) await sleep(opts.delayMs ?? 300);
    }
    for (let i = 0; i < parsed.length; i++) {
      const k = parsed[i]!;
      await r.conn.call("block.event", { ...target, event: { type: "key", payload: k } });
      await r.conn.call("block.event", { ...target, event: { type: "key", payload: { ...k, action: "release" } } });
      sent.push(keys[i]!);
    }
    return { sent, target: this.target(ref.server, r) };
  }

  private target(server: string, r: Resolved): Record<string, string> {
    const t: Record<string, string> = { server, session: r.view.label ?? "", session_id: r.sessionId };
    if (r.window) {
      t.tab = String(r.windowIndex);
      t.tab_label = r.window.label ?? "";
      t.window_id = r.window.window_id!;
    }
    if (r.blockId) {
      const blocks = r.window ? windowBlocks(r.window) : [];
      const i = blocks.findIndex((b) => b.block.block_id === r.blockId);
      if (i >= 0) t.pane = String(i + 1);
      t.block_id = r.blockId;
    }
    return t;
  }

  private static blockLayout(opts: CreateOptions) {
    const options: Record<string, unknown> = {};
    if (opts.cwd) options.cwd = opts.cwd;
    const block: Record<string, unknown> = { flavor: SHELL_FLAVOR, options };
    return { block };
  }

  private async paneCwd(conn: RexControl, sessionId: string, blockId: string | null | undefined): Promise<string | undefined> {
    if (!blockId) return undefined;
    try {
      const p = await conn.blockMethod<ProcessResult>(sessionId, blockId, "process", {}, 5000);
      return (p.foreground ?? p.child)?.cwd;
    } catch {
      return undefined;
    }
  }

  private async startCommand(conn: RexControl, sessionId: string, blockId: string | null | undefined, command?: string) {
    if (!command || !blockId) return;
    await sleep(400);
    await conn.blockMethod(sessionId, blockId, "write", { data: `${command}\r` });
  }

  async createSession(server: string, opts: CreateOptions & { tabLabel?: string }) {
    const conn = await this.pool.get(server);
    const win: Record<string, unknown> = { layout: RexService.blockLayout(opts) };
    if (opts.tabLabel) win.window_label = opts.tabLabel;
    const payload: Record<string, unknown> = { initial_windows: [win] };
    if (opts.label) payload.label = opts.label;
    const res = await conn.call<{ session_id: string; initial_windows?: { window_id: string; block_ids: string[] }[] }>("session.create", payload);
    const w = res.initial_windows?.[0];
    await this.startCommand(conn, res.session_id, w?.block_ids[0], opts.command);
    return { server, session_id: res.session_id, session: shortId(res.session_id), window_id: w?.window_id, block_id: w?.block_ids[0], started: opts.command ?? null };
  }

  async createTab(ref: { server: string; session: string }, opts: CreateOptions) {
    const r = await this.resolve(ref, "session");
    const payload: Record<string, unknown> = { session_id: r.sessionId, layout: RexService.blockLayout(opts), focus: opts.focus ?? false };
    if (opts.label) payload.window_label = opts.label;
    const res = await r.conn.call<{ window_id: string; block_ids: string[] }>("session.new_window", payload);
    await this.startCommand(r.conn, r.sessionId, res.block_ids[0], opts.command);
    const after = await r.conn.call<SessionView>("session.view", { session_id: r.sessionId });
    const idx = tabWindows(after).findIndex((w) => w.window_id === res.window_id);
    const tab = idx >= 0 ? idx + 1 : undefined;
    return { server: ref.server, session_id: r.sessionId, window_id: res.window_id, tab, block_id: res.block_ids[0], started: opts.command ?? null };
  }

  async createPane(ref: { server: string; session: string; tab?: string | number }, opts: CreateOptions) {
    const r = await this.resolve(ref, "tab");
    const split = chooseSplit(r.window!);
    if (!opts.cwd) opts = { ...opts, cwd: await this.paneCwd(r.conn, r.sessionId, r.window!.focused_block_id ?? split.anchor_id) };
    const layout = RexService.blockLayout(opts);
    if (opts.label) (layout.block as Record<string, unknown>).label = opts.label;
    const payload: Record<string, unknown> = { session_id: r.sessionId, direction: split.direction, side: "after", layout, focus: opts.focus ?? false };
    if (split.anchor_id) payload.anchor_id = split.anchor_id;
    else payload.window_id = r.window!.window_id;
    const res = await r.conn.call<{ block_ids: string[] }>("session.new_split", payload);
    await this.startCommand(r.conn, r.sessionId, res.block_ids[0], opts.command);
    return { server: ref.server, session_id: r.sessionId, window_id: r.window!.window_id, block_id: res.block_ids[0], split: split.direction, started: opts.command ?? null };
  }

  async closeSession(ref: { server: string; session: string }) {
    const r = await this.resolve(ref, "session");
    await r.conn.call("session.destroy", { session_id: r.sessionId });
    return { closed: "session", server: ref.server, session: r.view.label, session_id: r.sessionId };
  }

  async closeTab(ref: { server: string; session: string; tab: string | number }) {
    const r = await this.resolve(ref, "tab");
    await r.conn.call("session.close_window", { session_id: r.sessionId, window_id: r.window!.window_id });
    return { closed: "tab", ...this.target(ref.server, r) };
  }

  async closePane(ref: { server: string; session: string; tab?: string | number; pane: string | number }) {
    const r = await this.resolve(ref, "pane");
    const t = this.target(ref.server, r);
    await r.conn.call("block.close", { session_id: r.sessionId, block_id: r.blockId });
    return { closed: "pane", ...t };
  }

  async rename(ref: { server: string; session: string; tab?: string | number; pane?: string | number }, target: "session" | "tab" | "pane", label: string) {
    const r = await this.resolve(ref, target);
    if (target === "session") await r.conn.call("session.set_label", { session_id: r.sessionId, label });
    else if (target === "tab") await r.conn.call("session.set_window_label", { session_id: r.sessionId, window_id: r.window!.window_id, label });
    else await r.conn.call("session.set_block_label", { session_id: r.sessionId, block_id: r.blockId, label });
    return { renamed: target, label, ...this.target(ref.server, r) };
  }
}
