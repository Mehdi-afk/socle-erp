// SPDX-License-Identifier: LGPL-3.0-only

/** HTTP errors whose message may be shown to the client. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
