import type { IncomingMessage, Server } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SCOPE, type OwnerOAuthProvider } from "./oauth.js";

export interface HttpOptions {
  token?: string;
  host: string;
  port: number;
  makeServer: () => McpServer;
  log?: (line: string) => void;
  oauth?: { publicUrl: URL; provider: OwnerOAuthProvider };
  trustProxy?: string;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function tokenMatches(given: string | undefined, token: string | undefined): boolean {
  if (!given || !token) return false;
  return timingSafeEqual(digest(given), digest(token));
}

function rawPath(req: IncomingMessage): string {
  return (req.url ?? "/").split("?")[0]!;
}

export function authorize(req: IncomingMessage, token: string | undefined): boolean {
  const path = rawPath(req);
  const m = /^\/([^/]+)\/mcp\/?$/.exec(path);
  if (m) return tokenMatches(m[1], token);
  if (path === "/mcp" || path === "/mcp/") {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    return tokenMatches(bearer?.[1]?.trim(), token);
  }
  return false;
}

function notFound(res: Response) {
  res.status(404).set({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).send("not found\n");
}

export function createApp(opts: HttpOptions): express.Express {
  const log = opts.log ?? ((l: string) => console.error(l));
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", opts.trustProxy ?? "loopback");

  const handleMcp = async (req: Request, res: Response) => {
    const started = Date.now();
    const mcp = opts.makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`MCP request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.status(500).type("text/plain").send("internal error\n");
    } finally {
      log(`${req.method} /mcp ${res.statusCode} ${Date.now() - started}ms client=${req.auth?.clientId ?? "path-token"}`);
    }
  };

  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok\n");
  });

  if (opts.oauth) {
    const { publicUrl, provider } = opts.oauth;
    const resourceUrl = new URL("/mcp", publicUrl);
    app.use(mcpAuthRouter({ provider, issuerUrl: publicUrl, resourceServerUrl: resourceUrl, scopesSupported: [SCOPE], resourceName: "Rex MCP" }));
    app.post("/oauth/approve", express.urlencoded({ extended: false, limit: "8kb" }), (req, res, next) => {
      provider.handleApproval(req, res).catch(next);
    });
    const bearer = requireBearerAuth({ verifier: provider, requiredScopes: [SCOPE], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) });
    app.all(["/mcp", "/mcp/"], bearer, (req, res, next) => {
      handleMcp(req, res).catch(next);
    });
  }

  app.use((req, res, next) => {
    if (!authorize(req, opts.token)) {
      const p = rawPath(req);
      log(`${req.method} ${p === "/mcp" || p === "/mcp/" ? "/mcp" : "/<redacted>"} 404`);
      return notFound(res);
    }
    handleMcp(req, res).catch(next);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) res.status(500).type("text/plain").send("internal error\n");
    else res.destroy();
  });
  return app;
}

export function startHttp(opts: HttpOptions): Promise<Server> {
  const app = createApp(opts);
  return new Promise((resolve, reject) => {
    const server = app.listen(opts.port, opts.host, (err?: Error) => {
      if (err) reject(err);
      else resolve(server);
    });
    server.once("error", reject);
  });
}
