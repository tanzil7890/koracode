import { afterAll, expect, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Effect } from "effect";
import { BrowserExecute } from "../src/browser-execute";
import { SessionStore } from "../src/session-store";

let connections = 0;
let closedConnections = 0;
let attachedCalls = 0;
let pageCallsWithSession = 0;
let latestSocket: { close(): void } | undefined;
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    return srv.upgrade(req)
      ? undefined
      : new Response("upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      connections++;
      latestSocket = ws;
    },
    message(ws, message) {
      const request: unknown = JSON.parse(String(message));
      if (
        !request ||
        typeof request !== "object" ||
        !("id" in request) ||
        typeof request.id !== "number" ||
        !("method" in request) ||
        typeof request.method !== "string"
      )
        return;
      if (
        request.method === "Page.navigate" &&
        "params" in request &&
        request.params &&
        typeof request.params === "object" &&
        "url" in request.params &&
        request.params.url === "https://stuck.example"
      ) {
        pageCallsWithSession++;
        setTimeout(() => ws.send(JSON.stringify({ id: request.id, result: {} })), 40);
        return;
      }
      const result = (() => {
        if (request.method === "Target.getTargets")
          return {
            targetInfos: [
              {
                targetId: "page-1",
                type: "page",
                title: "",
                url: "about:blank",
                attached: false,
                canAccessOpener: false,
              },
            ],
          };
        if (request.method === "Target.attachToTarget") {
          attachedCalls++;
          return { sessionId: "page-session-1" };
        }
        if (request.method.startsWith("Page.") && "sessionId" in request)
          pageCallsWithSession++;
        return {};
      })();
      ws.send(JSON.stringify({ id: request.id, result }));
    },
    close() {
      closedConnections++;
    },
  },
});

const failingServer = Bun.serve({
  port: 0,
  fetch() {
    return new Response("unavailable", { status: 503 });
  },
});

afterAll(() => {
  server.stop(true);
  failingServer.stop(true);
});

const wsUrl = `ws://127.0.0.1:${server.port}/`;

const withEnv = async <T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> => {
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  Object.entries(vars).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    return await fn();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
};

const withBrowserExecute = async (
  name: string,
  fn: (
    impl: Effect.Success<ReturnType<typeof BrowserExecute.make>>,
    sessionID: string,
    workspaceDir: string,
  ) => Promise<void>,
) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `bcode-auto-data-${name}-`),
  );
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `bcode-auto-ws-${name}-`),
  );
  const sessionID = `auto-connect-${name}-${Math.random().toString(36).slice(2)}`;
  try {
    const impl = await Effect.runPromise(
      Effect.scoped(BrowserExecute.make(dataDir)),
    );
    await fn(impl, sessionID, workspaceDir);
  } finally {
    await SessionStore.evict(sessionID);
    await Promise.all(
      [dataDir, workspaceDir].map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
  }
};

test("V4 endpoint auto-connects, attaches, and reuses one connection", async () => {
  connections = 0;
  attachedCalls = 0;
  pageCallsWithSession = 0;
  await withEnv(
    { V4_RUN_ID: "run-reuse", BU_CDP_WS: wsUrl, BU_CDP_URL: undefined },
    () =>
      withBrowserExecute("reuse", async (impl, sessionID, workspaceDir) => {
        const run = (code: string) =>
          Effect.runPromise(
            impl.execute(
              { description: "List browser targets", code },
              { sessionID, workspaceDir },
            ),
          );

        expect(
          JSON.parse(
            (
              await run(
                "return await session.Page.navigate({ url: 'https://sap.com' })",
              )
            ).result,
          ),
        ).toEqual({});
        expect(
          JSON.parse(
            (
              await run(
                "await session.connect(); return (await session.Target.getTargets({})).targetInfos.length",
              )
            ).result,
          ),
        ).toBe(1);
        expect(connections).toBe(1);
        expect(attachedCalls).toBe(1);
        expect(pageCallsWithSession).toBe(1);
      }),
  );
});

test("parallel first calls share one connection attempt", async () => {
  connections = 0;
  attachedCalls = 0;
  await withEnv(
    { V4_RUN_ID: "run-race", BU_CDP_WS: wsUrl, BU_CDP_URL: undefined },
    () =>
      withBrowserExecute("race", async (impl, sessionID, workspaceDir) => {
        const run = () =>
          Effect.runPromise(
            impl.execute(
              {
                description: "Read target count",
                code: "return (await session.Target.getTargets({})).targetInfos.length",
              },
              { sessionID, workspaceDir },
            ),
          );

        expect(
          (await Promise.all([run(), run()])).map((result) =>
            JSON.parse(result.result),
          ),
        ).toEqual([1, 1]);
        expect(connections).toBe(1);
        expect(attachedCalls).toBe(1);
      }),
  );
});

test("a dropped socket is surfaced instead of reconnecting the run-start browser", async () => {
  connections = 0;
  closedConnections = 0;
  attachedCalls = 0;
  await withEnv(
    { V4_RUN_ID: "run-dropped", BU_CDP_WS: wsUrl, BU_CDP_URL: undefined },
    () =>
      withBrowserExecute("dropped", async (impl, sessionID, workspaceDir) => {
        const run = () =>
          Effect.runPromise(
            impl.execute(
              {
                description: "Navigate existing page",
                code: "return await session.Page.navigate({ url: 'https://sap.com' })",
              },
              { sessionID, workspaceDir },
            ),
          );

        await run();
        latestSocket?.close();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await expect(run()).rejects.toThrow(
          "Not connected. Call session.connect(...) first.",
        );

        expect(connections).toBe(1);
        expect(closedConnections).toBe(1);
        expect(attachedCalls).toBe(1);
      }),
  );
});

test("an explicit browser switch retires the old socket and target attachment", async () => {
  connections = 0;
  closedConnections = 0;
  attachedCalls = 0;
  pageCallsWithSession = 0;
  await withEnv(
    { V4_RUN_ID: "run-switch", BU_CDP_WS: wsUrl, BU_CDP_URL: undefined },
    () =>
      withBrowserExecute("switch", async (impl, sessionID, workspaceDir) => {
        const run = (code: string) =>
          Effect.runPromise(
            impl.execute(
              { description: "Switch provisioned browsers", code },
              { sessionID, workspaceDir },
            ),
          );

        await run(
          "return await session.Page.navigate({ url: 'https://sap.com' })",
        );
        const switched = await run(`
          await session.connect({ wsUrl: ${JSON.stringify(wsUrl)} })
          await session.Page.navigate({ url: "https://example.com" })
          return { activeSession: session.getActiveSession() ?? null }
        `);
        expect(JSON.parse(switched.result)).toEqual({ activeSession: null });

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(connections).toBe(2);
        expect(closedConnections).toBe(1);
        expect(attachedCalls).toBe(1);
        expect(pageCallsWithSession).toBe(1);

        await run(`
          const page = (await session.Target.getTargets({})).targetInfos[0]
          await session.use(page.targetId)
          return await session.Page.navigate({ url: "https://example.com" })
        `);
        expect(attachedCalls).toBe(2);
        expect(pageCallsWithSession).toBe(2);
      }),
  );
});

test("a timeout preserves the same browser and target", async () => {
  connections = 0;
  attachedCalls = 0;
  pageCallsWithSession = 0;
  await withEnv(
    { V4_RUN_ID: "run-timeout", BU_CDP_WS: wsUrl, BU_CDP_URL: undefined },
    () =>
      withBrowserExecute("timeout", async (impl, sessionID, workspaceDir) => {
        await expect(
          Effect.runPromise(
            impl.execute(
              {
                description: "Time out after initial V4 bootstrap",
                code: `
                  await session.Page.navigate({ url: "https://stuck.example" })
                  try { await session.Page.navigate({ url: "https://too-late.example" }) } catch {}
                `,
                timeout: 10,
              },
              { sessionID, workspaceDir },
            ),
          ),
        ).rejects.toThrow("browser_execute timed out");

        const recovered = await Effect.runPromise(
          impl.execute(
            {
              description: "Continue on the same browser",
              code: "return await session.Page.navigate({ url: 'https://sap.com' })",
            },
            { sessionID, workspaceDir },
          ),
        );
        expect(JSON.parse(recovered.result)).toEqual({});
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(connections).toBe(1);
        expect(attachedCalls).toBe(1);
        expect(pageCallsWithSession).toBe(2);
      }),
  );
});

test("sessions without a provisioned endpoint still require connect", async () => {
  await withEnv(
    { V4_RUN_ID: undefined, BU_CDP_WS: undefined, BU_CDP_URL: undefined },
    () =>
      withBrowserExecute("local", async (impl, sessionID, workspaceDir) => {
        await expect(
          Effect.runPromise(
            impl.execute(
              {
                description: "Call CDP without connect",
                code: "return await session.Target.getTargets({})",
              },
              { sessionID, workspaceDir },
            ),
          ),
        ).rejects.toThrow("Not connected. Call session.connect(...) first.");
      }),
  );
});

test("eval endpoints remain explicit without V4_RUN_ID", async () => {
  connections = 0;
  await withEnv(
    { V4_RUN_ID: undefined, BU_CDP_WS: wsUrl, BU_CDP_URL: undefined },
    () =>
      withBrowserExecute("eval", async (impl, sessionID, workspaceDir) => {
        await expect(
          Effect.runPromise(
            impl.execute(
              {
                description: "Call CDP without explicit eval connect",
                code: "return await session.Target.getTargets({})",
              },
              { sessionID, workspaceDir },
            ),
          ),
        ).rejects.toThrow("Not connected. Call session.connect(...) first.");
        expect(connections).toBe(0);
      }),
  );
});

test("a failed V4 bootstrap does not block an explicit replacement browser", async () => {
  await withEnv(
    {
      V4_RUN_ID: "run-replacement",
      BU_CDP_WS: `ws://127.0.0.1:${failingServer.port}/`,
      BU_CDP_URL: undefined,
    },
    () =>
      withBrowserExecute("failure", async (impl, sessionID, workspaceDir) => {
        const failure = Effect.runPromise(
          impl.execute(
            {
              description: "Do not run snippet",
              code: 'throw new Error("snippet should not run")',
            },
            { sessionID, workspaceDir },
          ),
        );

        await expect(failure).rejects.toThrow(/WS error|WS closed before open/);
        await expect(failure).rejects.not.toThrow(
          "browser_execute snippet threw",
        );
        await expect(failure).rejects.not.toThrow("snippet should not run");

        const recovered = await Effect.runPromise(
          impl.execute(
            {
              description: "Connect a replacement browser",
              code: `
                await session.connect({ wsUrl: ${JSON.stringify(wsUrl)} })
                const page = (await session.Target.getTargets({})).targetInfos[0]
                await session.use(page.targetId)
                return await session.Page.navigate({ url: "https://sap.com" })
              `,
            },
            { sessionID, workspaceDir },
          ),
        );
        expect(JSON.parse(recovered.result)).toEqual({});
      }),
  );
});
