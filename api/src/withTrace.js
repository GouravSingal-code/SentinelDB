// Higher-order function that wraps a route handler with:
//   1. traceId extracted from req and passed as a third argument
//   2. Unified error handling — CIRCUIT_OPEN → 503, everything else → 500
function withTrace(handler) {
  return async (req, res) => {
    const { traceId } = req;
    try {
      await handler(req, res, traceId);
    } catch (err) {
      if (err.code === "CIRCUIT_OPEN") {
        return res.status(503).json({ error: "Service temporarily unavailable", traceId });
      }
      res.status(500).json({ error: err.message, traceId });
    }
  };
}

module.exports = withTrace;
