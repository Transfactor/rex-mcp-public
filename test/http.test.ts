import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, MIN_TOKEN_LENGTH, parseServerList } from "../src/config.js";
import { authorize, startHttp, tokenMatches } from "../src/http.js";
import { ServerPool, tailscaleDiscovery } from "../src/rex/pool.js";
import { RexService } from "../src/rex/service.js";
import { createMcpServer } from "../src/tools.js";
import { FakeRex } from "./fakeRex.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

function fakeReq(url: string, authorization?: string): IncomingMessage {
  return { url, headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

describe("tokenMatches and authorize", () => {
  it("has a 43 character test token", () => {
    expect(TOKEN).toHaveLength(43);
  });

  it("matches only the exact token", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it("does not URL-decode the path token", () => {
    expect(authorize(fakeReq("/%E0/mcp"), TOKEN)).toBe(false);
    expect(authorize(fakeReq(`/${TOKEN.slice(0, -1)}%${TOKEN.charCodeAt(42).toString(16)}/mcp`), TOKEN)).toBe(false);
  });

  it("accepts the token in the path", () => {
    expect(authorize(fakeReq(`/${TOKEN}/mcp`), TOKEN)).toBe(true);
    expect(authorize(fakeReq(`/${TOKEN}/mcp/`), TOKEN)).toBe(true);
    expect(authorize(fakeReq(`/${TOKEN}/mcp?x=1`), TOKEN)).toBe(true);
  });

  it("rejects a wrong token in the path", () => {
    expect(authorize(fakeReq(`/wrong/mcp`), TOKEN)).toBe(false);
    expect(authorize(fakeReq(`/${TOKEN}x/mcp`), TOKEN)).toBe(false);
  });

  it("rejects other paths", () => {
    expect(authorize(fakeReq("/"), TOKEN)).toBe(false);
    expect(authorize(fakeReq(`/${TOKEN}`), TOKEN)).toBe(false);
    expect(authorize(fakeReq(`/${TOKEN}/other`), TOKEN)).toBe(false);
    expect(authorize(fakeReq(`/${TOKEN}/mcp/extra`), TOKEN)).toBe(false);
    expect(authorize(fakeReq(`/x/${TOKEN}/mcp`), TOKEN)).toBe(false);
  });

  it("accepts a bearer header on /mcp", () => {
    expect(authorize(fakeReq("/mcp", `Bearer ${TOKEN}`), TOKEN)).toBe(true);
    expect(authorize(fakeReq("/mcp/", `bearer ${TOKEN}`), TOKEN)).toBe(true);
  });

  it("rejects a missing or wrong bearer header on /mcp", () => {
    expect(authorize(fakeReq("/mcp"), TOKEN)).toBe(false);
    expect(authorize(fakeReq("/mcp", "Bearer nope"), TOKEN)).toBe(false);
    expect(authorize(fakeReq("/mcp", TOKEN), TOKEN)).toBe(false);
    expect(authorize(fakeReq("/mcp", "Basic abc"), TOKEN)).toBe(false);
  });

  it("does not take the path token as a header", () => {
    expect(authorize(fakeReq(`/${TOKEN}/mcp`, "Bearer wrong"), TOKEN)).toBe(true);
  });
});

describe("startHttp", () => {
  let fake: FakeRex;
  let pool: ServerPool;
  let server: Server;
  let base: string;
  const logs: string[] = [];

  beforeAll(async () => {
    fake = await FakeRex.start();
    fake.addSession({
      label: "alpha",
      windows: [{ label: "main", blocks: [{ label: "agent", records: [{ state: "blocked", app: "claude", updated_at: "2026-01-01T00:00:00Z" }] }, { label: "sh" }] }],
    });
    pool = new ServerPool({ servers: [{ name: "fake", endpoint: fake.endpoint }] });
    const rex = new RexService(pool);
    server = await startHttp({ token: TOKEN, host: "127.0.0.1", port: 0, makeServer: () => createMcpServer(rex), log: (l) => logs.push(l) });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    pool.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fake.stop();
  });

  async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined));
    return client;
  }

  function textOf(result: unknown): string {
    const r = result as { content: { type: string; text: string }[] };
    return r.content[0]!.text;
  }

  it("serves list_servers and get_overview through the token path", async () => {
    const client = await connect(`${base}/${TOKEN}/mcp`);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_servers", "get_overview", "read_pane", "send_input", "create_session", "create_tab", "create_pane", "close_session", "close_tab", "close_pane", "rename"]),
    );
    const list = JSON.parse(textOf(await client.callTool({ name: "list_servers", arguments: {} })));
    expect(list.servers).toHaveLength(1);
    expect(list.servers[0]).toMatchObject({ name: "fake", online: true, version: "9.9.9-fake", sessions: 1 });
    const ov = JSON.parse(textOf(await client.callTool({ name: "get_overview", arguments: {} })));
    expect(ov[0].counts).toMatchObject({ blocked: 1, idle: 1 });
    expect(ov[0].sessions[0].label).toBe("alpha");
    await client.close();
  });

  it("serves the same tools through /mcp with a bearer header", async () => {
    const client = await connect(`${base}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    const list = JSON.parse(textOf(await client.callTool({ name: "list_servers", arguments: {} })));
    expect(list.servers[0].name).toBe("fake");
    const ov = JSON.parse(textOf(await client.callTool({ name: "get_overview", arguments: { activity_only: true } })));
    expect(ov[0].sessions[0].tabs[0].panes).toHaveLength(1);
    await client.close();
  });

  it("returns a tool error for a bad argument combination", async () => {
    const client = await connect(`${base}/${TOKEN}/mcp`);
    const res = await client.callTool({ name: "get_overview", arguments: { session: "alpha" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/session requires server/);
    await client.close();
  });

  it("reads a pane through the MCP client", async () => {
    fake.session("alpha").windows[0]!.blocks[0]!.screen = "hello\nworld\n";
    const client = await connect(`${base}/${TOKEN}/mcp`);
    const res = JSON.parse(textOf(await client.callTool({ name: "read_pane", arguments: { server: "fake", session: "alpha", pane: 1 } })));
    expect(res.text).toBe("hello\nworld");
    await client.close();
  });

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

  it("returns 404 for a wrong token", async () => {
    const res = await post("/wrong-token-wrong-token-wrong-token-xx/mcp");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found\n");
  });

  it("returns 404 for a missing token", async () => {
    expect((await post("/mcp/")).status).toBe(404);
    expect((await post("//mcp")).status).toBe(404);
  });

  it("returns 404 for /mcp without a header or with a wrong header", async () => {
    expect((await post("/mcp")).status).toBe(404);
    expect((await post("/mcp", { authorization: "Bearer wrong" })).status).toBe(404);
  });

  it("returns 404 for other paths", async () => {
    expect((await post("/")).status).toBe(404);
    expect((await post(`/${TOKEN}`)).status).toBe(404);
    expect((await post(`/${TOKEN}/other`)).status).toBe(404);
    expect((await fetch(`${base}/anything`)).status).toBe(404);
  });

  it("returns 404 for malformed percent escapes and keeps serving", async () => {
    for (const path of ["/%E0/mcp", "/%zz/mcp", `/${TOKEN}%E0/mcp`]) expect((await post(path)).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("does not log the token", () => {
    const text = logs.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).toMatch(/404/);
  });

  it("answers /healthz with 200", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });
});

describe("parseServerList", () => {
  it("parses comma and whitespace separated items", () => {
    expect(parseServerList("a=http://x:1, b=unix:///run/s.sock\nc=https://h.ts.net")).toEqual([
      { name: "a", endpoint: "http://x:1" },
      { name: "b", endpoint: "unix:///run/s.sock" },
      { name: "c", endpoint: "https://h.ts.net" },
    ]);
  });

  it("rejects an item without a name", () => {
    expect(() => parseServerList("nonsense")).toThrow(/must be name=endpoint/);
    expect(() => parseServerList("=http://x")).toThrow(/must be name=endpoint/);
  });
});

describe("loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "rexmcp-"));
  const missing = { REX_MCP_CONFIG: join(dir, "absent.json") };
  const file = (obj: unknown) => {
    const p = join(dir, `c${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(obj));
    return { REX_MCP_CONFIG: p };
  };

  it("fails when a named config file is missing", () => {
    expect(() => loadConfig(missing)).toThrow(/does not exist/);
  });

  it("uses defaults when nothing is configured", () => {
    const cfg = loadConfig(file({}));
    expect(cfg).toMatchObject({ servers: [], discoverTailscale: true, discoverSuffix: "-rex", token: undefined, host: "127.0.0.1", port: 8787 });
    expect(cfg.clientLabel).toMatch(/^rex-mcp@/);
  });

  it("parses REX_MCP_SERVERS and turns discovery off", () => {
    const cfg = loadConfig({ ...file({}), REX_MCP_SERVERS: "a=http://x:1,b=unix:///s" });
    expect(cfg.servers).toEqual([
      { name: "a", endpoint: "http://x:1" },
      { name: "b", endpoint: "unix:///s" },
    ]);
    expect(cfg.discoverTailscale).toBe(false);
  });

  it("lets REX_MCP_SERVERS override file servers by name", () => {
    const cfg = loadConfig({ ...file({ servers: [{ name: "a", endpoint: "http://old" }, { name: "z", endpoint: "http://z" }] }), REX_MCP_SERVERS: "a=http://new" });
    expect(cfg.servers).toEqual([
      { name: "a", endpoint: "http://new" },
      { name: "z", endpoint: "http://z" },
    ]);
  });

  it("lets REX_MCP_DISCOVER override the default", () => {
    expect(loadConfig({ ...file({}), REX_MCP_SERVERS: "a=http://x", REX_MCP_DISCOVER: "1" }).discoverTailscale).toBe(true);
    expect(loadConfig({ ...file({}), REX_MCP_DISCOVER: "false" }).discoverTailscale).toBe(false);
    expect(loadConfig({ ...file({ discoverTailscale: false }) }).discoverTailscale).toBe(false);
  });

  it("reads host, port, suffix and label", () => {
    const cfg = loadConfig({ ...file({ port: 1, host: "h" }), REX_MCP_PORT: "9000", REX_MCP_DISCOVER_SUFFIX: "-x", REX_MCP_CLIENT_LABEL: "lbl" });
    expect(cfg).toMatchObject({ port: 9000, host: "h", discoverSuffix: "-x", clientLabel: "lbl" });
  });

  it("rejects bad server names", () => {
    expect(() => loadConfig({ ...file({}), REX_MCP_SERVERS: "a/b=http://x" })).toThrow(/must not be empty or contain spaces or slashes/);
    expect(() => loadConfig(file({ servers: [{ name: "a b", endpoint: "x" }] }))).toThrow(/server name/);
  });

  it("validates the token", () => {
    const base = file({});
    expect(loadConfig({ ...base, REX_MCP_TOKEN: TOKEN }).token).toBe(TOKEN);
    expect(loadConfig({ ...base, REX_MCP_TOKEN: "a".repeat(MIN_TOKEN_LENGTH) }).token).toHaveLength(32);
    expect(loadConfig({ ...base, REX_MCP_TOKEN: "" }).token).toBeUndefined();
    expect(() => loadConfig({ ...base, REX_MCP_TOKEN: "short" })).toThrow(/REX_MCP_TOKEN/);
    expect(() => loadConfig({ ...base, REX_MCP_TOKEN: "a".repeat(31) })).toThrow(/REX_MCP_TOKEN/);
    expect(() => loadConfig({ ...base, REX_MCP_TOKEN: `${"a".repeat(31)}/` })).toThrow(/REX_MCP_TOKEN/);
    expect(() => loadConfig({ ...base, REX_MCP_TOKEN: `${"a".repeat(31)} ` })).toThrow(/REX_MCP_TOKEN/);
  });
});

describe("tailscaleDiscovery", () => {
  const status = {
    Self: { HostName: "me-rex", DNSName: "me-rex.tail.ts.net.", Online: true },
    Peer: {
      a: { HostName: "bronto-rex", DNSName: "bronto-rex.tail.ts.net.", Online: true },
      b: { HostName: "alpha-rex", DNSName: "alpha-rex.tail.ts.net.", Online: false },
      c: { HostName: "laptop", DNSName: "laptop.tail.ts.net.", Online: true },
      d: { HostName: "nodns-rex", Online: true },
      e: { HostName: "UPPER-REX", DNSName: "upper-rex.tail.ts.net.", Online: true },
    },
  };

  it("keeps hosts with the suffix, strips it and sorts by name", async () => {
    const found = await tailscaleDiscovery("-rex", async () => status)();
    expect(found).toEqual([
      { name: "alpha", endpoint: "https://alpha-rex.tail.ts.net", source: "tailscale", tailnetOnline: false },
      { name: "bronto", endpoint: "https://bronto-rex.tail.ts.net", source: "tailscale", tailnetOnline: true },
      { name: "me", endpoint: "https://me-rex.tail.ts.net", source: "tailscale", tailnetOnline: true },
      { name: "UPPER", endpoint: "https://upper-rex.tail.ts.net", source: "tailscale", tailnetOnline: true },
    ]);
  });

  it("matches the suffix ignoring case", async () => {
    const found = await tailscaleDiscovery("-REX", async () => status)();
    expect(found.map((f) => f.name)).toEqual(["alpha", "bronto", "me", "UPPER"]);
  });

  it("returns nothing for an empty status", async () => {
    expect(await tailscaleDiscovery("-rex", async () => ({}))()).toEqual([]);
  });

  it("feeds the pool and marks offline devices", async () => {
    const pool = new ServerPool({ servers: [], discovery: tailscaleDiscovery("-rex", async () => status) });
    expect(await pool.names()).toEqual(["alpha", "bronto", "me", "UPPER"].sort());
    await expect(pool.get("alpha")).rejects.toThrow(/offline in Tailscale/);
    pool.close();
  });

  it("keeps the last discovery error", async () => {
    const pool = new ServerPool({
      servers: [{ name: "fixed", endpoint: "http://127.0.0.1:1" }],
      discovery: tailscaleDiscovery("-rex", async () => {
        throw new Error("no tailscale");
      }),
    });
    expect(await pool.names()).toEqual(["fixed"]);
    expect(pool.lastDiscoveryError).toMatch(/tailscale discovery failed: no tailscale/);
    pool.close();
  });

  it("drops vanished tailscale servers and keeps configured ones", async () => {
    let current: { Peer?: Record<string, { HostName?: string; DNSName?: string; Online?: boolean }> } = status;
    const pool = new ServerPool({ servers: [{ name: "fixed", endpoint: "http://127.0.0.1:1" }], discovery: tailscaleDiscovery("-rex", async () => current), discoveryTtlMs: 0 });
    expect(await pool.names()).toContain("bronto");
    current = { Peer: {} };
    expect(await pool.names()).toEqual(["fixed"]);
    pool.close();
  });
});
