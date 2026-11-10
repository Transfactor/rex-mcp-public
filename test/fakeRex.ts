import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

export interface SeedBlock {
  id?: string;
  label?: string;
  creator_name?: string;
  flavor?: string;
  screen?: string;
  title?: string;
  cwd?: string;
  argv0?: string;
  name?: string;
  script?: string;
  records?: Record<string, unknown>[];
  lastExit?: { exit_code: number; error?: string } | null;
  headBytes?: number;
  tooLargeAbove?: number;
}

export interface SeedWindow {
  id?: string;
  label?: string;
  focused?: number;
  blocks: SeedBlock[];
}

export interface SeedSession {
  id?: string;
  label: string;
  active?: number;
  windows: SeedWindow[];
}

export interface FakeBlock {
  block_id: string;
  label?: string;
  creator_name: string;
  flavor: string;
  screen: string;
  title: string;
  cwd: string;
  argv0: string;
  name: string;
  script?: string;
  records: Record<string, unknown>[];
  lastExit: { exit_code: number; error?: string } | null;
  writes: string[];
  input: unknown[];
  headBytes: number;
  tooLargeAbove?: number;
}

export interface FakeWindow {
  window_id: string;
  label?: string;
  focused_block_id: string | null;
  blocks: FakeBlock[];
}

export interface FakeSession {
  session_id: string;
  label: string;
  active_window_id: string | null;
  windows: FakeWindow[];
}

export interface RecordedRequest {
  method: string;
  payload: any;
  blockMethod?: string;
}

export interface InjectedError {
  code: string;
  message?: string;
  status?: number;
}

interface ErrorRule {
  key: string;
  error: InjectedError;
  remaining: number;
}

export class FakeRex {
  sessions: FakeSession[] = [];
  requests: RecordedRequest[] = [];
  hellos: any[] = [];
  endpoint = "";
  connectionCount = 0;
  private wss!: WebSocketServer;
  private sockets = new Set<WebSocket>();
  private rules: ErrorRule[] = [];
  private blobs = new Map<number, string>();
  private nextBlob = 1;

  static async start(): Promise<FakeRex> {
    const fake = new FakeRex();
    fake.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/api/control",
      handleProtocols: (protocols) => (protocols.has("rex.control.v1") ? "rex.control.v1" : false),
    });
    await new Promise<void>((resolve) => fake.wss.once("listening", () => resolve()));
    const addr = fake.wss.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected address");
    fake.endpoint = `http://127.0.0.1:${addr.port}`;
    fake.wss.on("connection", (ws) => fake.onConnection(ws));
    return fake;
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  dropConnections(): void {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }

  reset(): void {
    this.sessions = [];
    this.requests = [];
    this.rules = [];
    this.blobs.clear();
  }

  clearRequests(): void {
    this.requests = [];
  }

  calls(method: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method);
  }

  blockCalls(blockMethod: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "block.method" && r.blockMethod === blockMethod);
  }

  injectError(key: string, error: InjectedError, times = 1): void {
    this.rules.push({ key, error, remaining: times });
  }

  addSession(seed: SeedSession): FakeSession {
    const windows = seed.windows.map((w) => this.makeWindow(w));
    const s: FakeSession = {
      session_id: seed.id ?? randomUUID(),
      label: seed.label,
      active_window_id: windows[seed.active ?? 0]?.window_id ?? null,
      windows,
    };
    this.sessions.push(s);
    return s;
  }

  session(label: string): FakeSession {
    const s = this.sessions.find((x) => x.label === label);
    if (!s) throw new Error(`no fake session ${label}`);
    return s;
  }

  block(blockId: string): FakeBlock {
    for (const s of this.sessions) for (const w of s.windows) for (const b of w.blocks) if (b.block_id === blockId) return b;
    throw new Error(`no fake block ${blockId}`);
  }

  private makeBlock(seed: SeedBlock): FakeBlock {
    return {
      block_id: seed.id ?? randomUUID(),
      label: seed.label,
      creator_name: seed.creator_name ?? "com.superlogical.terminal",
      flavor: seed.flavor ?? "com.superlogical.terminal.shell",
      screen: seed.screen ?? "",
      title: seed.title ?? "",
      cwd: seed.cwd ?? "/home/test",
      argv0: seed.argv0 ?? "-zsh",
      name: seed.name ?? "zsh",
      script: seed.script,
      records: seed.records ?? [],
      lastExit: seed.lastExit ?? null,
      writes: [],
      input: [],
      headBytes: seed.headBytes ?? 0,
      tooLargeAbove: seed.tooLargeAbove,
    };
  }

  private makeWindow(seed: SeedWindow): FakeWindow {
    const blocks = seed.blocks.map((b) => this.makeBlock(b));
    return {
      window_id: seed.id ?? randomUUID(),
      label: seed.label,
      focused_block_id: blocks[seed.focused ?? 0]?.block_id ?? null,
      blocks,
    };
  }

  private onConnection(ws: WebSocket) {
    this.connectionCount++;
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "hello") {
        this.hellos.push(m);
        ws.send(
          JSON.stringify({
            type: "welcome",
            protocol: "rex.control.v1",
            client: { id: `client:${randomUUID()}`, reconnect_token: "x" },
            api_revision: 11,
          }),
        );
        return;
      }
      if (m.type === "request") this.onRequest(ws, m);
    });
  }

  private takeRule(method: string, blockMethod?: string): InjectedError | undefined {
    const keys = blockMethod ? [`block.method:${blockMethod}`, method] : [method];
    const rule = this.rules.find((r) => keys.includes(r.key) && r.remaining > 0);
    if (!rule) return undefined;
    rule.remaining--;
    return rule.error;
  }

  private onRequest(ws: WebSocket, m: { id: string; method: string; payload?: any }) {
    const payload = m.payload ?? {};
    const blockMethod = m.method === "block.method" ? String(payload.method) : undefined;
    this.requests.push({ method: m.method, payload, blockMethod });
    const injected = this.takeRule(m.method, blockMethod);
    if (injected) {
      ws.send(JSON.stringify({ type: "error", id: m.id, error: { code: injected.code, message: injected.message ?? injected.code, status: injected.status ?? 400 } }));
      return;
    }
    try {
      const result = this.handle(m.method, payload);
      ws.send(JSON.stringify({ type: "response", id: m.id, seq: 0, payload: result }));
    } catch (e) {
      const code = e instanceof FakeError ? e.code : "internal";
      const status = e instanceof FakeError ? e.status : 500;
      ws.send(JSON.stringify({ type: "error", id: m.id, error: { code, message: (e as Error).message, status } }));
    }
  }

  private findSession(id: string): FakeSession {
    const s = this.sessions.find((x) => x.session_id === id);
    if (!s) throw new FakeError("not_found", `session ${id} not found`, 404);
    return s;
  }

  private findWindow(s: FakeSession, id: string): FakeWindow {
    const w = s.windows.find((x) => x.window_id === id);
    if (!w) throw new FakeError("not_found", `window ${id} not found`, 404);
    return w;
  }

  private findBlock(s: FakeSession, id: string): { window: FakeWindow; block: FakeBlock } {
    for (const w of s.windows) {
      const block = w.blocks.find((b) => b.block_id === id);
      if (block) return { window: w, block };
    }
    throw new FakeError("not_found", `block ${id} not found`, 404);
  }

  private blockFromLayout(layout: any): FakeBlock {
    const spec = layout?.block ?? {};
    const options = spec.options ?? {};
    return this.makeBlock({ label: spec.label, flavor: spec.flavor, cwd: options.cwd });
  }

  private handle(method: string, p: any): unknown {
    switch (method) {
      case "session.attach_all":
        return {};
      case "server.version":
        return { version: "9.9.9-fake" };
      case "session.list":
        return { sessions: this.sessions.map((s) => ({ session_id: s.session_id, label: s.label })) };
      case "session.view":
        return this.view(this.findSession(p.session_id));
      case "session.create": {
        const windows: FakeWindow[] = (p.initial_windows ?? []).map((w: any) => {
          const block = this.blockFromLayout(w.layout);
          return { window_id: randomUUID(), label: w.window_label, focused_block_id: block.block_id, blocks: [block] };
        });
        const s: FakeSession = { session_id: randomUUID(), label: p.label ?? "untitled", active_window_id: windows[0]?.window_id ?? null, windows };
        this.sessions.push(s);
        return { session_id: s.session_id, initial_windows: windows.map((w) => ({ window_id: w.window_id, block_ids: w.blocks.map((b) => b.block_id) })) };
      }
      case "session.new_window": {
        const s = this.findSession(p.session_id);
        const block = this.blockFromLayout(p.layout);
        const w: FakeWindow = { window_id: randomUUID(), label: p.window_label, focused_block_id: block.block_id, blocks: [block] };
        s.windows.push(w);
        if (p.focus) s.active_window_id = w.window_id;
        return { window_id: w.window_id, block_ids: [block.block_id] };
      }
      case "session.new_split": {
        const s = this.findSession(p.session_id);
        const w = p.anchor_id ? this.findBlock(s, p.anchor_id).window : this.findWindow(s, p.window_id);
        const block = this.blockFromLayout(p.layout);
        w.blocks.push(block);
        if (p.focus) w.focused_block_id = block.block_id;
        return { block_ids: [block.block_id] };
      }
      case "session.destroy": {
        const s = this.findSession(p.session_id);
        this.sessions = this.sessions.filter((x) => x !== s);
        return {};
      }
      case "session.close_window": {
        const s = this.findSession(p.session_id);
        const w = this.findWindow(s, p.window_id);
        s.windows = s.windows.filter((x) => x !== w);
        if (s.active_window_id === w.window_id) s.active_window_id = s.windows[0]?.window_id ?? null;
        return {};
      }
      case "block.close": {
        const s = this.findSession(p.session_id);
        const { window, block } = this.findBlock(s, p.block_id);
        window.blocks = window.blocks.filter((b) => b !== block);
        if (window.focused_block_id === block.block_id) window.focused_block_id = window.blocks[0]?.block_id ?? null;
        if (window.blocks.length === 0) s.windows = s.windows.filter((w) => w !== window);
        return {};
      }
      case "session.set_label":
        this.findSession(p.session_id).label = p.label;
        return {};
      case "session.set_window_label":
        this.findWindow(this.findSession(p.session_id), p.window_id).label = p.label;
        return {};
      case "session.set_block_label":
        this.findBlock(this.findSession(p.session_id), p.block_id).block.label = p.label;
        return {};
      case "block.event": {
        const { block } = this.findBlock(this.findSession(p.session_id), p.block_id);
        block.input.push(p.event);
        return {};
      }
      case "block.method":
        return this.blockMethod(p);
      default:
        throw new FakeError("not_found", `unknown method ${method}`, 404);
    }
  }

  private blockMethod(p: any): unknown {
    const { block } = this.findBlock(this.findSession(p.session_id), p.block_id);
    const args = p.args ?? {};
    switch (p.method) {
      case "program_status":
        return { records: block.records };
      case "title":
        return { title: block.title };
      case "process":
        return {
          foreground: { name: block.name, argv0: block.argv0, script: block.script, cwd: block.cwd },
          last_exit: block.lastExit,
        };
      case "format": {
        const bytes = Buffer.byteLength(block.screen);
        if (args.max_bytes === undefined) {
          if (block.tooLargeAbove !== undefined && bytes > block.tooLargeAbove) throw new FakeError("too_large", "content too large", 413);
          return { content: block.screen };
        }
        const id = this.nextBlob++;
        this.blobs.set(id, block.screen);
        const head = Buffer.from(block.screen).subarray(0, block.headBytes).toString();
        return { content: head, id, total: bytes };
      }
      case "blob_read": {
        const blob = this.blobs.get(args.id);
        if (blob === undefined) throw new FakeError("not_found", "no such blob", 404);
        const buf = Buffer.from(blob);
        const end = Math.min(buf.length, args.offset + args.max_bytes);
        return { data: buf.subarray(args.offset, end).toString(), eof: end >= buf.length };
      }
      case "write":
        block.writes.push(args.data);
        return {};
      default:
        throw new FakeError("not_found", `unknown block method ${p.method}`, 404);
    }
  }

  private view(s: FakeSession): unknown {
    return {
      session_id: s.session_id,
      label: s.label,
      active_window_id: s.active_window_id,
      windows: s.windows.map((w) => ({
        window_id: w.window_id,
        label: w.label,
        focused_block_id: w.focused_block_id,
        layers: [
          {
            layer_id: `layer-${w.window_id}`,
            kind: "tiled",
            bounds: [0, 0, 1, 1],
            layout: layoutFor(w.blocks),
            blocks: w.blocks.map((b) => ({ block_id: b.block_id, creator_name: b.creator_name, flavor: b.flavor, label: b.label })),
          },
        ],
      })),
    };
  }
}

function layoutFor(blocks: FakeBlock[]): unknown {
  if (blocks.length === 0) return null;
  const n = blocks.length;
  let node: any = { rect: [0, 0, 1 / n, 1], block_id: blocks[0]!.block_id };
  for (let i = 1; i < n; i++) {
    node = {
      rect: [0, 0, (i + 1) / n, 1],
      split: {
        split_id: `split-${i}`,
        direction: "horizontal",
        ratio: i / (i + 1),
        before: node,
        after: { rect: [i / n, 0, 1 / n, 1], block_id: blocks[i]!.block_id },
      },
    };
  }
  return node;
}

class FakeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
