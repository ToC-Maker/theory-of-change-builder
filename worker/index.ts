import type { Env } from './_shared/types';

import { handler as anthropicStream } from './api/anthropic-stream';
import { handler as createChart } from './api/createChart';
import { handler as getChart } from './api/getChart';
import { handler as updateChart } from './api/updateChart';
import { handler as deleteChart } from './api/deleteChart';
import { handler as getUserCharts } from './api/getUserCharts';
import { handler as getUserTokenUsage } from './api/getUserTokenUsage';
import { handler as updateTokenUsage } from './api/updateTokenUsage';
import { handler as managePermissions } from './api/managePermissions';
import { handler as loggingCreateSession } from './api/logging-createSession';
import { handler as loggingEndSession } from './api/logging-endSession';
import { handler as loggingSaveMessage } from './api/logging-saveMessage';
import { handler as loggingSaveSnapshot } from './api/logging-saveSnapshot';
import { handler as loggingReportError } from './api/logging-reportError';
import { handler as loggingPreference } from './api/logging-preference';

type Handler = (request: Request, env: Env) => Promise<Response>;

// Route table: [method, path, handler]
// method '*' matches any method (handler checks internally)
const routes: [string, string, Handler][] = [
  ['POST', '/api/anthropic-stream', anthropicStream],
  ['POST', '/api/createChart', createChart],
  ['GET', '/api/getChart', getChart],
  ['POST', '/api/updateChart', updateChart],
  ['DELETE', '/api/deleteChart', deleteChart],
  ['GET', '/api/getUserCharts', getUserCharts],
  ['GET', '/api/getUserTokenUsage', getUserTokenUsage],
  ['POST', '/api/updateTokenUsage', updateTokenUsage],
  ['*', '/api/managePermissions', managePermissions],
  ['POST', '/api/logging-createSession', loggingCreateSession],
  ['POST', '/api/logging-endSession', loggingEndSession],
  ['POST', '/api/logging-saveMessage', loggingSaveMessage],
  ['POST', '/api/logging-saveSnapshot', loggingSaveSnapshot],
  ['POST', '/api/logging-reportError', loggingReportError],
  ['*', '/api/logging-preference', loggingPreference],
];

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'DELETE, GET, PATCH, POST, PUT, OPTIONS',
};

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const blockedPaths = ['/wp-admin/', '/wordpress/', '/xmlrpc.php', '/wp-includes/', '/wp-content/'];

function isBlocked(pathname: string): boolean {
  return blockedPaths.some(p => pathname.startsWith(p) || pathname.includes(p));
}

function addHeaders(response: Response, headers: Record<string, string>): Response {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Block WordPress probes
    if (isBlocked(url.pathname)) {
      return new Response('Not Found', { status: 404 });
    }

    // API routes
    if (url.pathname.startsWith('/api/')) {
      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Match route
      for (const [method, path, handler] of routes) {
        if (url.pathname === path && (method === '*' || method === request.method)) {
          try {
            const response = await handler(request, env);
            return addHeaders(response, corsHeaders);
          } catch (err) {
            console.error(`Error in ${request.method} ${path}:`, err);
            return addHeaders(
              Response.json({ error: 'Internal server error' }, { status: 500 }),
              corsHeaders
            );
          }
        }
      }

      // Path exists but wrong method
      const pathExists = routes.some(([, path]) => path === url.pathname);
      if (pathExists) {
        return addHeaders(
          Response.json({ error: 'Method not allowed' }, { status: 405 }),
          corsHeaders
        );
      }

      return addHeaders(
        Response.json({ error: 'Not found' }, { status: 404 }),
        corsHeaders
      );
    }

    // Static assets (served by Workers Static Assets with SPA fallback)
    const response = await env.ASSETS.fetch(request);
    return addHeaders(response, securityHeaders);
  },
} satisfies ExportedHandler<Env>;
