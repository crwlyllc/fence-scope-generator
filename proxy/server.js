const http = require('http');
const { URL } = require('url');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

const DEFAULT_PROXY_PREFIX = '/api/hcp';
const proxyPrefix = normalizePrefix(process.env.PROXY_PREFIX || DEFAULT_PROXY_PREFIX);
const allowedOrigins = parseList(process.env.ALLOWED_ORIGINS);
const maxBodySize = getMaxBodySize(process.env.MAX_BODY_SIZE);
const defaultBase = sanitizeBase(process.env.HCP_API_BASE || 'https://api.housecallpro.com');
const defaultAuthMode = normalizeAuthMode(process.env.HCP_API_KEY_MODE) || 'bearer';
const explicitAuthHeader = sanitizeHeader(process.env.HCP_AUTH_HEADER);
const envApiKey = sanitizeToken(process.env.HCP_API_KEY);
const port = Number(process.env.PORT) || 8080;

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade'
]);

const suppressedRequestHeaders = new Set([
  'host',
  'content-length',
  'accept-encoding',
  'origin',
  'referer',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'x-hcp-api-key',
  'x-hcp-auth-mode',
  'x-hcp-api-base'
]);

const suppressedResponseHeaders = new Set([
  'content-encoding',
  'transfer-encoding'
]);

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('Unhandled proxy rejection:', error);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Proxy request failed.' }));
    }
  });
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Housecall Pro proxy listening on port ${port}`);
    if (defaultBase) {
      console.log(`Forwarding to ${defaultBase}`);
    } else {
      console.log('No default base configured; requests must supply X-Hcp-Api-Base.');
    }
  });
}

async function handleRequest(req, res) {
  try {
    if (isHealthCheck(req)) {
      applyCors(req, res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (!isProxyRequest(req)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Not found');
      return;
    }

    await handleProxy(req, res);
  } catch (error) {
    console.error('Proxy error:', error);
    if (!res.headersSent) {
      applyCors(req, res);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Proxy request failed.' }));
    } else {
      try {
        res.end();
      } catch (endError) {
        console.error('Failed to terminate response:', endError);
      }
    }
    throw error;
  }
}

async function handleProxy(req, res) {
  applyCors(req, res);

  if (!isOriginAllowed(req)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Origin not allowed.' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const targetBase = sanitizeBase(req.headers['x-hcp-api-base']) || defaultBase;
  if (!targetBase) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'No upstream base configured.' }));
    return;
  }

  const targetUrl = buildTargetUrl(req.url, targetBase);
  if (!targetUrl) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unable to resolve upstream URL.' }));
    return;
  }

  let body = Buffer.alloc(0);
  try {
    body = await readRequestBody(req, maxBodySize);
  } catch (error) {
    if (error && error.type === 'entity.too.large') {
      res.statusCode = 413;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Request body too large.' }));
      return;
    }
    throw error;
  }

  const headers = buildForwardHeaders(req);
  const method = req.method.toUpperCase();
  const init = {
    method,
    headers,
    redirect: 'manual'
  };

  if (body.length && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (error) {
    console.error('Upstream fetch error:', error);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to reach Housecall Pro API.' }));
    return;
  }

  res.statusCode = upstream.status;
  res.statusMessage = upstream.statusText || res.statusMessage;

  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) return;
    if (suppressedResponseHeaders.has(lower)) return;
    res.setHeader(key, value);
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    await pipelineAsync(upstream.body, res);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Streaming response failed.' }));
    }
    throw error;
  }
}

function isHealthCheck(req) {
  return req.url === '/healthz';
}

function isProxyRequest(req) {
  return typeof req.url === 'string' && req.url.startsWith(proxyPrefix);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowOrigin = selectAllowedOrigin(origin);
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Hcp-Api-Key,X-Hcp-Auth-Mode,X-Hcp-Api-Base,X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function selectAllowedOrigin(origin) {
  if (!allowedOrigins.length) {
    return origin || '*';
  }
  if (allowedOrigins.includes('*')) {
    return origin || '*';
  }
  if (origin && allowedOrigins.includes(origin)) {
    return origin;
  }
  return '';
}

function isOriginAllowed(req) {
  if (!allowedOrigins.length) return true;
  if (allowedOrigins.includes('*')) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function sanitizeBase(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch (error) {
    return '';
  }
}

function buildTargetUrl(requestUrl, base) {
  try {
    const cleanBase = sanitizeBase(base);
    if (!cleanBase) return '';
    const suffix = requestUrl.slice(proxyPrefix.length);
    const normalizedSuffix = suffix.startsWith('/') ? suffix.slice(1) : suffix;
    const baseWithSlash = cleanBase.endsWith('/') ? cleanBase : `${cleanBase}/`;
    return new URL(normalizedSuffix || '', baseWithSlash).toString();
  } catch (error) {
    console.error('Failed to build target URL:', error);
    return '';
  }
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function normalizePrefix(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return DEFAULT_PROXY_PREFIX;
  const leading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return leading.replace(/\/+$/, '') || '/';
}

async function readRequestBody(req, limit) {
  const method = (req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return Buffer.alloc(0);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (limit && total > limit) {
      const error = new Error('Request body too large');
      error.type = 'entity.too.large';
      throw error;
    }
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function buildForwardHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    if (suppressedRequestHeaders.has(lower)) continue;
    if (typeof value === 'undefined') continue;
    if (Array.isArray(value)) {
      headers[key] = value.join(', ');
    } else {
      headers[key] = value;
    }
  }
  const authorization = resolveAuthorization(req);
  if (authorization) {
    headers['authorization'] = authorization;
  } else {
    delete headers.authorization;
    delete headers.Authorization;
  }
  return headers;
}

function resolveAuthorization(req) {
  if (explicitAuthHeader) {
    return explicitAuthHeader;
  }
  const incoming = sanitizeHeader(req.headers.authorization);
  if (incoming) {
    return incoming;
  }
  const requestToken = sanitizeToken(req.headers['x-hcp-api-key']);
  const token = requestToken || envApiKey;
  if (!token) {
    return '';
  }
  const modeHeader = normalizeAuthMode(req.headers['x-hcp-auth-mode']) || defaultAuthMode;
  if (!modeHeader) {
    return '';
  }
  if (modeHeader === 'basic') {
    const normalized = token.toLowerCase().startsWith('basic ')
      ? token
      : `Basic ${Buffer.from(`${token}:`).toString('base64')}`;
    return normalized;
  }
  if (token.toLowerCase().startsWith('bearer ')) {
    return token;
  }
  return token.toLowerCase().startsWith('basic ')
    ? token
    : `Bearer ${token}`;
}

function normalizeAuthMode(value) {
  if (!value) return '';
  const mode = String(value).trim().toLowerCase();
  if (mode === 'basic' || mode === 'bearer') {
    return mode;
  }
  return '';
}

function sanitizeHeader(value) {
  if (!value) return '';
  return String(value).trim();
}

function sanitizeToken(value) {
  if (!value) return '';
  return String(value).trim();
}

function getMaxBodySize(value) {
  if (!value) return 10 * 1024 * 1024; // 10MB default
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 10 * 1024 * 1024;
}

module.exports = server;
module.exports.handle = handleRequest;
module.exports.server = server;
