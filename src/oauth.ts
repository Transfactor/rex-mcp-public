import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Request, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export const SCOPE = "rex";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

interface Grant {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface Code extends Grant {
  challenge: string;
  redirectUri: string;
}

interface Pending {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
  attempts: number;
}

interface State {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, Grant>;
  refresh: Record<string, Grant>;
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function secretMatches(given: string, secret: string): boolean {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(secret).digest());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

export interface OwnerProviderOptions {
  ownerSecret: string;
  statePath?: string;
  staticToken?: string;
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  private readonly ownerSecret: string;
  private readonly statePath: string | undefined;
  private readonly staticToken: string | undefined;
  private state: State = { clients: {}, access: {}, refresh: {} };
  private readonly codes = new Map<string, Code>();
  private readonly pending = new Map<string, Pending>();

  constructor(opts: OwnerProviderOptions) {
    this.ownerSecret = opts.ownerSecret;
    this.statePath = opts.statePath;
    this.staticToken = opts.staticToken;
    if (this.statePath && existsSync(this.statePath)) this.state = { ...this.state, ...JSON.parse(readFileSync(this.statePath, "utf8")) };
  }

  private save() {
    if (!this.statePath) return;
    const t = nowS();
    for (const table of [this.state.access, this.state.refresh]) for (const [k, g] of Object.entries(table)) if (g.expiresAt < t) delete table[k];
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.state.clients[id],
      registerClient: (client) => {
        const full = { ...client, client_id: (client as Partial<OAuthClientInformationFull>).client_id ?? randomUUID(), client_id_issued_at: nowS() } as OAuthClientInformationFull;
        this.state.clients[full.client_id] = full;
        this.save();
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    for (const [k, p] of this.pending) if (p.expiresAt < Date.now()) this.pending.delete(k);
    const id = randomBytes(24).toString("base64url");
    this.pending.set(id, { clientId: client.client_id, params, expiresAt: Date.now() + PENDING_TTL_MS, attempts: 0 });
    this.renderConsent(res, id, client, params);
  }

  private renderConsent(res: Response, id: string, client: OAuthClientInformationFull, params: AuthorizationParams, error?: string) {
    const name = client.client_name ?? client.client_id;
    const redirect = new URL(params.redirectUri);
    const target = redirect.host;
    // Browsers apply form-action to the redirect after the POST, so the client's origin must be allowed.
    const redirectSource = redirect.origin !== "null" ? redirect.origin : redirect.protocol;
    res.status(error ? 401 : 200).set({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectSource}` });
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rex MCP access</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fafafa}input{width:100%;padding:.5rem;font-size:1rem;box-sizing:border-box}button{padding:.5rem 1rem;font-size:1rem;margin:.75rem .5rem 0 0}.err{color:#b00}</style></head>
<body><h1>Rex MCP access</h1>
<p><b>${escapeHtml(name)}</b> asks for full control of your Rex servers. It sends you back to <b>${escapeHtml(target)}</b>.</p>
<p>Give the owner secret to approve.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/approve"><input type="hidden" name="request" value="${escapeHtml(id)}">
<input type="password" name="secret" autocomplete="current-password" autofocus required>
<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></form></body></html>`);
  }

  async handleApproval(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const id = body.request ?? "";
    const p = this.pending.get(id);
    if (!p || p.expiresAt < Date.now()) {
      this.pending.delete(id);
      res.status(400).type("text/plain").send("This approval request expired. Start the connection again.\n");
      return;
    }
    const redirect = new URL(p.params.redirectUri);
    if (p.params.state !== undefined) redirect.searchParams.set("state", p.params.state);
    if (body.decision === "deny") {
      this.pending.delete(id);
      redirect.searchParams.set("error", "access_denied");
      res.redirect(302, redirect.href);
      return;
    }
    if (!secretMatches(body.secret ?? "", this.ownerSecret)) {
      p.attempts++;
      await new Promise((r) => setTimeout(r, 1000));
      const client = this.state.clients[p.clientId];
      if (p.attempts >= MAX_ATTEMPTS || !client) {
        this.pending.delete(id);
        res.status(403).type("text/plain").send("Too many wrong secrets. Start the connection again.\n");
        return;
      }
      this.renderConsent(res, id, client, p.params, "The secret is not correct.");
      return;
    }
    this.pending.delete(id);
    const code = randomBytes(32).toString("base64url");
    this.codes.set(hash(code), {
      clientId: p.clientId,
      scopes: p.params.scopes?.length ? p.params.scopes : [SCOPE],
      resource: p.params.resource?.href,
      challenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    redirect.searchParams.set("code", code);
    res.redirect(302, redirect.href);
  }

  private code(client: OAuthClientInformationFull, code: string): Code {
    const c = this.codes.get(hash(code));
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("the authorization code is not valid");
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.code(client, authorizationCode).challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const c = this.code(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    if (resource && c.resource && resource.href !== c.resource) throw new InvalidGrantError("resource does not match");
    this.codes.delete(hash(authorizationCode));
    return this.issue(client.client_id, c.scopes, c.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = hash(refreshToken);
    const g = this.state.refresh[key];
    if (!g || g.clientId !== client.client_id || g.expiresAt < nowS()) throw new InvalidGrantError("the refresh token is not valid");
    if (scopes?.some((s) => !g.scopes.includes(s))) throw new InvalidGrantError("the scopes are wider than the original grant");
    if (resource && g.resource && resource.href !== g.resource) throw new InvalidGrantError("resource does not match");
    delete this.state.refresh[key];
    return this.issue(client.client_id, scopes?.length ? scopes : g.scopes, g.resource);
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    this.state.access[hash(access)] = { clientId, scopes, resource, expiresAt: nowS() + ACCESS_TTL_S };
    this.state.refresh[hash(refresh)] = { clientId, scopes, resource, expiresAt: nowS() + REFRESH_TTL_S };
    this.save();
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.staticToken && secretMatches(token, this.staticToken)) return { token, clientId: "static-token", scopes: [SCOPE], expiresAt: nowS() + ACCESS_TTL_S };
    const g = this.state.access[hash(token)];
    if (!g || g.expiresAt < nowS()) throw new InvalidTokenError("the access token is not valid");
    return { token, clientId: g.clientId, scopes: g.scopes, expiresAt: g.expiresAt, resource: g.resource ? new URL(g.resource) : undefined };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hash(request.token);
    for (const table of [this.state.access, this.state.refresh]) if (table[key]?.clientId === client.client_id) delete table[key];
    this.save();
  }
}
