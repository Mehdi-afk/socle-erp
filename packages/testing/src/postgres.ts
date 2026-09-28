// SPDX-License-Identifier: LGPL-3.0-only
//
// Ephemeral PostgreSQL for integration tests (ADR 010): drives the `docker` command directly,
// with no third-party library. The container listens on 127.0.0.1 only, on a random port,
// with a random password, and is removed by `stop()` (and by Docker itself thanks to `--rm`).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** PostgreSQL 18.6 (alpine), pinned by digest: a moved tag never changes what the tests run. */
export const POSTGRES_IMAGE =
  'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

/** Label set on every test container, to find leftovers: `docker ps -a --filter label=socle.test`. */
export const TEST_LABEL = 'socle.test=postgres';

export interface EphemeralPostgres {
  /** Connection URL of the `postgres` maintenance database (superuser `socle`). */
  readonly url: string;
  readonly containerId: string;
  /** Removes the container and its data. Idempotent. */
  stop(): Promise<void>;
}

export interface StartPostgresOptions {
  /** Docker executable (default: `DOCKER_BIN` environment variable, then `docker`). */
  readonly docker?: string | undefined;
  /** Maximum wait for the server to accept TCP connections (default 60 s). */
  readonly timeoutMs?: number | undefined;
}

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const HOST_PORT = /^127\.0\.0\.1:(\d{1,5})$/m;

/**
 * Starts a throw-away PostgreSQL server in Docker and waits until it accepts connections.
 * Fails loudly when Docker is unavailable: integration tests are never silently skipped.
 */
export async function startPostgres(
  options: StartPostgresOptions = {},
): Promise<EphemeralPostgres> {
  const docker = options.docker ?? process.env.DOCKER_BIN ?? 'docker';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const password = randomUUID();

  const { stdout } = await run(docker, [
    'run',
    '--detach',
    '--rm',
    '--label',
    TEST_LABEL,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_USER=socle',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C.UTF-8',
    '--tmpfs',
    '/var/lib/postgresql',
    POSTGRES_IMAGE,
    // Throw-away data: durability is useless and only slows the tests down.
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
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
    const port = await publishedPort(docker, containerId);
    await waitUntilReady(docker, containerId, password, timeoutMs);
    const url = `postgres://socle:${password}@127.0.0.1:${String(port)}/postgres`;
    return { url, containerId, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function publishedPort(docker: string, containerId: string): Promise<number> {
  const { stdout } = await run(docker, ['port', containerId, '5432/tcp']);
  const match = HOST_PORT.exec(stdout);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Cannot read the published port: ${stdout}`);
  }
  return port;
}

/**
 * The official image first runs a temporary server on the Unix socket only, then restarts:
 * probing over TCP inside the container only succeeds once the final server is up.
 */
async function waitUntilReady(
  docker: string,
  containerId: string,
  password: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await run(docker, [
        'exec',
        '--env',
        `PGPASSWORD=${password}`,
        containerId,
        'psql',
        '--host=127.0.0.1',
        '--username=socle',
        '--dbname=postgres',
        '--no-psqlrc',
        '--quiet',
        '--command=SELECT 1',
      ]);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`PostgreSQL did not become ready within ${String(timeoutMs)} ms`, {
    cause: lastError,
  });
}
