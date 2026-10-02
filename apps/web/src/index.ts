// SPDX-License-Identifier: LGPL-3.0-only

export const PACKAGE_NAME = '@socle/web';

export { connectRpcDataSource, connectWebClient } from './rpc-data-source.js';
export type {
  RpcDataSource,
  RpcDataSourceOptions,
  WebClient,
  WebClientOptions,
} from './rpc-data-source.js';
export { RpcDataError } from './rpc-errors.js';
export type { RpcErrorCode } from './rpc-errors.js';
