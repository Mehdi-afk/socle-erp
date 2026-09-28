// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '../errors.js';

/**
 * The module package or revocation list is malformed.
 * @public
 */
export class InvalidPackageError extends SocleError {
  constructor(message: string) {
    super('trust.invalid_package', message);
  }
}

/**
 * A signature is missing, invalid, or made with an unknown key.
 * @public
 */
export class SignatureError extends SocleError {
  constructor(message: string) {
    super('trust.signature', message);
  }
}

/**
 * A file of the module does not match the signed index (modified, added or removed).
 * @public
 */
export class IntegrityError extends SocleError {
  readonly path: string;

  constructor(path: string, reason: 'modified' | 'added' | 'missing') {
    super('trust.integrity', `File "${path}" was ${reason} after signing.`);
    this.path = path;
  }
}

/**
 * An unsigned module was refused by the installation policy.
 * @public
 */
export class UnsignedModuleError extends SocleError {
  constructor(moduleName: string) {
    super(
      'trust.unsigned',
      `Module "${moduleName}" is not signed. Unsigned modules are only allowed on a self-hosted ` +
        'instance whose administrator explicitly enabled them.',
    );
  }
}

/**
 * The module (or its publisher) has been revoked.
 * @public
 */
export class RevokedModuleError extends SocleError {
  readonly reason: string;

  constructor(moduleName: string, reason: string) {
    super('trust.revoked', `Module "${moduleName}" has been revoked: ${reason}`);
    this.reason = reason;
  }
}

/**
 * A revocation list older than the last one accepted was presented (rollback attempt).
 * @public
 */
export class RevocationRollbackError extends SocleError {
  constructor(received: number, lastAccepted: number) {
    super(
      'trust.revocation_rollback',
      `Revocation list #${String(received)} is older than the last accepted #${String(lastAccepted)}.`,
    );
  }
}
