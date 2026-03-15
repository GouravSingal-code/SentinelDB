const { Pool } = require("pg");
const CircuitBreaker = require("opossum");
const logger = require("./logger");

function buildConnectionString(host) {
  // Skip DATABASE_URL if it contains un-substituted Omnistrate template vars ($var.)
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("$var.")) {
    return process.env.DATABASE_URL;
  }
  return `postgres://${process.env.DB_USER || "app"}:${process.env.DB_PASSWORD}@${host}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || "appdb"}`;
}

// writePool → pgbouncer-write → postgres (primary)   [writes]
// readPool  → pgbouncer-read  → postgres-replica     [reads, falls back to write pool]
const writePool = new Pool({
  connectionString: buildConnectionString(process.env.DB_WRITE_HOST || "pgbouncer-write"),
  max: parseInt(process.env.DB_WRITE_POOL_SIZE || "5"),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const readPool = new Pool({
  connectionString: buildConnectionString(process.env.DB_READ_HOST || "pgbouncer-read"),
  max: parseInt(process.env.DB_READ_POOL_SIZE || "10"),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

function makeBreaker(pool, name) {
  const breaker = new CircuitBreaker(
    async (sql, params) => pool.query(sql, params),
    { timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000, volumeThreshold: 5 }
  );

  breaker.fallback(() => {
    const e = new Error(`Circuit breaker OPEN — ${name} DB temporarily unavailable`);
    e.code = "CIRCUIT_OPEN";
    throw e;
  });

  breaker.on("open",     () => logger.warn("Circuit breaker OPEN",      { pool: name }));
  breaker.on("halfOpen", () => logger.warn("Circuit breaker HALF-OPEN", { pool: name }));
  breaker.on("close",    () => logger.info("Circuit breaker CLOSED",    { pool: name }));

  return breaker;
}

const writeBreaker = makeBreaker(writePool, "write");
const readBreaker  = makeBreaker(readPool,  "read");

// Writes → primary
async function query(sql, params, traceId) {
  try {
    return await writeBreaker.fire(sql, params);
  } catch (err) {
    if (err.code !== "CIRCUIT_OPEN") logger.error("Write DB error", { traceId, sql, error: err.message });
    throw err;
  }
}

// Reads → replica, falls back to primary if read circuit is open
async function readQuery(sql, params, traceId) {
  try {
    return await readBreaker.fire(sql, params);
  } catch (err) {
    if (err.code === "CIRCUIT_OPEN") {
      logger.warn("Read pool unavailable — falling back to write pool", { traceId });
      return query(sql, params, traceId);
    }
    logger.error("Read DB error", { traceId, sql, error: err.message });
    throw err;
  }
}

async function connectWithRetry(pool, name, retries = 10, delayMs = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const client = await pool.connect();
      logger.info("Connected to PostgreSQL", { pool: name });
      client.release();
      return;
    } catch (err) {
      logger.error(`DB connection attempt ${i}/${retries} failed`, { pool: name, error: err.message });
      if (i === retries) throw err;
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
}

async function initSchema() {
  await writePool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL,
      value      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  logger.info("Schema ready");
}

module.exports = { writePool, readPool, query, readQuery, connectWithRetry, initSchema };
