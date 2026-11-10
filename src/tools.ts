import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errText } from "./rex/pool.js";
import type { RexService } from "./rex/service.js";

export const SERVER_INFO = { name: "rex-mcp", version: "0.1.0" };

const INSTRUCTIONS = `This server gives status and control of Superlogical Rex terminal servers.
The hierarchy is server > session > tab > pane. Coding agents run in panes.
Start with get_overview. Use activity_only=true to see only panes that report a status (working, blocked, done, error).
A pane in state "blocked" waits for input. Use read_pane to see its screen, then send_input to answer.
Address a session by its label or short id. Address a tab or a pane by its 1-based number, label, or short id.
If you omit the tab, the active tab is used. If you omit the pane, the focused pane is used.`;

const ref = {
  server: z.string().describe("The server name, as list_servers shows it."),
  session: z.string().describe("The session label or short id."),
};
const tab = z.union([z.string(), z.number().int()]).describe("The tab: a 1-based number, a label, or a short id. Omit it for the active tab.");
const pane = z.union([z.string(), z.number().int()]).describe("The pane: a 1-based number in the tab, a label, or a short id. Omit it for the focused pane.");
const startOpts = {
  label: z.string().max(128).optional().describe("A label for the new item. Use the project name."),
  cwd: z.string().optional().describe("The working directory on the server's machine. The default is the home directory."),
  command: z.string().optional().describe("A command to type into the new shell, such as \"claude\". The shell stays open after the command ends."),
};

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: errText(e) }] };
    }
  };
}

export function createMcpServer(rex: RexService): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_servers",
    {
      title: "List Rex servers",
      description: "List the Rex servers that this MCP server knows, with their online status, Rex version, and number of sessions.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async () => {
      const servers = await rex.listServers();
      const err = rex.discoveryError;
      return err ? { servers, discovery_error: err } : { servers };
    }),
  );

  server.registerTool(
    "get_overview",
    {
      title: "Get the overview",
      description:
        "Get a tree of sessions > tabs > panes on all servers, or on one server. Each pane shows its process, working directory, title, and the status that its program reports: idle, working, done, blocked, or error. A blocked pane waits for input.",
      inputSchema: {
        server: z.string().optional().describe("Only this server. Omit it for all servers."),
        session: z.string().optional().describe("Only this session (label or short id). Requires server."),
        activity_only: z.boolean().optional().describe("Show only panes with a status that is not idle, and the tabs and sessions that hold them."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (a: { server?: string; session?: string; activity_only?: boolean }) => {
      if (a.session && !a.server) throw new Error("session requires server");
      return rex.overview({ server: a.server, session: a.session, activityOnly: a.activity_only });
    }),
  );

  server.registerTool(
    "read_pane",
    {
      title: "Read a pane",
      description: "Get the last lines of a pane's screen and scrollback as plain text.",
      inputSchema: { ...ref, tab: tab.optional(), pane: pane.optional(), lines: z.number().int().min(1).max(5000).optional().describe("The number of lines. The default is 80.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (a: { server: string; session: string; tab?: string | number; pane?: string | number; lines?: number }) => {
      const r = await rex.readPane(a, a.lines ?? 80);
      return { target: r.target, lines: r.lines, total_lines: r.total_lines, text: r.text };
    }),
  );

  server.registerTool(
    "send_input",
    {
      title: "Send input to a pane",
      description:
        'Send text and keys to a pane. The text goes first as a paste, then the keys in order. Key examples: "enter", "esc", "tab", "shift+tab", "up", "down", "ctrl+c", "ctrl+d", "y", "1", "f5". Set submit=true to press Enter after the text. To answer an agent prompt, send the text with submit=true.',
      inputSchema: {
        ...ref,
        tab: tab.optional(),
        pane: pane.optional(),
        text: z.string().max(100_000).optional().describe("The text to send."),
        keys: z.array(z.string()).max(100).optional().describe("Keys to press after the text, in order."),
        submit: z.boolean().optional().describe("Press Enter after the text and keys."),
        mode: z.enum(["paste", "type"]).optional().describe('"paste" (default) sends the text as one paste. "type" types it as raw terminal input, where "\\r" is Enter.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap(async (a: { server: string; session: string; tab?: string | number; pane?: string | number; text?: string; keys?: string[]; submit?: boolean; mode?: "paste" | "type" }) =>
      rex.sendInput(a, { text: a.text, keys: a.keys, submit: a.submit, mode: a.mode }),
    ),
  );

  server.registerTool(
    "create_session",
    {
      title: "Create a session",
      description: "Create a session on a server with one tab and one shell pane. Optionally start a command in the shell.",
      inputSchema: { server: ref.server, ...startOpts, tab_label: z.string().max(128).optional().describe("A label for the first tab.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap(async (a: { server: string; label?: string; cwd?: string; command?: string; tab_label?: string }) =>
      rex.createSession(a.server, { label: a.label, cwd: a.cwd, command: a.command, tabLabel: a.tab_label }),
    ),
  );

  server.registerTool(
    "create_tab",
    {
      title: "Create a tab",
      description: "Create a tab in a session with one shell pane. Optionally start a command in the shell. The new tab does not become active unless focus=true.",
      inputSchema: { ...ref, ...startOpts, focus: z.boolean().optional().describe("Make the new tab the active tab.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap(async (a: { server: string; session: string; label?: string; cwd?: string; command?: string; focus?: boolean }) => rex.createTab(a, a)),
  );

  server.registerTool(
    "create_pane",
    {
      title: "Create a pane",
      description: "Create a shell pane in a tab. The server splits the largest pane along its longer side. Optionally start a command in the shell.",
      inputSchema: { ...ref, tab: tab.optional(), ...startOpts },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    wrap(async (a: { server: string; session: string; tab?: string | number; label?: string; cwd?: string; command?: string }) => rex.createPane(a, a)),
  );

  server.registerTool(
    "close_session",
    {
      title: "Close a session",
      description: "Close a session and stop every program in it.",
      inputSchema: { ...ref },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    wrap(async (a: { server: string; session: string }) => rex.closeSession(a)),
  );

  server.registerTool(
    "close_tab",
    {
      title: "Close a tab",
      description: "Close a tab and stop every program in it.",
      inputSchema: { ...ref, tab: tab },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    wrap(async (a: { server: string; session: string; tab: string | number }) => rex.closeTab(a)),
  );

  server.registerTool(
    "close_pane",
    {
      title: "Close a pane",
      description: "Close a pane and stop the program in it. If it is the last pane in its tab, the tab closes too.",
      inputSchema: { ...ref, tab: tab.optional(), pane: pane },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    wrap(async (a: { server: string; session: string; tab?: string | number; pane: string | number }) => rex.closePane(a)),
  );

  server.registerTool(
    "rename",
    {
      title: "Rename a session, tab, or pane",
      description: "Set the label of a session, a tab, or a pane. Use labels to keep work organized by project.",
      inputSchema: {
        ...ref,
        target: z.enum(["session", "tab", "pane"]).describe("What to rename."),
        tab: tab.optional(),
        pane: pane.optional(),
        label: z.string().min(1).max(128).describe("The new label."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async (a: { server: string; session: string; target: "session" | "tab" | "pane"; tab?: string | number; pane?: string | number; label: string }) =>
      rex.rename(a, a.target, a.label),
    ),
  );

  return server;
}
