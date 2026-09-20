import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};
export async function startFixtureServer({ port = 0 } = {}) {
  const source = JSON.parse(
    await readFile(join(root, "tests/fixtures/workspace-v1.json"), "utf8"),
  );
  let data = structuredClone(source),
    next = 15,
    connected = true,
    failNextTurn = false;
  const clients = new Set(),
    sockets = new Set(),
    requests = [],
    controls = [];
  const state = () => {
    const { projects, ...rest } = data;
    return rest;
  };
  const publish = () => {
    for (const client of clients)
      client.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
  };
  const session = (id) => {
    const found = data.sessions.find((s) => s.id === id);
    if (!found) throw Error(`Unknown fixture session ${id}`);
    return found;
  };
  const create = ({
    projectId = "demo",
    laneId = "lane-b",
    provider = "codex",
  }) => {
    const number = next++;
    const created = {
      schemaVersion: 1,
      id: `workspace-${number}`,
      sessionNumber: number,
      nativeSessionId: `${provider}-native-${number}`,
      providerThreadId:
        provider === "codex" ? `codex-native-${number}` : undefined,
      provider,
      projectId,
      laneId,
      laneName: laneId,
      cwd:
        projectId === "demo" ? "/fixtures/workspace-b" : "/fixtures/checks-a",
      title: "Untitled agent",
      objective: "",
      executionState: "draft",
      proofState: "unverified",
      revision: 0,
      items: [],
      status: "idle",
    };
    data.sessions.push(created);
    return created;
  };
  const controller = (text, clientId, via) => {
    const assistant = session("controller");
    let selected;
    if (text === "Create fixture agent") {
      selected = create({});
      selected.title = "Fixture controller objective";
      selected.objective = "Compare typed and simulated voice control.";
      selected.executionState = "running";
      selected.activeTurn = `turn-${selected.id}`;
    } else if (/^Open agent \d+$/.test(text))
      selected = data.sessions.find(
        (s) => s.sessionNumber === Number(text.match(/\d+$/)[0]),
      );
    else
      throw Error(
        "Fixture command supports only Create fixture agent or Open agent N.",
      );
    if (!selected) throw Error("Fixture agent not found");
    const reply = `Opened #${selected.sessionNumber}: ${selected.title}`;
    assistant.items.push({ type: "agentMessage", text: reply });
    if (via === "voice")
      assistant.voiceHistory.push({
        id: `voice-${controls.length}`,
        role: "assistant",
        text: reply,
      });
    assistant.workspaceActions.push({
      callId: `presentation-${controls.length}`,
      clientId,
      status: "completed",
      createdAt: new Date().toISOString(),
      result: {
        state: "navigation_requested",
        type: "session",
        sessionId: selected.id,
        mode: "agent",
      },
    });
    controls.push({
      via,
      text,
      sessionId: selected.id,
      nativeSessionId: selected.nativeSessionId,
    });
    publish();
    return selected;
  };
  const send = (res, code, result) => {
    res.writeHead(code, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(result));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;
      if (path === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write("retry: 250\n\n");
        if (connected) {
          res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
          clients.add(res);
          req.on("close", () => clients.delete(res));
        } else res.end();
        return;
      }
      if (req.method === "GET" && path === "/api/state")
        return send(res, 200, state());
      if (req.method === "GET" && path === "/api/projects")
        return send(res, 200, { projects: data.projects });
      if (req.method === "GET" && /^\/api\/projects\/[^/]+\/lanes$/.test(path))
        return send(res, 200, {
          lanes: [
            {
              id: path.includes("checks") ? "lane-a" : "lane-b",
              name: path.includes("checks") ? "lane-a" : "lane-b",
              path: path.includes("checks")
                ? "/fixtures/checks-a"
                : "/fixtures/workspace-b",
              isCurrent: true,
            },
          ],
        });
      if (req.method === "GET" && path === "/api/voice/status")
        return send(res, 200, {
          configured: true,
          model: "fixture-live",
          reason: "Fixture voice transport. No provider connection or charge.",
        });
      if (["POST", "PATCH"].includes(req.method)) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        requests.push({ method: req.method, path, body });
        let result = { ok: true };
        let match;
        if (path === "/api/sessions") result = create(body);
        else if (
          (match = path.match(/^\/api\/sessions\/([^/]+)$/)) &&
          req.method === "PATCH"
        ) {
          result = session(match[1]);
          result.title = body.title;
        } else if (
          (match = path.match(
            /^\/api\/sessions\/([^/]+)\/(turn|steer|stop|resume)$/,
          ))
        ) {
          result = session(match[1]);
          const action = match[2];
          if (failNextTurn && (action === "turn" || action === "steer")) {
            failNextTurn = false;
            return send(res, 409, {
              error: "Fixture rejected turn; source session remains intact.",
            });
          }
          if (result.id === "controller")
            result = controller(body.text, body.clientId, "typed");
          else if (action === "stop") {
            result.executionState = "stopping";
          } else if (action === "resume") {
            result.executionState = "waiting";
          } else {
            result.objective ||= body.text;
            result.items.push({ type: "userMessage", text: body.text });
            result.executionState = "running";
            result.activeTurn = `turn-${result.id}`;
          }
        } else if (path === "/api/workspace/ack") {
          const action = session("controller").workspaceActions.find(
            (a) => a.callId === body.callId,
          );
          if (action)
            action.presentationAck = {
              state: body.error ? "failed" : "presented",
            };
        } else if (path === "/api/assistant") result = session("controller");
        else if (path.startsWith("/api/approvals/"))
          data.approvals = data.approvals.filter(
            (a) => a.id !== path.split("/").at(-1),
          );
        else return send(res, 404, { error: "Unknown fixture API" });
        publish();
        return send(res, 200, result);
      }
      if (path.startsWith("/api/"))
        return send(res, 404, { error: "Unknown fixture API" });
      if (path === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      const file = resolve(
        root,
        "dist",
        `.${path === "/" ? "/index.html" : decodeURIComponent(path)}`,
      );
      if (!file.startsWith(join(root, "dist") + sep))
        return send(res, 403, { error: "Invalid path" });
      await stat(file);
      res.writeHead(200, {
        "content-type": mime[extname(file)] || "application/octet-stream",
      });
      res.end(await readFile(file));
    } catch (error) {
      send(res, 500, { error: error.message });
    }
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (
      !req.url.startsWith("/api/terminal") &&
      !req.url.startsWith("/api/voice")
    )
      return socket.destroy();
    ws.handleUpgrade(req, socket, head, (client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      if (req.url.startsWith("/api/voice")) {
        client.send(JSON.stringify({ type: "voice.ready" }));
        return;
      }
      client.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "open")
          client.send(
            JSON.stringify({
              type: "replay",
              cols: 90,
              rows: 18,
              chunks: [
                {
                  data: "Saved fixture output\r\nworkspace-12 → codex-native-12\r\nBuild passed. Interaction proof is unverified.\r\n",
                },
              ],
            }),
          );
        if (message.type === "claim")
          client.send(
            JSON.stringify({
              type: "owner",
              claimedByYou: true,
              cols: 90,
              rows: 18,
            }),
          );
      });
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    controls,
    state,
    simulateVoice(text, clientId) {
      return controller(text, clientId, "voice");
    },
    failTurn() {
      failNextTurn = true;
    },
    disconnect() {
      connected = false;
      for (const client of clients) client.end();
      clients.clear();
    },
    reconnect() {
      connected = true;
    },
    update(id, values) {
      Object.assign(session(id), values);
      publish();
    },
    async close() {
      for (const client of clients) client.end();
      for (const socket of sockets) socket.terminate();
      ws.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const server = await startFixtureServer({
    port: Number(process.env.PORT || 4319),
  });
  console.log(
    `Stage 1 fixture preview: ${server.url}. No real provider or user data is connected.`,
  );
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}
