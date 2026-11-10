import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { RexControl, type ClientInfo } from "./control.js";
import type { ServerConfig } from "../config.js";

const execFileAsync = promisify(execFile);

export interface ServerEntry extends ServerConfig {
  source: "config" | "tailscale";
  tailnetOnline?: boolean;
}

export interface ServerState {
  name: string;
  endpoint: string;
  source: ServerEntry["source"];
  online: boolean;
  error?: string;
  version?: string;
  apiRevision?: number;
  sessions?: number;
}

interface Slot {
  entry: ServerEntry;
  conn?: RexControl;
  connecting?: Promise<RexControl>;
  lastError?: string;
}

export interface Discovery {
  (): Promise<ServerEntry[]>;
}

interface TailscalePeer {
  HostName?: string;
  DNSName?: string;
  Online?: boolean;
}

export function tailscaleDiscovery(suffix: string, run = defaultTailscaleStatus): Discovery {
  return async () => {
    const status = await run();
    const peers: TailscalePeer[] = [...Object.values(status.Peer ?? {}), ...(status.Self ? [status.Self] : [])];
    const out: ServerEntry[] = [];
    for (const p of peers) {
      const host = p.HostName ?? "";
      const dns = (p.DNSName ?? "").replace(/\.$/, "");
      if (!dns || !host.toLowerCase().endsWith(suffix.toLowerCase())) continue;
      out.push({
        name: host.slice(0, host.length - suffix.length) || host,
        endpoint: `https://${dns}`,
        source: "tailscale",
        tailnetOnline: p.Online !== false,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
}

async function defaultTailscaleStatus(): Promise<{ Peer?: Record<string, TailscalePeer>; Self?: TailscalePeer }> {
  const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 5000, maxBuffer: 16 << 20 });
  return JSON.parse(stdout);
}

export interface PoolOptions {
  servers: ServerConfig[];
  discovery?: Discovery;
  clientLabel?: string;
  connectTimeoutMs?: number;
  discoveryTtlMs?: number;
  socksProxy?: string;
}

export class ServerPool {
  private readonly slots = new Map<string, Slot>();
  private readonly discovery: Discovery | undefined;
  private readonly client: ClientInfo;
  private readonly connectTimeoutMs: number;
  private readonly discoveryTtlMs: number;
  private readonly socksProxy: string | undefined;
  private discoveredAt = 0;
  private discovering: Promise<void> | undefined;
  private discoveryError: string | undefined;

  constructor(opts: PoolOptions) {
    for (const s of opts.servers) this.slots.set(s.name, { entry: { ...s, source: "config" } });
    this.discovery = opts.discovery;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 8000;
    this.discoveryTtlMs = opts.discoveryTtlMs ?? 60_000;
    this.socksProxy = opts.socksProxy;
    this.client = { kind: "agent", name: "rex-mcp", platform: process.platform, label: opts.clientLabel ?? `rex-mcp@${hostname()}`, version: "0.1.0" };
  }

  get lastDiscoveryError(): string | undefined {
    return this.discoveryError;
  }

  async refresh(force = false): Promise<void> {
    if (!this.discovery) return;
    if (!force && Date.now() - this.discoveredAt < this.discoveryTtlMs) return;
    this.discovering ??= (async () => {
      try {
        const found = await this.discovery!();
        this.discoveryError = undefined;
        const names = new Set(found.map((f) => f.name));
        for (const [name, slot] of this.slots) {
          if (slot.entry.source === "tailscale" && !names.has(name)) {
            slot.conn?.close();
            this.slots.delete(name);
          }
        }
        for (const f of found) {
          const slot = this.slots.get(f.name);
          if (!slot) this.slots.set(f.name, { entry: f });
          else if (slot.entry.source === "tailscale") {
            if (slot.entry.endpoint !== f.endpoint) {
              slot.conn?.close();
              slot.conn = undefined;
            }
            slot.entry = f;
          }
        }
        this.discoveredAt = Date.now();
      } catch (e) {
        this.discoveryError = `tailscale discovery failed: ${errText(e)}`;
        this.discoveredAt = Date.now() - this.discoveryTtlMs + Math.min(this.discoveryTtlMs, 10_000);
      } finally {
        this.discovering = undefined;
      }
    })();
    await this.discovering;
  }

  async names(): Promise<string[]> {
    await this.refresh();
    return [...this.slots.keys()].sort();
  }

  async get(name: string): Promise<RexControl> {
    await this.refresh();
    const slot = this.slots.get(name);
    if (!slot) {
      const known = [...this.slots.keys()].sort().join(", ") || "none";
      throw new Error(`unknown server "${name}". Known servers: ${known}`);
    }
    if (slot.conn && !slot.conn.closed) return slot.conn;
    if (slot.entry.tailnetOnline === false) {
      slot.lastError = "the device is offline in Tailscale";
      throw new Error(`server "${name}" is offline in Tailscale`);
    }
    slot.connecting ??= this.open(slot).finally(() => {
      slot.connecting = undefined;
    });
    return slot.connecting;
  }

  private async open(slot: Slot): Promise<RexControl> {
    const endpoint = slot.entry.endpoint;
    let conn: RexControl | undefined;
    try {
      conn = await RexControl.connect(endpoint, { client: this.client, timeoutMs: this.connectTimeoutMs, socksProxy: this.socksProxy });
      await conn.call("session.attach_all", { event_scope: "session" });
      if (this.slots.get(slot.entry.name) !== slot || slot.entry.endpoint !== endpoint) throw new Error("the server entry changed during the connection");
      const live = conn;
      live.on("close", () => {
        if (slot.conn === live) slot.conn = undefined;
      });
      slot.conn = live;
      slot.lastError = undefined;
      return live;
    } catch (e) {
      conn?.close();
      slot.lastError = errText(e);
      throw new Error(`cannot connect to server "${slot.entry.name}" at ${slot.entry.endpoint}: ${slot.lastError}`);
    }
  }

  async states(): Promise<ServerState[]> {
    await this.refresh(true);
    const slots = [...this.slots.values()].sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    return Promise.all(
      slots.map(async (slot): Promise<ServerState> => {
        const base = { name: slot.entry.name, endpoint: slot.entry.endpoint, source: slot.entry.source };
        try {
          const conn = await this.get(slot.entry.name);
          const [version, list] = await Promise.all([
            conn.call<{ version?: string }>("server.version").catch(() => ({ version: undefined })),
            conn.call<{ sessions: unknown[] | null }>("session.list"),
          ]);
          return { ...base, online: true, version: version.version, apiRevision: conn.welcome.api_revision, sessions: list.sessions?.length ?? 0 };
        } catch (e) {
          return { ...base, online: false, error: slot.lastError ?? errText(e) };
        }
      }),
    );
  }

  close(): void {
    for (const slot of this.slots.values()) slot.conn?.close();
  }
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
