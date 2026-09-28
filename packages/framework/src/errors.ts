// SPDX-License-Identifier: LGPL-3.0-only

/**
 * Base class of every error raised by the Socle framework.
 * `code` is stable and machine-readable; `message` is for humans (English).
 * @public
 */
export class SocleError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}
