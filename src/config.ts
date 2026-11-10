import { readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";

export interface ServerConfig {
  name: string;
  endpoint: string;
}

export interface Config {
  servers: ServerConfig[];
  discoverTailscale: boolean;
  discoverSuffix: string;
  token: string | undefined;
  host: string;
  port: number;
  clientLabel: string;
  publicUrl: URL | undefined;
  ownerSecret: string | undefined;
  stateDir: string;
  socksProxy: string | undefined;
  trustProxy: string;
}

interface FileConfig {
  servers?: ServerConfig[];
  discoverTailscale?: boolean;
  discoverSuffix?: string;
  host?: string;
  port?: number;
  clientLabel?: string;
}

export const MIN_TOKEN_LENGTH = 32;

export function parseServerList(s: string): ServerConfig[] {
  return s
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((item) => {
      const eq = item.indexOf("=");
      if (eq <= 0) throw new Error(`REX_MCP_SERVERS item "${item}" must be name=endpoint`);
      return { name: item.slice(0, eq), endpoint: item.slice(eq + 1) };
    });
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = env.REX_MCP_CONFIG ?? "rex-mcp.json";
  let file: FileConfig = {};
  if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  else if (env.REX_MCP_CONFIG) throw new Error(`config file ${path} does not exist`);

  const servers = new Map<string, ServerConfig>();
  for (const s of file.servers ?? []) servers.set(s.name, s);
  if (env.REX_MCP_SERVERS) for (const s of parseServerList(env.REX_MCP_SERVERS)) servers.set(s.name, s);
  for (const s of servers.values()) {
    if (!s.name || /[\s/]/.test(s.name)) throw new Error(`server name "${s.name}" must not be empty or contain spaces or slashes`);
  }

  const token = env.REX_MCP_TOKEN || undefined;
  const ownerSecret = env.REX_MCP_OWNER_SECRET || undefined;
  let publicUrl: URL | undefined;
  if (env.REX_MCP_PUBLIC_URL) {
    publicUrl = new URL(env.REX_MCP_PUBLIC_URL);
    const local = publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1";
    if (publicUrl.protocol !== "https:" && !local) throw new Error("REX_MCP_PUBLIC_URL must use https");
    if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("REX_MCP_PUBLIC_URL must be only a scheme and a host, for example https://mcp.example.com");
    if (!ownerSecret || ownerSecret.length < 16) throw new Error("OAuth needs REX_MCP_OWNER_SECRET with at least 16 characters");
  }
  if (token !== undefined && (token.length < MIN_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token))) {
    throw new Error(`REX_MCP_TOKEN must have at least ${MIN_TOKEN_LENGTH} characters from A-Z, a-z, 0-9, "_" and "-"`);
  }

  return {
    servers: [...servers.values()],
    discoverTailscale: bool(env.REX_MCP_DISCOVER) ?? file.discoverTailscale ?? servers.size === 0,
    discoverSuffix: env.REX_MCP_DISCOVER_SUFFIX ?? file.discoverSuffix ?? "-rex",
    token,
    host: env.REX_MCP_HOST ?? file.host ?? "127.0.0.1",
    port: Number(env.REX_MCP_PORT ?? file.port ?? 8787),
    publicUrl,
    ownerSecret,
    stateDir: env.REX_MCP_STATE_DIR ?? "state",
    socksProxy: env.REX_MCP_SOCKS_PROXY || undefined,
    trustProxy: env.REX_MCP_TRUST_PROXY || "loopback",
    clientLabel: env.REX_MCP_CLIENT_LABEL ?? file.clientLabel ?? `rex-mcp@${hostname()}`,
  };
}
