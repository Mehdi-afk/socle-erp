// SPDX-License-Identifier: LGPL-3.0-only
import { SocleError } from '../errors.js';

/**
 * A module used a capability it did not declare in its manifest.
 * @public
 */
export class CapabilityDeniedError extends SocleError {
  readonly moduleName: string;
  readonly capability: string;

  constructor(moduleName: string, capability: string) {
    super(
      'capability.denied',
      `Module "${moduleName}" did not declare the capability "${capability}".`,
    );
    this.moduleName = moduleName;
    this.capability = capability;
  }
}

/**
 * An outgoing HTTP request was refused by the allow-list client (anti-SSRF).
 * @public
 */
export class OutboundRequestError extends SocleError {
  constructor(message: string) {
    super('http.outbound_refused', message);
  }
}
