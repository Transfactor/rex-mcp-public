# rex-mcp

rex-mcp is an MCP server that gives an AI agent status and control of your Superlogical Rex terminal servers. Use it from Claude or a different MCP client:

- See what your coding agents do on all your machines.
- Find the agents that wait for input, such as a permission prompt or a question.
- Send text and keys to a pane to unblock an agent.
- Open sessions, tabs and panes, and start new agents in them.

The hierarchy is server > session > tab > pane. In the Rex API, a tab is a "window" and a pane is a "block". Agents run in panes.

WARNING: rex-mcp gives full control of your terminals to each client that you approve. An approved client can type any command on any of your Rex servers, with your permissions. Protect the owner secret and the tokens as you protect an SSH key.

## How it works

```
MCP client (for example Claude) --HTTPS + OAuth--> rex-mcp --Tailscale--> Rex servers
```

- rex-mcp speaks the Rex control protocol: JSON requests over a WebSocket at `<endpoint>/api/control`, subprotocol `rex.control.v1`. The client is in `src/rex/control.ts`.
- Rex servers identify clients by their Tailscale login. Thus rex-mcp must run on a device in your tailnet, logged in as the user that owns the Rex servers. There is no token in the Rex protocol.
- rex-mcp finds your Rex servers with `tailscale status`. A Rex server with built-in Tailscale shows on the tailnet as `<machine>-rex`.
- The public endpoint uses OAuth 2.1 with PKCE and dynamic client registration, as Claude custom connectors expect. You approve each new client on an approval page with your owner secret.
- The pane status comes from the programs in the pane (OSC 7501). Claude Code reports `working`, `done` and `blocked`.

## Requirements

- Rex servers with Tailscale, all in one tailnet.
- Node.js 22 or newer, or Docker.
- A host in the same tailnet that is logged in as the owner of the Rex servers. Do not use a tagged device, because a tagged device has no user identity.
- For a public endpoint: a domain and a reverse proxy with TLS, such as Coolify, Caddy or a Cloudflare Tunnel.

## Install and build

```sh
npm ci
npm run build
```

## Configuration

rex-mcp reads environment variables and an optional JSON file. The environment variables override the file.

| Variable | Meaning | Default |
| - | - | - |
| `REX_MCP_PUBLIC_URL` | The public URL, such as `https://mcp.example.com`. Turns on OAuth. | none |
| `REX_MCP_OWNER_SECRET` | The secret that the OAuth approval page asks for. At least 16 characters. | none (required with `REX_MCP_PUBLIC_URL`) |
| `REX_MCP_STATE_DIR` | Where OAuth clients and token hashes are kept. | `./state` |
| `REX_MCP_TOKEN` | Optional static token for the path or a Bearer header. At least 32 characters from `A-Z a-z 0-9 _ -`. | none |
| `REX_MCP_SERVERS` | Fixed servers as `name=endpoint,name=endpoint`. | none |
| `REX_MCP_DISCOVER` | `1` adds each tailnet device with a name that ends with the suffix. | on when no servers are configured |
| `REX_MCP_DISCOVER_SUFFIX` | The device name suffix of Rex servers. | `-rex` |
| `REX_MCP_SOCKS_PROXY` | A SOCKS5 proxy for Rex connections, such as `socks5h://127.0.0.1:1055` for `tailscaled` in userspace mode. | none |
| `REX_MCP_TRUST_PROXY` | Which reverse proxies to trust for client IPs (the Express "trust proxy" setting). | `loopback` |
| `REX_MCP_CLIENT_LABEL` | The client name that Rex shows. | `rex-mcp@<hostname>` |
| `REX_MCP_CONFIG` | A JSON file. See `rex-mcp.example.json`. | `./rex-mcp.json` if it exists |
| `REX_MCP_HOST`, `REX_MCP_PORT` | The listen address. | `127.0.0.1`, `8787` |

Discovery names each server by its device name without the suffix. For example, `laptop-rex` becomes `laptop`. A device that Tailscale shows as offline is reported offline at once, without a connection attempt.

An endpoint is `https://<machine>-rex.<tailnet>.ts.net`, `unix:///run/user/<uid>/rex/server.sock`, or `http://127.0.0.1:<port>`.

## Run

```sh
node dist/main.js token                       # make a secret or a token
REX_MCP_PUBLIC_URL=https://mcp.example.com REX_MCP_OWNER_SECRET=... node dist/main.js serve
REX_MCP_TOKEN=... node dist/main.js serve     # static token only, for tests
node dist/main.js stdio                       # stdio, for a local MCP client
```

To use rex-mcp from Claude Code on a machine in the tailnet, you do not need the HTTP endpoint:

```sh
claude mcp add rex -- node /path/to/rex-mcp/dist/main.js stdio
```

With OAuth on, the HTTP endpoint serves these paths:

- `/mcp` with an OAuth access token (`Authorization: Bearer`). A request without a valid token gets `401` with a link to the metadata.
- `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` (metadata).
- `/register`, `/authorize`, `/token` and `/revoke` (the OAuth flow), and `/oauth/approve` (the approval form).
- `/<token>/mcp`, and the static token as a Bearer token on `/mcp`, only if `REX_MCP_TOKEN` is set.
- `/healthz` (no token, gives `ok`).

All other requests get `404`.

The OAuth flow:

1. The client registers itself and opens `/authorize`.
2. The approval page shows the client name and the host of the redirect. Make sure that you started this connection. Give the owner secret and click Approve.
3. The client gets an access token (valid for 1 hour) and a refresh token (valid for 30 days, new at each use).

After 5 wrong secrets, the approval request stops. rex-mcp keeps only SHA-256 hashes of tokens, in `REX_MCP_STATE_DIR/oauth.json` with mode 600.

## Tools

| Tool | Kind | Purpose |
| - | - | - |
| `list_servers` | read | The known servers, online status, Rex API revision and session count. |
| `get_overview` | read | The tree of sessions > tabs > panes, with process, working directory, title and status of each pane. `activity_only` shows only panes with a status that is not idle. |
| `read_pane` | read | The last N lines of a pane's screen and scrollback. |
| `send_input` | control | Paste text, then press keys such as `enter`, `esc`, `ctrl+c`, `shift+tab`, `up`. `submit` presses Enter at the end. |
| `create_session` | control | A session with one tab and one shell. Optional label, working directory and start command. |
| `create_tab` | control | A tab in a session. Optional label, working directory and start command. |
| `create_pane` | control | A pane in a tab. rex-mcp splits the largest pane along its longer side. Optional label, working directory and start command. |
| `close_session`, `close_tab`, `close_pane` | destructive | Close the item and stop its programs. |
| `rename` | control | Set the label of a session, a tab or a pane. |

Address a session by its label or short id. Address a tab or a pane by a 1-based number, a label or a short id. The short id is the last 6 hex digits of the id, as `rex ls` shows it. If you omit the tab, rex-mcp uses the active tab. If you omit the pane, rex-mcp uses the focused pane.

A start command goes into an interactive shell as typed input. Thus the pane stays open when the command ends.

A `blocked` pane waits for an answer. Its `waiting_for` field tells if it is a `permission`, a `question` or `auth`.

## Deployment with Docker

The image runs `tailscaled` in userspace mode, so the container needs no extra privileges. rex-mcp reaches the Rex servers through the SOCKS5 proxy of `tailscaled`. The container is its own device on the tailnet, named `rex-mcp` by default (`TS_HOSTNAME`).

1. Make an owner secret with `node dist/main.js token`, or with `openssl rand -base64 32`.
2. Start the container with two volumes and your public URL:

   ```sh
   docker compose up -d --build
   ```

   `docker-compose.yaml` reads `REX_MCP_PUBLIC_URL`, `REX_MCP_OWNER_SECRET` and the optional `TS_AUTHKEY` from the environment or from a `.env` file.
3. On the first start, the log shows a Tailscale login URL. Open it and log in as the owner of the Rex servers. As an alternative, set `TS_AUTHKEY` to an auth key without tags.
4. In the Tailscale admin console, select **Disable key expiry** for the device `rex-mcp`. If the key expires, the container loses access to all Rex servers.
5. Put a reverse proxy with TLS in front of port `8787`, for your domain.

Keep the volumes `/var/lib/tailscale` (the Tailscale identity) and `/data` (the OAuth state). Without them, each new container needs a new Tailscale login, and all clients must connect again.

### Coolify

1. Create an application from your fork of this repository with the Dockerfile build pack. Use port `8787` and your domain.
2. Add persistent storage for `/var/lib/tailscale` and `/data`. Older Coolify versions can do this only in the web interface.
3. Set `REX_MCP_PUBLIC_URL` and `REX_MCP_OWNER_SECRET`. The image sets the other variables.
4. Make sure that the DNS record of your domain points to the Coolify host before the first deployment. If the proxy shows its default certificate, restart the application after the DNS record works. Then the proxy asks for the certificate again.
5. Do steps 3 and 4 of the Docker procedure.

## Deployment with systemd

1. Install Node.js 22 or newer and Tailscale. Log in to Tailscale as the owner of the Rex servers.
2. Make a system user, and copy the project to `/opt/rex-mcp`:

   ```sh
   sudo useradd --system --home /opt/rex-mcp --shell /usr/sbin/nologin rexmcp
   sudo mkdir -p /opt/rex-mcp /etc/rex-mcp
   sudo cp -r dist package.json package-lock.json /opt/rex-mcp/
   cd /opt/rex-mcp && sudo npm ci --omit=dev
   ```

3. Make the environment file from `deploy/env.example`. Put a new owner secret in it:

   ```sh
   sudo cp deploy/env.example /etc/rex-mcp/env
   node /opt/rex-mcp/dist/main.js token
   sudo chmod 600 /etc/rex-mcp/env && sudo chown rexmcp /etc/rex-mcp/env
   ```

4. Install and start the service:

   ```sh
   sudo cp deploy/rex-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now rex-mcp
   ```

5. Make the public endpoint. With a Cloudflare Tunnel, the host opens no inbound ports:

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create rex-mcp
   cloudflared tunnel route dns rex-mcp mcp.example.com
   sudo cp deploy/cloudflared.yml /etc/cloudflared/config.yml
   sudo cloudflared service install
   ```

   Change the hostname and `credentials-file` in the config to your values.

## Test and connect

1. Do a test of the endpoint. The second command must give `401`:

   ```sh
   curl -s https://mcp.example.com/healthz
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp
   ```

2. In Claude, open **Settings** > **Connectors** and add a custom connector with the URL `https://mcp.example.com/mcp`.
3. Claude opens the approval page. Give the owner secret and click **Approve**.
4. In Claude, ask for `list_servers`. All online Rex servers must show `"online": true`.

To remove the access of all clients, stop rex-mcp, delete `oauth.json` in the state directory, and start rex-mcp. To change the owner secret, change `REX_MCP_OWNER_SECRET` and restart rex-mcp.

## Security

- Use OAuth for real use. Leave `REX_MCP_TOKEN` empty, because a static token in a URL can show in logs and in browser history.
- Use a long random owner secret. The secret is the only barrier between the internet and your terminals.
- Dynamic client registration is open, but a client gets no token until you approve it with the owner secret.
- Approve only connections that you started yourself. The approval page shows where the client sends you back.
- Secret and token comparisons take constant time. The log does not contain secrets or tokens.
- rex-mcp binds to `127.0.0.1` by default. The Docker image binds to `0.0.0.0` inside the container, so that the reverse proxy can reach it.
- Cloudflare Access in front of the endpoint can add a second layer, but Claude connectors cannot do interactive Access logins.

## Development

```sh
npm run typecheck
npm test                 # unit tests with a fake Rex server
npm run test:live        # creates and closes its own session on the local Rex server
```

`src/rex/control.ts` is the Rex control client. `src/rex/service.ts` has the operations behind the tools. `src/tools.ts` defines the MCP tools. `src/http.ts` is the HTTP endpoint. `src/oauth.ts` is the OAuth provider.

## License

MIT. See `LICENSE`.

rex-mcp is not a product of Superlogical. Rex is a product of Superlogical.
