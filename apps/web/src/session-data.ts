// SPDX-License-Identifier: LGPL-3.0-only
import type { DataSource } from '@socle/view-engine/data-source';

import type { RpcDataSource } from './rpc-data-source.js';
import { RpcDataError } from './rpc-errors.js';

/** A stable adapter reports terminal session failures even when the view catches its read/write error. */
export function watchSession(source: RpcDataSource, onExpired: () => void): DataSource {
  let notified = false;
  async function watch<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      if (
        !notified &&
        error instanceof RpcDataError &&
        (error.code === 'unauthenticated' || error.code === 'csrf')
      ) {
        notified = true;
        onExpired();
      }
      throw error;
    }
  }
  return {
    search: (model, options) => watch(source.search(model, options)),
    read: (model, ids, fields) => watch(source.read(model, ids, fields)),
    displayNames: (model, ids) => watch(source.displayNames(model, ids)),
    write: (model, id, values) => watch(source.write(model, id, values)),
  };
}
