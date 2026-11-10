import { EventEmitter } from "node:events";
import type { Agent } from "node:http";
import WebSocket from "ws";
import { SocksProxyAgent } from "socks-proxy-agent";

export const API_REVISION = 11;
export const CONTROL_SUBPROTOCOL = "rex.control.v1";

export interface ClientInfo {
  kind: "app" | "cli" | "agent" | "other";
  name: string;
  platform?: string;
  label?: string;
  version?: string;
}

export interface Welcome {
  protocol: string;
  client: { id: string; reconnect_token: string };
  api_revision: number;
  api_server_revision?: number;
  limits?: { max_message_bytes?: number };
}

interface Message {
  type: string;
  id?: string;
  method?: string;
  payload?: unknown;
  error?: unknown;
}

export class RexApiError extends Error {
  readonly method: string;
  readonly detail: unknown;

  constructor(method: string, detail: unknown) {
    super(`${method}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.name = "RexApiError";
    this.method = method;
    this.detail = detail;
  }

  get code(): string | undefined {
    const d = this.detail as { code?: unknown } | undefined;
    return typeof d?.code === "string" ? d.code : undefined;
  }
}

export function controlUrl(endpoint: string): string {
  const u = endpoint.trim().replace(/\/+$/, "");
  if (u.startsWith("unix://")) return `ws+unix://${u.slice("unix://".length)}:/api/control`;
  if (u.startsWith("/")) return `ws+unix://${u}:/api/control`;
  if (u.startsWith("https://")) return `wss://${u.slice("https://".length)}/api/control`;
  if (u.startsWith("http://")) return `ws://${u.slice("http://".length)}/api/control`;
  if (u.startsWith("wss://") || u.startsWith("ws://")) return `${u}/api/control`;
  throw new Error(`unsupported Rex endpoint "${endpoint}": use https://<host>.<tailnet>.ts.net or unix:///path`);
}

export interface ConnectOptions {
  client: ClientInfo;
  timeoutMs?: number;
  socksProxy?: string;
}

const agents = new Map<string, Agent>();

function proxyAgent(url: string, socksProxy: string | undefined): Agent | undefined {
  if (!socksProxy || url.startsWith("ws+unix:")) return undefined;
  let a = agents.get(socksProxy);
  if (!a) {
    a = new SocksProxyAgent(socksProxy);
    agents.set(socksProxy, a);
  }
  return a;
}

export class RexControl extends EventEmitter {
  private nextId = 0;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private closedError: Error | undefined;
  private alive = true;
  private heartbeat: NodeJS.Timeout | undefined;

  private readonly ws: WebSocket;
  readonly welcome: Welcome;

  private constructor(ws: WebSocket, welcome: Welcome) {
    super();
    this.ws = ws;
    this.welcome = welcome;
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", (code, reason) => this.onClose(new Error(`connection closed (${code}${reason.length ? ` ${reason}` : ""})`)));
    ws.on("error", (err) => this.onClose(err));
    ws.on("pong", () => {
      this.alive = true;
    });
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        this.onClose(new Error("the server did not answer a ping"));
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, 15_000);
    this.heartbeat.unref();
  }

  static connect(endpoint: string, opts: ConnectOptions): Promise<RexControl> {
    const url = controlUrl(endpoint);
    const timeoutMs = opts.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, [CONTROL_SUBPROTOCOL], { handshakeTimeout: timeoutMs, maxPayload: 64 << 20, agent: proxyAgent(url, opts.socksProxy) });
      const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      const fail = (err: Error) => {
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on("error", () => {});
        ws.terminate();
        reject(err);
      };
      ws.once("error", fail);
      ws.once("close", (code) => fail(new Error(`connection closed during handshake (${code})`)));
      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "hello", api_revision: API_REVISION, client: opts.client }));
      });
      ws.once("message", (data) => {
        let m: Message & Welcome;
        try {
          m = JSON.parse(data.toString());
        } catch {
          return fail(new Error("the server sent a welcome that is not JSON"));
        }
        if (m.type !== "welcome") return fail(new Error(`expected welcome, got ${data.toString().slice(0, 300)}`));
        clearTimeout(timer);
        ws.removeAllListeners();
        resolve(new RexControl(ws, m));
      });
    });
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  call<T = unknown>(method: string, payload?: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = `rm-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const req: Message = { type: "request", id, method };
      if (payload !== undefined) req.payload = payload;
      this.ws.send(JSON.stringify(req), (err) => {
        if (err) this.settle(id, undefined, err);
      });
    });
  }

  blockMethod<T = unknown>(sessionId: string, blockId: string, method: string, args: unknown = {}, timeoutMs?: number): Promise<T> {
    return this.call<T>("block.method", { session_id: sessionId, block_id: blockId, method, args }, timeoutMs);
  }

  close(): void {
    this.onClose(new Error("connection closed by client"));
    this.ws.close(1000);
  }

  private settle(id: string, value: unknown, err?: Error) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  private onMessage(raw: string) {
    let m: Message;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "event") {
      this.emit("event", m);
      return;
    }
    if ((m.type === "response" || m.type === "error") && m.id) {
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === "error" || m.error !== undefined) this.settle(m.id, undefined, new RexApiError(p.method, m.error ?? m.payload));
      else this.settle(m.id, m.payload ?? {});
    }
  }

  private onClose(err: Error) {
    if (this.closedError) return;
    this.closedError = err;
    clearInterval(this.heartbeat);
    for (const [id] of this.pending) this.settle(id, undefined, err);
    this.emit("close", err);
  }
}
