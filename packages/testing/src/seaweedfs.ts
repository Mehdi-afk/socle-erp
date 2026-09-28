// SPDX-License-Identifier: LGPL-3.0-only
//
// Ephemeral S3 storage for integration tests: SeaweedFS (ADR 012), the self-hosted default,
// driven through the `docker` command like PostgreSQL (ADR 010). Authentication is on, so the
// request signing of the S3 client is really checked.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** SeaweedFS 4.46 (published 2026-09-08), pinned by digest. */
export const SEAWEEDFS_IMAGE =
  'chrislusf/seaweedfs:4.46@sha256:08d516132314207d10c8e37cbffc1f32b147d870169688734cc61c6231625b62';

export interface EphemeralS3 {
  /** S3 endpoint, e.g. `http://127.0.0.1:49153`. */
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly containerId: string;
  stop(): Promise<void>;
}

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const HOST_PORT = /^127\.0\.0\.1:(\d{1,5})$/m;

/**
 * Starts a throw-away SeaweedFS with its S3 gateway and one identity with full rights, and
 * waits until the gateway answers. Fails loudly when Docker is unavailable.
 */
export async function startSeaweedfs(
  options: { readonly docker?: string; readonly timeoutMs?: number } = {},
): Promise<EphemeralS3> {
  const docker = options.docker ?? process.env.DOCKER_BIN ?? 'docker';
  const timeoutMs = options.timeoutMs ?? 90_000;
  const accessKeyId = `socle${randomBytes(8).toString('hex')}`;
  const secretAccessKey = randomBytes(24).toString('hex');
  const config = JSON.stringify({
    identities: [
      {
        name: 'socle',
        credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
      },
    ],
  });

  const { stdout } = await run(docker, [
    'run',
    '--detach',
    '--rm',
    '--label',
    'socle.test=seaweedfs',
    '--publish',
    '127.0.0.1::8333',
    '--tmpfs',
    '/data',
    '--env',
    `S3_CONFIG=${config}`,
    '--entrypoint',
    'sh',
    SEAWEEDFS_IMAGE,
    '-c',
    // The configuration comes from the environment (no shell interpolation of values).
    'printf "%s" "$S3_CONFIG" > /tmp/s3.json && exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/tmp/s3.json -master.volumeSizeLimitMB=64 -volume.max=8',
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
    const { stdout: ports } = await run(docker, ['port', containerId, '8333/tcp']);
    const port = Number(HOST_PORT.exec(ports)?.[1]);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`Cannot read the port: ${ports}`);
    const endpoint = `http://127.0.0.1:${String(port)}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        // Anonymous request: any HTTP answer (403 included) means the gateway is up.
        const response = await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(2000) });
        await response.arrayBuffer();
        if (response.status < 500) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline)
        throw new Error(`SeaweedFS did not start within ${String(timeoutMs)} ms`);
      await delay(500);
    }
    return { endpoint, accessKeyId, secretAccessKey, containerId, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
