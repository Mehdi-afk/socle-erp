// SPDX-License-Identifier: LGPL-3.0-only
import { createInterface } from 'node:readline';

import { startPostgres } from '@socle/testing';

import { createWebBrowserFixture } from './fixture.js';

const input = createInterface({ input: process.stdin });
const interrupted = new Promise<void>((resolve) => {
  const stop = (): void => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    input.close();
    resolve();
  };
  input.once('line', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
});
const postgres = await startPostgres();
try {
  const fixture = await createWebBrowserFixture(postgres.url);
  try {
    console.log(`Démonstration locale : ${fixture.url}`);
    console.log('Comptes factices, données effacées à l’arrêt :');
    for (const account of Object.values(fixture.credentials)) {
      console.log(`${account.login} / ${account.password}`);
    }
    console.log('Appuyez sur Entrée pour arrêter la démonstration et effacer ses données.');
    await interrupted;
  } finally {
    await fixture.close();
  }
} finally {
  input.close();
  await postgres.stop();
}
