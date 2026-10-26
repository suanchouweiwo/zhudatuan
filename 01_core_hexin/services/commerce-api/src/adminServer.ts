import express, { type NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { decide } from '@smart-wing/authz';
import { PERMISSIONS, type Permission } from '@smart-wing/api-contract';
import { resolveMembershipRuntime } from './api/membershipContext';
import { readSession } from './api/session';
import type { WorkerEnv } from './api/types';

const repositoryRoot = process.cwd();
const adminWebRoot = path.join(repositoryRoot, '01_core_hexin', 'apps', 'console');
dotenv.config({ path: process.env.ENV_FILE ?? path.join(repositoryRoot, '.env.production') });

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function isLocalDevelopment(): boolean {
  return process.env.APP_ENV === 'development' && process.env.AUTH_MODE === 'development';
}

/**
 * A host-only admin cookie alone is
 * not authority: every endpoint declares the business permission it needs.
 */
function requireAdminPermission(permission: Permission) {
  return async (request: ExpressRequest, response: ExpressResponse, next: NextFunction): Promise<void> => {
    if (isLocalDevelopment()) {
      next();
      return;
    }

    try {
      const session = await readSession(
        new Request(`https://console.zhudatuan.com${request.originalUrl}`, {
          headers: { cookie: request.headers.cookie ?? '' },
        }),
        process.env as WorkerEnv
      );
      if (!session || session.target !== 'admin') {
        response.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
        return;
      }
      const runtime = await resolveMembershipRuntime(
        new Request(`https://console.zhudatuan.com${request.originalUrl}`, {
          headers: { cookie: request.headers.cookie ?? '' },
        }),
        process.env as WorkerEnv
      );
      if (!runtime) {
        response.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
        return;
      }
      const decision = decide(
        runtime.membership,
        permission,
        {
          tenantId: runtime.membership.context.tenantId,
          enterpriseId: runtime.membership.context.enterpriseId,
          mallId: runtime.membership.context.mallId,
          supplierId: runtime.membership.context.supplierId,
          ownerUserId: runtime.membership.context.userId,
        },
        { stepUpAt: runtime.authorization.stepUpAt }
      );
      if (!decision.allowed) {
        response.status(403).json({ error: 'FORBIDDEN', reason: decision.reason });
        return;
      }
      next();
    } catch {
      response.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
    }
  };
}

// API Route: Health Check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// The former external AI provider is retired. Keep existing routes and authorization.
function unavailableAnalysis(_request: ExpressRequest, response: ExpressResponse): void {
  response.status(503).json({
    error: 'AI_SERVICE_UNAVAILABLE',
    message: 'AI分析服务尚未接入',
  });
}

app.post('/api/ai/classify-product', requireAdminPermission(PERMISSIONS.productPublish), unavailableAnalysis);
app.post('/api/ai/operational-copilot', requireAdminPermission(PERMISSIONS.orderRead), unavailableAnalysis);

async function startServer() {
  const distPath = path.join(adminWebRoot, 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    if (error instanceof SyntaxError || (typeof error === 'object' && error !== null && 'type' in error && (error as { type?: string }).type === 'entity.too.large')) {
      response.status(400).json({ error: 'INVALID_REQUEST_BODY' });
      return;
    }
    console.error(JSON.stringify({ level: 'error', event: 'admin_http_error' }));
    response.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  // 仅由本机 Caddy 反向代理暴露，避免绕过 TLS、WAF 与域名级会话隔离。
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Smart Wing Admin Console listening on 127.0.0.1:${PORT}`);
  });
}

startServer();
