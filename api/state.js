'use strict';

/* Vercel Function behind /api/state and /healthz (vercel.json rewrites
   /healthz here with ?health=1). The logic lives in server/api.js. */

const { Pool } = require('pg');
const { createApi } = require('../server/api');

// one query per refresh, so every warm instance holds at most one connection
const api = createApi(process.env, { Pool, maxConnections: 1 });
const STALE = 86400; // seconds the CDN may serve the previous ranking while refreshing

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const health = url.pathname === '/healthz' || url.searchParams.has('health');
  const out = await api.handle(health ? '/healthz' : '/api/state');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // browsers always ask again; Vercel's CDN answers for cacheSeconds, and after
  // that keeps answering at once with the last ranking while one request
  // refreshes it in the background, so a TV never waits on a cold function
  // (reading 38+ brand files) after a quiet spell or a deploy
  res.setHeader('Cache-Control', 'no-store');
  if (out.cacheSeconds) {
    res.setHeader('Vercel-CDN-Cache-Control', 'max-age=' + out.cacheSeconds + ', stale-while-revalidate=' + STALE + ', stale-if-error=' + STALE);
  }
  res.statusCode = out.status;
  res.end(JSON.stringify(out.body));
};
