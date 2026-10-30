'use strict';
const express = require('express');
const config = require('./config');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/suggestions', require('./routes/suggestions'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/rules', require('./routes/rules'));
app.use('/api/data', require('./routes/data'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

app.get('/', (req, res) => res.redirect('/console.html'));
app.use(express.static(config.webDir, { index: false }));
app.use((req, res) => res.status(404).send('页面不存在'));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: '服务器内部错误' });
});

module.exports = app;
