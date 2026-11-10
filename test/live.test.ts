import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ServerPool } from "../src/rex/pool.js";
import { RexService } from "../src/rex/service.js";

const live = process.env.REX_LIVE === "1";

describe.skipIf(!live)("live Rex server", () => {
  it("creates, drives, renames and closes its own session", async () => {
    const pool = new ServerPool({ servers: [{ name: "local", endpoint: "unix:///run/user/0/rex/server.sock" }] });
    const svc = new RexService(pool);
    const rand = randomBytes(4).toString("hex");
    const label = `rex-mcp-live-${rand}`;
    const marker = `marker-${rand}`;
    let sessionId: string | undefined;
    try {
      const created = await svc.createSession("local", { label });
      sessionId = created.session_id;
      const ref = { server: "local", session: sessionId };

      await svc.createTab(ref, { label: "second" });
      await svc.createPane({ ...ref, tab: 1 }, { label: "extra" });

      const [ov] = await svc.overview({ server: "local", session: sessionId });
      const info = ov!.sessions![0]!;
      expect(info.label).toBe(label);
      expect(info.tabs).toHaveLength(2);
      expect(info.tabs[0]!.panes).toHaveLength(2);

      await sleep(500);
      await svc.sendInput({ ...ref, tab: 1, pane: 1 }, { text: `echo ${marker}`, submit: true });

      let text = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        text = (await svc.readPane({ ...ref, tab: 1, pane: 1 }, 50)).text;
        if (text.includes(marker)) break;
        await sleep(250);
      }
      expect(text).toContain(marker);

      await svc.rename(ref, "tab", "renamed-tab");
      await svc.rename({ ...ref, tab: 1, pane: 2 }, "pane", "renamed-pane");
      const renamed = `${label}-renamed`;
      await svc.rename(ref, "session", renamed);
      const [after] = await svc.overview({ server: "local", session: sessionId });
      expect(after!.sessions![0]!.label).toBe(renamed);
      expect(after!.sessions![0]!.tabs[0]!.label).toBe("renamed-tab");
      expect(after!.sessions![0]!.tabs[0]!.panes[1]!.label).toBe("renamed-pane");
    } finally {
      if (sessionId) await svc.closeSession({ server: "local", session: sessionId });
      pool.close();
    }
  });
});
