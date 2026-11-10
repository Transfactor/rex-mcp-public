import { createHash, randomBytes } from "node:crypto";
import { createServer as netServer } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { OwnerOAuthProvider } from "../src/oauth.js";
import { ServerPool } from "../src/rex/pool.js";
import { RexService } from "../src/rex/service.js";
import { createMcpServer } from "../src/tools.js";
import { FakeRex } from "./fakeRex.js";

const SECRET = "owner-secret-for-tests-0123456789";
const STATIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const REDIRECT = "http://localhost:9999/callback";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const listTools = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

describe("OAuth", () => {
  let fake: FakeRex;
  let server: Server;
  let base: string;
  let statePath: string;
  let pool: ServerPool;

  beforeAll(async () => {
    fake = await FakeRex.start();
    pool = new ServerPool({ servers: [{ name: "fake", endpoint: fake.endpoint }] });
    const port = await freePort();
    base = `http://localhost:${port}`;
    statePath = join(mkdtempSync(join(tmpdir(), "rex-mcp-oauth-")), "oauth.json");
    const provider = new OwnerOAuthProvider({ ownerSecret: SECRET, statePath, staticToken: STATIC });
    server = await startHttp({
      host: "127.0.0.1",
      port,
      token: STATIC,
      makeServer: () => createMcpServer(new RexService(pool)),
      oauth: { publicUrl: new URL(base), provider },
      log: () => {},
    });
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    pool.close();
    await fake.stop();
  });

  async function register(): Promise<string> {
    const r = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Test client", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { client_id: string }).client_id;
  }

  async function startAuthorize(clientId: string, challenge: string): Promise<string> {
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", scope: "rex" });
    const r = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Test client");
    expect(r.headers.get("content-security-policy")).toContain("form-action 'self' http://localhost:9999");
    return /name="request" value="([^"]+)"/.exec(html)![1]!;
  }

  function approve(request: string, secret: string, decision = "approve") {
    return fetch(`${base}/oauth/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, secret, decision }),
      redirect: "manual",
    });
  }

  function token(params: Record<string, string>) {
    return fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  }

  it("answers 401 with resource metadata on /mcp without a token", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders, body: listTools });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("publishes the metadata documents", async () => {
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
    expect(pr.resource).toBe(`${base}/mcp`);
    expect(pr.authorization_servers[0]).toContain(base);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.authorization_endpoint).toBe(`${base}/authorize`);
    expect(as.registration_endpoint).toBe(`${base}/register`);
    expect(as.code_challenge_methods_supported).toContain("S256");
  });

  it("runs the full flow: register, approve, token, MCP call, refresh", async () => {
    const clientId = await register();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const request = await startAuthorize(clientId, challenge);

    const wrong = await approve(request, "not-the-secret");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("not correct");

    const ok = await approve(request, SECRET);
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st-1");
    const code = loc.searchParams.get("code")!;

    const badPkce = await token({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: clientId, redirect_uri: REDIRECT });
    expect(badPkce.status).toBe(400);

    const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(t.status).toBe(200);
    const tokens = (await t.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(tokens.expires_in).toBe(3600);

    const reuse = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(reuse.status).toBe(400);

    const call = await fetch(`${base}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` }, body: listTools });
    expect(call.status).toBe(200);
    expect(await call.text()).toContain("get_overview");

    const r1 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    const refreshed = (await r1.json()) as { access_token: string };
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const r2 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    expect(r2.status).toBe(400);

    const reloaded = new OwnerOAuthProvider({ ownerSecret: SECRET, statePath });
    await expect(reloaded.verifyAccessToken(refreshed.access_token)).resolves.toMatchObject({ clientId });
    await expect(reloaded.verifyAccessToken("nope")).rejects.toThrow();
  });

  it("redirects with access_denied when the owner denies", async () => {
    const clientId = await register();
    const request = await startAuthorize(clientId, createHash("sha256").update("v".repeat(43)).digest("base64url"));
    const r = await approve(request, "", "deny");
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("drops the request after too many wrong secrets", async () => {
    const clientId = await register();
    const request = await startAuthorize(clientId, createHash("sha256").update("w".repeat(43)).digest("base64url"));
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await approve(request, "wrong")).status);
    expect(codes).toEqual([401, 401, 401, 401, 403]);
    expect((await approve(request, SECRET)).status).toBe(400);
  }, 15_000);

  it("rejects an unknown approval request", async () => {
    expect((await approve("unknown", SECRET)).status).toBe(400);
  });

  it("keeps the static token on both paths", async () => {
    const viaBearer = await fetch(`${base}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${STATIC}` }, body: listTools });
    expect(viaBearer.status).toBe(200);
    const viaPath = await fetch(`${base}/${STATIC}/mcp`, { method: "POST", headers: mcpHeaders, body: listTools });
    expect(viaPath.status).toBe(200);
    const wrongPath = await fetch(`${base}/${STATIC}x/mcp`, { method: "POST", headers: mcpHeaders, body: listTools });
    expect(wrongPath.status).toBe(404);
    const malformed = await fetch(`${base}/%E0/mcp`, { method: "POST", headers: mcpHeaders, body: listTools });
    expect(malformed.status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
