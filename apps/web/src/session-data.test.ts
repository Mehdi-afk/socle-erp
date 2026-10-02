// SPDX-License-Identifier: LGPL-3.0-only
import type { RecordValues, SearchOptions, SearchResult } from '@socle/view-engine/data-source';
import { describe, expect, it, vi } from 'vitest';

import type { RpcDataSource } from './rpc-data-source.js';
import { RpcDataError } from './rpc-errors.js';
import { watchSession } from './session-data.js';

const id = 'a0000000-0000-4000-8000-000000000001';
const record: RecordValues = { id, name: 'Alice' };
const options: SearchOptions = {
  fields: ['name'],
  domain: [['name', 'ilike', 'ali']],
  order: 'name desc',
  limit: 20,
  offset: 40,
};

function source() {
  return {
    userId: 'alice',
    search: vi.fn<RpcDataSource['search']>().mockResolvedValue({ records: [record], total: 1 }),
    read: vi.fn<RpcDataSource['read']>().mockResolvedValue([record]),
    displayNames: vi
      .fn<RpcDataSource['displayNames']>()
      .mockResolvedValue(new Map([[id, 'Alice']])),
    write: vi.fn<RpcDataSource['write']>().mockResolvedValue(undefined),
    dispose: vi.fn<RpcDataSource['dispose']>(),
  };
}

describe('watchSession', () => {
  it('forwards every adapter method, its arguments and its result without adding requests', async () => {
    const data = source();
    const expired = vi.fn();
    const watched = watchSession(data, expired);
    const ids = [id];
    const fields = ['name'];
    const values = { name: 'Updated' };
    const names = new Map([[id, 'Display name']]);
    data.displayNames.mockResolvedValueOnce(names);

    expect(await watched.search('test.partner', options)).toEqual({ records: [record], total: 1 });
    expect(await watched.read('test.partner', ids, fields)).toEqual([record]);
    expect(await watched.displayNames('test.partner', ids)).toBe(names);
    if (!watched.write) throw new Error('The watched RPC source must support writes.');
    await expect(watched.write('test.partner', id, values)).resolves.toBeUndefined();

    expect(data.search).toHaveBeenCalledExactlyOnceWith('test.partner', options);
    expect(data.read).toHaveBeenCalledExactlyOnceWith('test.partner', ids, fields);
    expect(data.displayNames).toHaveBeenCalledExactlyOnceWith('test.partner', ids);
    expect(data.write).toHaveBeenCalledExactlyOnceWith('test.partner', id, values);
    expect(expired).not.toHaveBeenCalled();
    expect(data.dispose).not.toHaveBeenCalled();
  });

  it.each(['unauthenticated', 'csrf'] as const)(
    'reports %s once across all operations and rethrows the original errors without replay',
    async (code) => {
      const data = source();
      const error = new RpcDataError(code, 'fr', code === 'csrf' ? 403 : 401);
      data.search.mockRejectedValue(error);
      data.read.mockRejectedValue(error);
      data.displayNames.mockRejectedValue(error);
      data.write.mockRejectedValue(error);
      const expired = vi.fn();
      const watched = watchSession(data, expired);

      await expect(watched.search('test.partner', options)).rejects.toBe(error);
      await expect(watched.read('test.partner', [id], ['name'])).rejects.toBe(error);
      await expect(watched.displayNames('test.partner', [id])).rejects.toBe(error);
      if (!watched.write) throw new Error('The watched RPC source must support writes.');
      await expect(watched.write('test.partner', id, { name: 'Updated' })).rejects.toBe(error);

      expect(expired).toHaveBeenCalledExactlyOnceWith();
      for (const method of [data.search, data.read, data.displayNames, data.write]) {
        expect(method).toHaveBeenCalledTimes(1);
      }
      expect(data.dispose).not.toHaveBeenCalled();
    },
  );

  it('notifies only once when concurrent reads fail for different terminal reasons', async () => {
    const data = source();
    const read = Promise.withResolvers<RecordValues[]>();
    const search = Promise.withResolvers<SearchResult>();
    data.read.mockReturnValueOnce(read.promise);
    data.search.mockReturnValueOnce(search.promise);
    const expired = vi.fn();
    const watched = watchSession(data, expired);
    const first = watched.read('test.partner', [id], ['name']);
    const second = watched.search('test.partner', options);
    const firstError = new RpcDataError('csrf', 'fr', 403);
    const secondError = new RpcDataError('unauthenticated', 'fr', 401);
    const firstRejected = expect(first).rejects.toBe(firstError);
    const secondRejected = expect(second).rejects.toBe(secondError);
    read.reject(firstError);
    search.reject(secondError);
    await Promise.all([firstRejected, secondRejected]);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it.each([
    new RpcDataError('forbidden', 'fr', 403),
    new RpcDataError('unavailable', 'fr', 503),
    new RpcDataError('disposed'),
    new Error('Local read failure'),
  ])('keeps a non-expiration error (%s) local to its operation', async (error) => {
    const data = source();
    data.read.mockRejectedValueOnce(error);
    const expired = vi.fn();
    const watched = watchSession(data, expired);
    await expect(watched.read('test.partner', [id], ['name'])).rejects.toBe(error);
    expect(expired).not.toHaveBeenCalled();
    expect(await watched.read('test.partner', [id], ['name'])).toEqual([record]);
    expect(data.read).toHaveBeenCalledTimes(2);
  });

  it('gives a new source its own expiration notification', async () => {
    const expired = vi.fn();
    for (const data of [source(), source()]) {
      const error = new RpcDataError('unauthenticated', 'fr', 401);
      data.read.mockRejectedValueOnce(error);
      await expect(watchSession(data, expired).read('test.partner', [id], ['name'])).rejects.toBe(
        error,
      );
    }
    expect(expired).toHaveBeenCalledTimes(2);
  });
});
