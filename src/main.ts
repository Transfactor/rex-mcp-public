#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { OwnerOAuthProvider } from "./oauth.js";
import { startHttp } from "./http.js";
import { ServerPool, tailscaleDiscovery } from "./rex/pool.js";
import { RexService } from "./rex/service.js";
import { createMcpServer } from "./tools.js";

const USAGE = `Usage: rex-mcp [serve | stdio | token | help]

  serve   Start the MCP endpoint over HTTP (default). Needs REX_MCP_PUBLIC_URL or REX_MCP_TOKEN.
  stdio   Serve MCP over stdin and stdout, for a local MCP client.
  token   Print a new random token for REX_MCP_TOKEN.

Environment:
  REX_MCP_PUBLIC_URL       The public URL, such as https://mcp.example.com. Turns on OAuth.
  REX_MCP_OWNER_SECRET     The secret that the OAuth approval page asks for.
  REX_MCP_STATE_DIR        Where OAuth clients and tokens are kept. The default is ./state.
  REX_MCP_TOKEN            Optional static token: /<token>/mcp, or a Bearer token on /mcp
  REX_MCP_SERVERS          name=endpoint,... for example alpha=https://alpha-rex.<tailnet>.ts.net
  REX_MCP_DISCOVER         1 to add every tailnet device whose name ends with REX_MCP_DISCOVER_SUFFIX
  REX_MCP_DISCOVER_SUFFIX  The suffix for discovery. The default is "-rex".
  REX_MCP_CONFIG           A JSON config file. The default is ./rex-mcp.json if it exists.
  REX_MCP_HOST, REX_MCP_PORT  The listen address. The default is 127.0.0.1:8787.
  REX_MCP_SOCKS_PROXY      A SOCKS5 proxy for Rex connections, such as socks5h://127.0.0.1:1055 (tailscaled in userspace mode).
  REX_MCP_TRUST_PROXY      Which reverse proxies to trust for client IPs (Express "trust proxy"). The default is loopback.
`;

async function main() {
  const cmd = process.argv[2] ?? "serve";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "token") {
    process.stdout.write(`${randomBytes(32).toString("base64url")}\n`);
    return;
  }
  if (cmd !== "serve" && cmd !== "stdio") {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const cfg = loadConfig();
  const pool = new ServerPool({
    servers: cfg.servers,
    discovery: cfg.discoverTailscale ? tailscaleDiscovery(cfg.discoverSuffix) : undefined,
    clientLabel: cfg.clientLabel,
    socksProxy: cfg.socksProxy,
  });
  const rex = new RexService(pool);
  const shutdown = () => {
    pool.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (cmd === "stdio") {
    await createMcpServer(rex).connect(new StdioServerTransport());
    return;
  }

  if (!cfg.token && !cfg.publicUrl) {
    process.stderr.write("Set REX_MCP_PUBLIC_URL and REX_MCP_OWNER_SECRET for OAuth, or REX_MCP_TOKEN for a static token. Make a secret with: rex-mcp token\n");
    process.exit(2);
  }
  const oauth = cfg.publicUrl
    ? { publicUrl: cfg.publicUrl, provider: new OwnerOAuthProvider({ ownerSecret: cfg.ownerSecret!, statePath: join(cfg.stateDir, "oauth.json"), staticToken: cfg.token }) }
    : undefined;
  await startHttp({ token: cfg.token, host: cfg.host, port: cfg.port, makeServer: () => createMcpServer(rex), oauth, trustProxy: cfg.trustProxy });
  const servers = cfg.servers.map((s) => s.name).join(", ") || "none";
  const auth = [oauth ? `OAuth at ${cfg.publicUrl!.origin}/mcp` : "", cfg.token ? "static token" : ""].filter(Boolean).join(" + ");
  console.error(`rex-mcp listens on http://${cfg.host}:${cfg.port} (auth: ${auth}; servers: ${servers}; tailscale discovery: ${cfg.discoverTailscale ? "on" : "off"})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
