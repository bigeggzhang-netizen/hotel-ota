'use strict';
const app = require('./app');
const config = require('./config');
const seed = require('./db/seed');
const monitor = require('./services/monitor');

seed();
const server = app.listen(config.port, config.host, () => {
  console.log(`[server] 酒店 OTA 盯盘系统已启动：http://${config.host}:${config.port}`);
  monitor.start();
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
