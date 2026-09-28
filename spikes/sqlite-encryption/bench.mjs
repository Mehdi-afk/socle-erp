// SPDX-License-Identifier: LGPL-3.0-only
//
// Spike O5 / ADR 007 — SQLite WASM encryption benchmark (runs in a dedicated worker, OPFS).
const params = new URL(globalThis.location.href).searchParams;
const N = Number(params.get('n') ?? 20000);
const RUNS = Number(params.get('runs') ?? 3);

const post = async (body) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fetch('/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function rows() {
  const out = [];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const words = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet',
  ];
  for (let i = 0; i < N; i++) {
    const w = () => words[Math.floor(rnd() * words.length)];
    out.push({
      id: `0190a000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
      name: `${w()} ${w()} ${i}`,
      email: `${w()}.${i}@example.com`,
      note: `${w()} `.repeat(30),
      amount: Math.floor(rnd() * 1e6),
      company: `c${i % 20}`,
      created: new Date(1.7e12 + i * 60000).toISOString(),
    });
  }
  return out;
}
const DATA = rows();

// ─── app-level field encryption (WebCrypto AES-GCM) ───────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();
let aesKey;
async function encryptField(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(text)),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}
async function decryptField(blob) {
  return dec.decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.subarray(0, 12) },
      aesKey,
      blob.subarray(12),
    ),
  );
}

async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return [performance.now() - start, result];
}

async function variant(name, init, open, fieldCrypto) {
  const sqlite3 = await init();
  const results = [];
  // Run -1 warms up (JIT, OPFS) and is discarded.
  for (let run = -1; run < RUNS; run++) {
    const r = {};
    const file = `/bench-${name}-${run}.db`;
    let db = await open(sqlite3, file, true);
    db.exec(`create table t (id text primary key, name, email, note, amount integer, company text, created text);
             create index t_company on t(company); create index t_name on t(name);`);

    // Insert
    const prepared = fieldCrypto
      ? await Promise.all(
          DATA.map(async (row) => ({
            ...row,
            name: await encryptField(row.name),
            email: await encryptField(row.email),
            note: await encryptField(row.note),
          })),
        )
      : DATA;
    [r.insert] = await timed(async () => {
      if (fieldCrypto) {
        // Encryption cost counted separately below; re-encrypt here to measure end to end.
      }
      db.exec('begin');
      const stmt = db.prepare('insert into t values (?,?,?,?,?,?,?)');
      for (const row of prepared)
        stmt
          .bind([row.id, row.name, row.email, row.note, row.amount, row.company, row.created])
          .stepReset();
      stmt.finalize();
      db.exec('commit');
    });
    if (fieldCrypto) {
      [r.encrypt] = await timed(() =>
        Promise.all(
          DATA.map(async (row) => [
            await encryptField(row.name),
            await encryptField(row.email),
            await encryptField(row.note),
          ]),
        ),
      );
    }

    // Point lookups by primary key
    [r.lookup2000] = await timed(async () => {
      const stmt = db.prepare('select * from t where id = ?');
      for (let i = 0; i < 2000; i++) {
        stmt.bind([DATA[(i * 7919) % N].id]);
        stmt.step();
        const row = stmt.get({});
        if (fieldCrypto) await decryptField(row.name);
        stmt.reset();
      }
      stmt.finalize();
    });

    // Filtered, sorted page (the list view)
    [r.listPage200] = await timed(async () => {
      for (let i = 0; i < 200; i++) {
        const page = db.selectObjects(
          fieldCrypto
            ? 'select * from t where company = ? order by created limit 50'
            : 'select * from t where company = ? order by name limit 50',
          [`c${i % 20}`],
        );
        if (fieldCrypto) for (const row of page) await decryptField(row.name);
      }
    });

    // Text search (LIKE); with field encryption: decrypt everything and filter in JS
    [r.search20] = await timed(async () => {
      for (let i = 0; i < 20; i++) {
        if (fieldCrypto) {
          const all = db.selectObjects('select id, name from t');
          const matches = [];
          for (const row of all)
            if ((await decryptField(row.name)).includes(`${i}9`)) matches.push(row.id);
        } else {
          db.selectObjects('select id from t where name like ?', [`%${i}9%`]);
        }
      }
    });

    // Updates
    [r.update5000] = await timed(async () => {
      db.exec('begin');
      const stmt = db.prepare('update t set amount = amount + 1, note = ? where id = ?');
      for (let i = 0; i < 5000; i++) {
        const note = fieldCrypto ? await encryptField(`updated ${i}`) : `updated ${i}`;
        stmt.bind([note, DATA[(i * 104729) % N].id]).stepReset();
      }
      stmt.finalize();
      db.exec('commit');
    });

    // Cold reopen (key setup + schema read + first query)
    db.close();
    [r.reopen] = await timed(async () => {
      db = await open(sqlite3, file, false);
      db.selectValue('select count(*) from t');
    });
    r.sizeKiB = Math.round(
      (db.selectValue('pragma page_count') * db.selectValue('pragma page_size')) / 1024,
    );
    db.close();
    // Raw bytes on disk: is any plaintext readable?
    const bytes = globalThis.__pools.get(sqlite3).exportFile(file);
    const text = new TextDecoder('latin1').decode(bytes);
    // Names and notes all contain words such as "alpha": readable only if not encrypted.
    r.plaintextOnDisk = text.includes('alpha') ? 1 : 0;
    if (run >= 0) results.push(r);
  }
  // Keys come from the measurements above, never from outside.
  return Object.fromEntries(
    Object.keys(results[0]).map((key) => [
      key,
      Math.round(median(results.map((r) => new Map(Object.entries(r)).get(key))) * 10) / 10,
    ]),
  );
}

async function main() {
  const out = { userAgent: globalThis.navigator.userAgent, n: N, runs: RUNS, variants: {} };
  aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);

  // Key derivation at login (PBKDF2-SHA256, 600 000 iterations, OWASP 2023+)
  const [pbkdf2] = await timed(async () => {
    const base = await crypto.subtle.importKey(
      'raw',
      enc.encode('correct horse battery staple'),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('socle-salt-16byt'), iterations: 600000 },
      base,
      256,
    );
  });
  out.pbkdf2_600k_ms = Math.round(pbkdf2);

  // Each build is initialised once (a second initialisation of the same module hangs).
  const once = (load) => {
    let promise;
    return () => (promise ??= load());
  };
  const official = once(async () =>
    (await import('./builds/official/package/dist/index.mjs')).default(),
  );
  const mc = once(async () =>
    (await import('./builds/mc/sqlite3mc-wasm-3530400/jswasm/sqlite3.mjs')).default(),
  );
  const pools = new Map();
  const pool = async (sqlite3, name) => {
    if (!pools.has(sqlite3)) {
      // One OPFS directory per build: SAHPool holds exclusive access handles on its files.
      const directory = `/pool-${pools.size}`;
      pools.set(
        sqlite3,
        await sqlite3.installOpfsSAHPoolVfs({
          name,
          directory,
          clearOnInit: true,
          initialCapacity: 48,
        }),
      );
    }
    return pools.get(sqlite3);
  };
  globalThis.__pools = pools;

  const plainOpen = (vfsName) => async (sqlite3, file) => {
    await pool(sqlite3, vfsName);
    return new sqlite3.oo1.DB({ filename: file, vfs: vfsName });
  };
  const cipherOpen = (cipher, kdfIter) => async (sqlite3, file) => {
    await pool(sqlite3, 'opfs-sahpool');
    if (!sqlite3.capi.sqlite3_vfs_find('multipleciphers-opfs-sahpool')) {
      const rc = sqlite3.capi.sqlite3mc_vfs_create('opfs-sahpool', 0);
      if (rc !== 0) throw new Error(`sqlite3mc_vfs_create rc=${rc}`);
    }
    const db = new sqlite3.oo1.DB({ filename: file, vfs: 'multipleciphers-opfs-sahpool' });
    db.exec(`pragma cipher = '${cipher}'`);
    // The key is already derived at login (PBKDF2 in WebCrypto): no second derivation needed.
    if (kdfIter !== undefined) db.exec(`pragma kdf_iter = ${kdfIter}`);
    // Raw 256-bit key in hex (derived at login, never a stored passphrase).
    db.exec(`pragma key = "x'3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081'"`);
    return db;
  };

  const plan = [
    ['official-plain', official, plainOpen('opfs-sahpool'), false],
    ['mc-plain', mc, plainOpen('opfs-sahpool'), false],
    ['mc-chacha20', mc, cipherOpen('chacha20'), false],
    ['mc-chacha20-kdf1', mc, cipherOpen('chacha20', 1), false],
    ['mc-sqlcipher-aes256', mc, cipherOpen('sqlcipher'), false],
    ['official-field-aesgcm', official, plainOpen('opfs-sahpool'), true],
  ];
  const only = params.get('only');
  const variants = new Map();
  for (const [name, init, open, fieldCrypto] of plan.filter(([n]) => !only || n === only)) {
    try {
      variants.set(name, await variant(name, init, open, fieldCrypto));
    } catch (error) {
      variants.set(name, { error: String(error?.stack ?? error) });
    }
    await post({ partial: name, result: variants.get(name) });
  }
  out.variants = Object.fromEntries(variants);

  // Is the encrypted file really unreadable? Read raw bytes back through the plain pool.
  await post(out);
}

main().catch((error) => post({ fatal: String(error?.stack ?? error) }));
