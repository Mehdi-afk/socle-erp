// SPDX-License-Identifier: LGPL-3.0-only
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useLookups } from './lookups.js';
import { contacts, fixture } from './testing/fixtures.js';
import type { DataSource, RecordValues, ViewContext } from './types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const partner: RecordValues = { id: 'p-0', countryId: 'c-dz', currencyId: 'cur-dzd' };

describe('useLookups', () => {
  it('groups relations and currencies by model and reuses loaded values on later rows', async () => {
    const { context, data } = fixture(0);
    const names = vi.spyOn(data, 'displayNames');
    const read = vi.spyOn(data, 'read');
    const { result } = renderHook(() => useLookups(context));
    await act(async () => {
      await result.current.ensure('res.partner', contacts(1000), [
        'countryId',
        'currencyId',
        'revenue',
      ]);
    });
    expect(names).toHaveBeenCalledTimes(2);
    expect(names).toHaveBeenCalledWith('res.country', ['c-dz', 'c-fr', 'c-tn']);
    expect(names).toHaveBeenCalledWith('res.currency', ['cur-dzd', 'cur-eur']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('res.currency', ['cur-dzd', 'cur-eur'], ['code', 'decimals']);
    expect(result.current.nameOf('res.country', 'c-dz')).toBe('Algérie');
    expect(result.current.currencyOf('cur-dzd')).toEqual({ code: 'DZD', decimals: 2 });
    const version = result.current.version;
    await act(async () => {
      await result.current.ensure('res.partner', contacts(20), ['countryId', 'revenue']);
    });
    expect(names).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.version).toBe(version);
  });

  it('lets every concurrent caller wait for the currency and its name without duplicate requests', async () => {
    const base = fixture(0);
    const rows = deferred<RecordValues[]>();
    const names = deferred<ReadonlyMap<string, string>>();
    const read = vi.fn<DataSource['read']>(() => rows.promise);
    const displayNames = vi.fn<DataSource['displayNames']>(() => names.promise);
    const context = { ...base.context, data: { ...base.data, read, displayNames } };
    const { result } = renderHook(() => useLookups(context));
    const first = result.current.ensure('res.partner', [partner], ['revenue']);
    const second = result.current.ensure('res.partner', [partner], ['currencyId', 'revenue']);
    const secondDone = vi.fn();
    void second.then(secondDone);
    await act(async () => {
      rows.resolve([{ id: 'cur-dzd', code: 'DZD', decimals: 2 }]);
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(displayNames).toHaveBeenCalledTimes(1);
    expect(secondDone).not.toHaveBeenCalled();
    expect(result.current.currencyOf('cur-dzd')).toBeUndefined();
    await act(async () => {
      names.resolve(new Map([['cur-dzd', 'Dinar']]));
      await Promise.all([first, second]);
    });
    expect(secondDone).toHaveBeenCalledTimes(1);
    expect(result.current.currencyOf('cur-dzd')).toEqual({ code: 'DZD', decimals: 2 });
    expect(result.current.nameOf('res.currency', 'cur-dzd')).toBe('Dinar');
  });

  it('waits for an earlier overlapping batch as well as newly requested IDs', async () => {
    const base = fixture(0);
    const algeria = deferred<ReadonlyMap<string, string>>();
    const france = deferred<ReadonlyMap<string, string>>();
    const displayNames = vi.fn<DataSource['displayNames']>((_model, ids) =>
      ids.includes('c-dz') ? algeria.promise : france.promise,
    );
    const context = { ...base.context, data: { ...base.data, displayNames } };
    const { result } = renderHook(() => useLookups(context));
    const first = result.current.ensure('res.partner', [partner], ['countryId']);
    const second = result.current.ensure(
      'res.partner',
      [partner, { ...partner, id: 'p-1', countryId: 'c-fr' }],
      ['countryId'],
    );
    const secondDone = vi.fn();
    void second.then(secondDone);
    await act(async () => {
      france.resolve(new Map([['c-fr', 'France']]));
      await Promise.resolve();
    });
    expect(displayNames.mock.calls).toEqual([
      ['res.country', ['c-dz']],
      ['res.country', ['c-fr']],
    ]);
    expect(secondDone).not.toHaveBeenCalled();
    await act(async () => {
      algeria.resolve(new Map([['c-dz', 'Algérie']]));
      await Promise.all([first, second]);
    });
    expect(secondDone).toHaveBeenCalledTimes(1);
    expect(result.current.nameOf('res.country', 'c-dz')).toBe('Algérie');
    expect(result.current.nameOf('res.country', 'c-fr')).toBe('France');
  });

  it.each(['currency read', 'name read', 'synchronous adapter throw'] as const)(
    'retries after a failed %s, without publishing a half-loaded currency',
    async (failure) => {
      const base = fixture(0);
      const read = vi.fn<DataSource['read']>((...args) => base.data.read(...args));
      const displayNames = vi.fn<DataSource['displayNames']>((...args) =>
        base.data.displayNames(...args),
      );
      if (failure === 'currency read') read.mockRejectedValueOnce(new Error('offline'));
      else if (failure === 'name read') displayNames.mockRejectedValueOnce(new Error('offline'));
      else
        read.mockImplementationOnce(() => {
          throw new Error('offline');
        });
      const context = { ...base.context, data: { ...base.data, read, displayNames } };
      const { result } = renderHook(() => useLookups(context));
      await act(async () => {
        await expect(result.current.ensure('res.partner', [partner], ['revenue'])).rejects.toThrow(
          'offline',
        );
      });
      expect(result.current.version).toBe(0);
      expect(result.current.currencyOf('cur-dzd')).toBeUndefined();
      await act(async () => {
        await result.current.ensure('res.partner', [partner], ['revenue']);
      });
      expect(read).toHaveBeenCalledTimes(2);
      expect(result.current.currencyOf('cur-dzd')).toEqual({ code: 'DZD', decimals: 2 });
      expect(result.current.version).toBeGreaterThan(0);
    },
  );

  it('propagates a shared request failure to each waiter and lets the next attempt retry', async () => {
    const base = fixture(0);
    const pending = deferred<ReadonlyMap<string, string>>();
    const displayNames = vi
      .fn<DataSource['displayNames']>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(new Map([['c-dz', 'Algérie']]));
    const context = { ...base.context, data: { ...base.data, displayNames } };
    const { result } = renderHook(() => useLookups(context));
    const first = result.current.ensure('res.partner', [partner], ['countryId']);
    const second = result.current.ensure('res.partner', [partner], ['countryId']);
    const outcome = Promise.allSettled([first, second]);
    await act(async () => {
      pending.reject(new Error('offline'));
      await outcome;
    });
    expect((await outcome).map((item) => item.status)).toEqual(['rejected', 'rejected']);
    expect(displayNames).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.ensure('res.partner', [partner], ['countryId']);
    });
    expect(displayNames).toHaveBeenCalledTimes(2);
    expect(result.current.nameOf('res.country', 'c-dz')).toBe('Algérie');
  });

  it('does not publish late names or currencies from an earlier data source into the new source', async () => {
    const base = fixture(0);
    const oldRows = deferred<RecordValues[]>();
    const oldNames = deferred<ReadonlyMap<string, string>>();
    const oldContext: ViewContext = {
      ...base.context,
      data: { ...base.data, read: () => oldRows.promise, displayNames: () => oldNames.promise },
    };
    const newContext: ViewContext = {
      ...base.context,
      data: {
        ...base.data,
        read: vi
          .fn<DataSource['read']>()
          .mockResolvedValue([{ id: 'cur-dzd', code: 'EUR', decimals: 3 }]),
        displayNames: vi.fn<DataSource['displayNames']>().mockResolvedValue(
          new Map([
            ['c-dz', 'New country'],
            ['cur-dzd', 'New currency'],
          ]),
        ),
      },
    };
    const { result, rerender } = renderHook((context: ViewContext) => useLookups(context), {
      initialProps: oldContext,
    });
    const oldRequest = result.current.ensure('res.partner', [partner], ['countryId', 'revenue']);
    rerender(newContext);
    expect(result.current.currencyOf('cur-dzd')).toBeUndefined();
    await act(async () => {
      await result.current.ensure('res.partner', [partner], ['countryId', 'revenue']);
    });
    const version = result.current.version;
    await act(async () => {
      oldRows.resolve([{ id: 'cur-dzd', code: 'DZD', decimals: 2 }]);
      oldNames.resolve(
        new Map([
          ['c-dz', 'Old country'],
          ['cur-dzd', 'Old currency'],
        ]),
      );
      await oldRequest;
    });
    expect(result.current.currencyOf('cur-dzd')).toEqual({ code: 'EUR', decimals: 3 });
    expect(result.current.nameOf('res.country', 'c-dz')).toBe('New country');
    expect(result.current.version).toBe(version);
  });

  it('resets cached lookups for a new registry but preserves them for presentation-only context changes', async () => {
    const { context, data } = fixture(0);
    const displayNames = vi.spyOn(data, 'displayNames');
    const { result, rerender } = renderHook((props: ViewContext) => useLookups(props), {
      initialProps: context,
    });
    await act(async () => {
      await result.current.ensure('res.partner', [partner], ['countryId']);
    });
    const ensure = result.current.ensure;
    rerender({ ...context, language: 'ar', density: 'compact' });
    expect(result.current.ensure).toBe(ensure);
    expect(result.current.nameOf('res.country', 'c-dz')).toBe('Algérie');
    rerender({ ...context, registry: { ...context.registry } });
    expect(result.current.nameOf('res.country', 'c-dz')).toBeUndefined();
    await act(async () => {
      await result.current.ensure('res.partner', [partner], ['countryId']);
    });
    expect(displayNames).toHaveBeenCalledTimes(2);
    expect(result.current.nameOf('res.country', 'c-dz')).toBe('Algérie');
  });
});
