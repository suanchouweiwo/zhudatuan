import type { Scope } from '@shop/authz';
import type { Actor } from './AccessContext';
import type { ScopeResolver } from './ScopeResolver';

type OwnerNodeScopeResolver = (actor: Actor) => Promise<Scope>;
type NodeScopeIdResolver = string | ((actor: Actor) => string);

export class NodeBoundScopeResolver implements ScopeResolver {
  constructor(
    private readonly next: ScopeResolver,
    private readonly scopeId: NodeScopeIdResolver,
    private readonly resolveOwnerNodeScope?: OwnerNodeScopeResolver,
  ) {}

  async resolve(actor: Actor, operation: string, resource?: string, scopeHint?: string): Promise<Scope> {
    const expectedScopeId = typeof this.scopeId === 'string' ? this.scopeId : this.scopeId(actor);
    const scope = await this.next.resolve(actor, operation, resource, scopeHint);
    // L0 console enumerates its authorized organization roots rather than one storefront scope.
    if (operation === 'organization.layers.read' && actor.target === 'console'
      && actor.nodeContext?.signed_level === 'L0') return scope;
    let nodeScope = scope;
    if (scope.kind === 'owner') {
      if (!this.resolveOwnerNodeScope) throw new Error('NODE_SCOPE_MISMATCH');
      nodeScope = await this.resolveOwnerNodeScope(actor);
    }
    if (nodeScope.id !== expectedScopeId) throw new Error('NODE_SCOPE_MISMATCH');
    return scope;
  }
}
