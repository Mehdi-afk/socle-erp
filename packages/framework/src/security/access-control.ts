// SPDX-License-Identifier: LGPL-3.0-only
import type { AccessControl, Environment, Operation } from '../orm/environment.js';
import { AccessError } from '../orm/errors.js';
import type { ModelRegistry } from '../orm/model-registry.js';
import { canAccessModel, effectiveGroups, ruleDomainFor } from './permissions.js';
import type { SecurityPolicy } from './policy.js';

/**
 * The ORM's access control built from the security policy: ACL checked on every operation
 * (deny by default), record rules added to every search and record check. Superuser
 * environments (`env.sudo()`) bypass it, as decided by the ORM (audited there).
 * @public
 */
export function createAccessControl(
  policy: SecurityPolicy,
  registry: ModelRegistry,
): AccessControl {
  const resolve = (model: string, field: string) => registry.field(model, field);
  return {
    checkModel(env: Environment, model: string, operation: Operation): void {
      const groups = effectiveGroups(policy, env.user.groupIds);
      if (!canAccessModel(policy, groups, model, operation)) {
        throw new AccessError(
          `Operation "${operation}" on "${model}" is not allowed for this user.`,
        );
      }
    },
    ruleDomain(env: Environment, model: string, operation: Operation) {
      const groups = effectiveGroups(policy, env.user.groupIds);
      const mixins = registry.has(model) ? registry.get(model).mixins : [];
      return ruleDomainFor(policy, env.user, groups, model, operation, resolve, mixins);
    },
  };
}
