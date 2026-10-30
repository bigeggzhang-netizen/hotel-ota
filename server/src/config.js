'use strict';
const path = require('node:path');

module.exports = {
  port: Number(process.env.PORT || 3000),
  // SQLite 数据文件存放目录（git 忽略）
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // 会话有效期（毫秒），默认 12 小时
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000),
  // 登录失败锁定：5 次失败锁定 10 分钟
  loginMaxFails: 5,
  loginLockMs: 10 * 60 * 1000,
  // 回滚有效期（毫秒），默认 72 小时，见需求文档第 5 节
  rollbackWindowMs: 72 * 60 * 60 * 1000,
  // 静态页面目录
  webDir: path.join(__dirname, '..', 'web'),
};
