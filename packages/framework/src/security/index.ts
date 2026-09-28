// SPDX-License-Identifier: LGPL-3.0-only
export { createAccessControl } from './access-control.js';
export {
  canAccessModel,
  canSeeField,
  effectiveGroups,
  resolveRuleDomain,
  ruleDomainFor,
} from './permissions.js';
export { buildSecurityPolicy, isUserValue, SecurityDefinitionError } from './policy.js';
export type {
  AccessDefinition,
  GroupDefinition,
  ModuleSecurity,
  RuleCondition,
  RuleDefinition,
  RuleDomain,
  SecurityPolicy,
  UserValue,
} from './policy.js';
