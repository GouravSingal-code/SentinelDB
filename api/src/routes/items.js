const { Router } = require("express");
const { query, readQuery } = require("../db");
const logger = require("../logger");
const withTrace = require("../withTrace");

const router = Router();

// ── GET /items — list all  (READ → replica)
router.get("/", withTrace(async (req, res, traceId) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const { rows } = await readQuery(
    "SELECT * FROM items ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    [limit, offset],
    traceId
  );
  logger.info("Listed items", { traceId, count: rows.length, limit, offset });
  res.json(rows);
}));

// ── GET /items/:id — get one  (READ → replica)
router.get("/:id", withTrace(async (req, res, traceId) => {
  const { rows } = await readQuery("SELECT * FROM items WHERE id = $1", [req.params.id], traceId);
  if (!rows.length) {
    logger.warn("Item not found", { traceId, id: req.params.id });
    return res.status(404).json({ error: "Not found", traceId });
  }
  logger.info("Fetched item", { traceId, id: req.params.id });
  res.json(rows[0]);
}));

// ── POST /items — create  (WRITE → primary)
router.post("/", withTrace(async (req, res, traceId) => {
  const { name, value } = req.body;
  if (!name) return res.status(400).json({ error: "name is required", traceId });
  const { rows } = await query(
    "INSERT INTO items (name, value) VALUES ($1, $2) RETURNING *",
    [name, value || null],
    traceId
  );
  logger.info("Created item", { traceId, id: rows[0].id, name });
  res.status(201).json(rows[0]);
}));

// ── PUT /items/:id — update  (WRITE → primary)
router.put("/:id", withTrace(async (req, res, traceId) => {
  const { name, value } = req.body;
  const { rows } = await query(
    "UPDATE items SET name = COALESCE($1, name), value = COALESCE($2, value) WHERE id = $3 RETURNING *",
    [name, value, req.params.id],
    traceId
  );
  if (!rows.length) {
    logger.warn("Item not found for update", { traceId, id: req.params.id });
    return res.status(404).json({ error: "Not found", traceId });
  }
  logger.info("Updated item", { traceId, id: req.params.id });
  res.json(rows[0]);
}));

// ── DELETE /items/:id — delete  (WRITE → primary)
router.delete("/:id", withTrace(async (req, res, traceId) => {
  const { rowCount } = await query("DELETE FROM items WHERE id = $1", [req.params.id], traceId);
  if (!rowCount) {
    logger.warn("Item not found for delete", { traceId, id: req.params.id });
    return res.status(404).json({ error: "Not found", traceId });
  }
  logger.info("Deleted item", { traceId, id: req.params.id });
  res.status(204).send();
}));

module.exports = router;
