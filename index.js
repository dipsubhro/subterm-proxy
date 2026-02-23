import "dotenv/config";

import http from "http";
import express from "express";
import httpProxy from "http-proxy";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
redis.on("connect", () => console.log("[router] Connected to Redis"));
redis.on("error", (err) => console.error("[router] Redis error:", err.message));

const SESSION_KEY = (id) => `session:${id}`;

async function getSession(sessionId) {
  const raw = await redis.get(SESSION_KEY(sessionId));
  return raw ? JSON.parse(raw) : null;
}

// Fire-and-forget — update lastActive without blocking the request
function touchSession(sessionId) {
  redis
    .get(SESSION_KEY(sessionId))
    .then((raw) => {
      if (!raw) return;
      const session = JSON.parse(raw);
      session.lastActive = Date.now();
      return redis.set(SESSION_KEY(sessionId), JSON.stringify(session));
    })
    .catch((err) => console.error("[router] touchSession error:", err.message));
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------
const proxy = httpProxy.createProxyServer({ ws: true });

proxy.on("error", (err, req, res) => {
  console.error("[router] Proxy error:", err.message);
  // res may be a ServerResponse (HTTP) or a Socket (WS) — only write headers for HTTP
  if (res && typeof res.writeHead === "function" && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway", detail: err.message }));
  }
});

// ---------------------------------------------------------------------------
// Express (HTTP traffic)
// ---------------------------------------------------------------------------
const app = express();

// app.use strips the mount prefix from req.url, so inside the handler
// req.url is already the bare path the container should see.
app.use("/workspace/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  let session;
  try {
    session = await getSession(sessionId);
  } catch (err) {
    console.error("[router] Redis lookup failed:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const target = `http://${session.containerName}:3000`;

  touchSession(sessionId); // refresh inactivity timer

  console.log(
    `[router] HTTP  ${req.method} /workspace/${sessionId}${req.url} → ${target}`,
  );

  proxy.web(req, res, { target });
});

// ---------------------------------------------------------------------------
// HTTP server (needed to intercept WebSocket upgrades)
// ---------------------------------------------------------------------------
const server = http.createServer(app);

// WebSocket upgrade — bypasses Express routing so we parse the URL manually
server.on("upgrade", async (req, socket, head) => {
  const match = req.url?.match(/^\/workspace\/([^/?#]+)(\/.*)?$/);

  if (!match) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const [, sessionId, rest = "/"] = match;

  let session;
  try {
    session = await getSession(sessionId);
  } catch {
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const target = `http://${session.containerName}:3000`;

  touchSession(sessionId); // refresh inactivity timer

  // Rewrite the URL to the bare path so the container sees e.g. /terminal
  req.url = rest;

  console.log(
    `[router] WS    UPGRADE /workspace/${sessionId}${rest} → ${target}`,
  );

  proxy.ws(req, socket, head, { target });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
async function shutdown() {
  console.log("[router] Shutting down...");
  await redis.quit();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5500;
server.listen(PORT, () =>
  console.log(`[router] Listening on http://0.0.0.0:${PORT}`),
);
