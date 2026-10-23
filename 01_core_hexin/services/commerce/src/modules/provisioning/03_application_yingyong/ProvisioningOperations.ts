import type { OperationId } from '@shop/contract';
import type { ModuleContext } from '../../../bootstrap/ModuleRegistry';
import { AUDIT_SINK } from '../../../foundation/application/AuditSink';
import { ModuleOperations, operationLifecycle, reject, requireAccess } from '../../../foundation/application/ModuleOperations';
import { bodyRecord, optionalText, textField } from '../../../foundation/interface/Validation';
import { DATABASE_POOL } from '../../../foundation/persistence/Pool';
import { CreateMall } from './CreateMall';
import { AUTONODE_CONTROL_CLIENT } from '../04_adapters_shixian/AutoNodeControlClient';

export const MALL_PROVISIONING_OPERATION_IDS = Object.freeze([
  'provisioning.malls.create',
  'provisioning.malls.read',
  'provisioning.nodetasks.read',
  'provisioning.nodetasks.retry',
  'provisioning.instances.read',
  'provisioning.instances.manage',
] as const satisfies readonly OperationId[]);

export function provisioningOperations(context: ModuleContext): ModuleOperations {
  const pool = context.container.get(DATABASE_POOL);
  const createMall = new CreateMall();
  const nodeControl = context.container.get(AUTONODE_CONTROL_CLIENT);
  return new ModuleOperations('provisioning', pool, context.container.get(AUDIT_SINK), {
    'provisioning.instances.read': async (request) => {
      requireAccess(request);
      return { status: 200, body: await nodeControl.instances() };
    },
    'provisioning.instances.manage': async (request) => {
      const access = requireAccess(request);
      const action = textField(bodyRecord(request), 'action');
      if (action !== 'CREATE' && action !== 'DELETE') reject(422, 'VALIDATION_FAILED');
      return { status: 202, body: await nodeControl.lifecycle(request.input.path.instanceid!, action as 'CREATE' | 'DELETE', access, request.input.idempotency!) };
    },
    'provisioning.malls.create': operationLifecycle({
      async execute(request, database) {
        const access = requireAccess(request);
        const body = bodyRecord(request);
        const code = textField(body, 'code', 32);
        if (!/^[A-Z][A-Z0-9_]{2,31}$/.test(code)) throw new Error('VALIDATION_FAILED:code');
        const publicSlug = await createMall.allocatePublicSlug(database);
        const plan = createMall.plan({
          scope: access.scope.id,
          parent: optionalText(body, 'parentId') ?? textField(body, 'enterpriseId'),
          code,
          publicSlug,
          name: textField(body, 'name'),
          actor: access.actor.id,
          actorMembership: access.membership.id,
        });
        const conflict = await createMall.preflight(database, plan);
        if (conflict !== null) reject(conflict === 'MALL_PARENT_INVALID' ? 422 : 409, conflict);
        return { status: 201, body: { ...await createMall.execute(database, plan), createdAt: new Date().toISOString() } };
      },
      async finalize(request, result) {
        if (result.status !== 201) return result;
        const mall = result.body as Awaited<ReturnType<CreateMall['execute']>> & { readonly createdAt: string };
        const task = await nodeControl.submitMall(mall, mall.createdAt, requireAccess(request), request.input.idempotency!);
        return { ...result, body: { ...mall, nodeTask: task } };
      },
    }),
    'provisioning.malls.read': async (request, database) => {
      requireAccess(request);
      const mall = await createMall.read(database, request.input.path.mallid!);
      if (!mall) reject(404, 'RESOURCE_NOT_FOUND');
      return { status: 200, body: mall };
    },
    'provisioning.nodetasks.read': async (request) => {
      requireAccess(request);
      try {
        return { status: 200, body: await nodeControl.read(request.input.path.taskid!) };
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes('AUTONODE_TASK_NOT_FOUND')) {
          reject(404, 'RESOURCE_NOT_FOUND');
        }
        throw cause;
      }
    },
    'provisioning.nodetasks.retry': async (request) => {
      requireAccess(request);
      return { status: 202, body: await nodeControl.retry(request.input.path.taskid!) };
    },
  }, MALL_PROVISIONING_OPERATION_IDS);
}
