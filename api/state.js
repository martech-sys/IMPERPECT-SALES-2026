'use strict';

/* Vercel Function behind /api/state and /healthz (vercel.json rewrites
   /healthz here with ?health=1). The logic lives in server/api.js. */

const { Pool } = require('pg');
const { createApi } = require('../server/api');

// one query per refresh, so every warm instance holds at most one connection
const api = createApi(process.env, { Pool, maxConnections: 1 });

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const health = url.pathname === '/healthz' || url.searchParams.has('health');
  const out = await api.handle(health ? '/healthz' : '/api/state');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // browsers always ask again; Vercel's CDN may answer for cacheSeconds
  res.setHeader('Cache-Control', 'no-store');
  if (out.cacheSeconds) {
    res.setHeader('Vercel-CDN-Cache-Control', 'max-age=' + out.cacheSeconds + ', stale-while-revalidate=' + out.cacheSeconds * 4);
  }
  res.statusCode = out.status;
  res.end(JSON.stringify(out.body));
};
