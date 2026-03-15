const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { writePool, readPool, connectWithRetry, initSchema, query, readQuery } = require("./db");
const logger = require("./logger");
const itemsRouter = require("./routes/items");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.use((req, res, next) => {
  req.traceId = req.headers["x-trace-id"] || uuidv4();
  res.setHeader("X-Trace-ID", req.traceId);
  logger.info("Request received", { traceId: req.traceId, method: req.method, path: req.path, ip: req.ip });
  next();
});

app.get("/health", async (req, res) => {
  const { traceId } = req;
  const result = { traceId, write: "error", read: "error" };

  try {
    await query("SELECT 1", [], traceId);
    result.write = "connected";
  } catch (err) {
    result.writeError = err.message;
  }

  try {
    await readQuery("SELECT 1", [], traceId);
    result.read = "connected";
  } catch (err) {
    result.readError = err.message;
  }

  const status = result.write === "connected" ? "ok" : "degraded";
  logger.info("Health check", { traceId, status, write: result.write, read: result.read });
  res.status(result.write === "connected" ? 200 : 503).json({ status, ...result });
});

app.get("/", (req, res) => {
  res.json({ service: "paas-api", version: "1.0.0", env: process.env.ENV || "development", traceId: req.traceId });
});

app.use("/items", itemsRouter);

async function start() {
  logger.info("Starting API server", { port: PORT, env: process.env.ENV || "development" });

  await connectWithRetry(writePool, "write");

  // Read pool is optional — falls back to write pool if replica isn't ready
  await connectWithRetry(readPool, "read").catch((err) => {
    logger.warn("Read pool unavailable at startup — reads will fall back to write pool", { error: err.message });
  });

  await initSchema();
  const server = app.listen(PORT, () => logger.info("API listening", { port: PORT }));

  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received — draining connections");
    server.close();
    await writePool.end();
    await readPool.end();
    process.exit(0);
  });
}

start().catch((err) => {
  logger.error("Fatal startup error", { error: err.message });
  process.exit(1);
});
