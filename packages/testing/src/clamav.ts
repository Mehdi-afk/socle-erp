// SPDX-License-Identifier: LGPL-3.0-only
//
// Ephemeral ClamAV (clamd) for integration tests, driven through the `docker` command like
// PostgreSQL (ADR 010). The image carries its signature database; updates are off so that the
// tests are reproducible and work offline.
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * ClamAV 1.5.3 (published 2026-08-03) with its signatures, pinned by digest. The images are
 * rebuilt every day with fresh signatures; tests only need old ones (EICAR).
 */
export const CLAMAV_IMAGE =
  'clamav/clamav:1.5.3@sha256:d06c1d6a451d616e1dd79b42f44c8c8c291bba9cf4e75ebc4d0e43c1c6dd87bb';

export interface EphemeralClamav {
  readonly host: string;
  readonly port: number;
  readonly containerId: string;
  stop(): Promise<void>;
}

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const HOST_PORT = /^127\.0\.0\.1:(\d{1,5})$/m;

function ping(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    let answer = '';
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => {
      done(false);
    });
    socket.on('error', () => {
      done(false);
    });
    // While clamd starts, Docker's port proxy accepts the connection then closes it at once.
    socket.on('close', () => {
      done(answer.startsWith('PONG'));
    });
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (data: Buffer) => {
      answer += data.toString('utf8');
      if (answer.includes('\0')) done(answer.startsWith('PONG'));
    });
  });
}

/**
 * Starts a throw-away clamd and waits until its signatures are loaded (it answers PING).
 * Loading takes up to a minute; fails loudly when Docker is unavailable.
 */
export async function startClamav(
  options: { readonly docker?: string; readonly timeoutMs?: number } = {},
): Promise<EphemeralClamav> {
  const docker = options.docker ?? process.env.DOCKER_BIN ?? 'docker';
  const timeoutMs = options.timeoutMs ?? 180_000;
  const { stdout } = await run(docker, [
    'run',
    '--detach',
    '--rm',
    '--label',
    'socle.test=clamav',
    '--publish',
    '127.0.0.1::3310',
    '--env',
    'CLAMAV_NO_FRESHCLAMD=true',
    '--env',
    'CLAMAV_NO_MILTERD=true',
    CLAMAV_IMAGE,
  ]);
  const containerId = stdout.trim();
  if (!CONTAINER_ID.test(containerId)) throw new Error(`Unexpected docker output: ${stdout}`);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await run(docker, ['rm', '--force', '--volumes', containerId]).catch(() => undefined);
  };
  try {
    const { stdout: ports } = await run(docker, ['port', containerId, '3310/tcp']);
    const port = Number(HOST_PORT.exec(ports)?.[1]);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Cannot read the port: ${ports}`);
    const deadline = Date.now() + timeoutMs;
    while (!(await ping(port))) {
      if (Date.now() > deadline)
        throw new Error(`ClamAV did not start within ${String(timeoutMs)} ms`);
      await delay(1000);
    }
    return { host: '127.0.0.1', port, containerId, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
