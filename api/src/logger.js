function log(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  console.log(JSON.stringify(entry));
}

const logger = {
  info:  (message, meta) => log("INFO",  message, meta),
  warn:  (message, meta) => log("WARN",  message, meta),
  error: (message, meta) => log("ERROR", message, meta),
};

module.exports = logger;
