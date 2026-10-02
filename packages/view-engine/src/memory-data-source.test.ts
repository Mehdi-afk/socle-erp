// SPDX-License-Identifier: LGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { createMemoryDataSource } from './memory-data-source.js';

const MODEL = 'test.record';
const ORIGINAL = { id: 'r-1', name: 'Original', city: 'Alger', subscribed: true };
const FIELDS = ['name', 'city', 'subscribed'];

function source(delayMs = 0) {
  const data = createMemoryDataSource({ [MODEL]: [ORIGINAL] }, { delayMs });
  const write = data.write?.bind(data);
  if (!write) throw new Error('The memory data source must support writes.');
  return { data, write };
}

describe('MemoryDataSource: writes', () => {
  it('persists a patch while preserving the record id and every unchanged field', async () => {
    const { data, write } = source();

    await write(MODEL, 'r-1', { id: 'replacement-id', name: 'Renamed' });

    expect(await data.read(MODEL, ['r-1'], FIELDS)).toEqual([{ ...ORIGINAL, name: 'Renamed' }]);
    expect(await data.read(MODEL, ['replacement-id'], FIELDS)).toEqual([]);
    expect(data.writes).toHaveLength(1);
    expect(data.writes[0]).toMatchObject({ model: MODEL, id: 'r-1', values: { name: 'Renamed' } });
  });

  it('rejects an unknown record without journaling a write or changing existing records', async () => {
    const { data, write } = source();

    await expect(write(MODEL, 'missing', { name: 'New' })).rejects.toThrow();

    expect(data.writes).toEqual([]);
    expect(await data.read(MODEL, ['r-1', 'missing'], FIELDS)).toEqual([ORIGINAL]);
  });

  it('captures the submitted values before waiting, independently of later caller mutations', async () => {
    const { data, write } = source(5);
    const values = { name: 'Submitted' };

    const pending = write(MODEL, 'r-1', values);
    values.name = 'Changed by the caller';
    await pending;

    expect(await data.read(MODEL, ['r-1'], FIELDS)).toEqual([{ ...ORIGINAL, name: 'Submitted' }]);
    expect(data.writes).toEqual([{ model: MODEL, id: 'r-1', values: { name: 'Submitted' } }]);
  });

  it('merges simultaneous patches of different fields against the latest stored record', async () => {
    const { data, write } = source(5);

    await Promise.all([
      write(MODEL, 'r-1', { name: 'Renamed' }),
      write(MODEL, 'r-1', { city: 'Oran' }),
    ]);

    expect(await data.read(MODEL, ['r-1'], FIELDS)).toEqual([
      { ...ORIGINAL, name: 'Renamed', city: 'Oran' },
    ]);
    expect(data.writes).toHaveLength(2);
    expect(data.writes).toEqual(
      expect.arrayContaining([
        { model: MODEL, id: 'r-1', values: { name: 'Renamed' } },
        { model: MODEL, id: 'r-1', values: { city: 'Oran' } },
      ]),
    );
  });
});
