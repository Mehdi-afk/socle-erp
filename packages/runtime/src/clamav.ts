// SPDX-License-Identifier: LGPL-3.0-only
//
// Virus scanning through clamd (ClamAV, GPL: a separate service reached over the network,
// ARCHITECTURE.md §11.4), with its INSTREAM protocol: the file is streamed in chunks, clamd
// answers "stream: OK" or "stream: <signature> FOUND". No library, no temporary file.
import { connect } from 'node:net';

import { SocleError } from '@socle/framework';

export class ClamavError extends SocleError {
  constructor(message: string, options?: ErrorOptions) {
    super('runtime.clamav', message, options);
  }
}

export interface ClamavConfig {
  readonly host: string;
  readonly port: number;
  /** Maximum time for one scan (default 60 s). */
  readonly timeoutMs?: number | undefined;
}

export type ScanResult =
  { readonly status: 'clean' } | { readonly status: 'infected'; readonly signature: string };

const CHUNK = 64 * 1024;

/** Sends `command` (a `z`-prefixed clamd command) and `payload` chunks; returns the answer. */
function exchange(
  config: ClamavConfig,
  command: string,
  chunks: readonly Uint8Array[] | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    const received: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error, answer?: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(answer ?? '');
    };
    socket.setTimeout(config.timeoutMs ?? 60_000, () => {
      finish(new ClamavError('clamd did not answer in time.'));
    });
    socket.on('error', (error) => {
      finish(new ClamavError('Cannot reach clamd.', { cause: error }));
    });
    socket.on('data', (data: Buffer) => {
      received.push(data);
      const text = Buffer.concat(received);
      const end = text.indexOf(0);
      if (end >= 0) finish(undefined, text.subarray(0, end).toString('utf8').trim());
    });
    // A connection closed without an answer is an error, never a hang nor a clean result.
    socket.on('close', () => {
      finish(new ClamavError('clamd closed the connection without an answer.'));
    });
    socket.on('end', () => {
      finish(undefined, Buffer.concat(received).toString('utf8').replace(/\0/g, '').trim());
    });
    socket.on('connect', () => {
      socket.write(`z${command}\0`);
      if (chunks) {
        for (const chunk of chunks) {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.byteLength);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk: end of stream
      }
    });
  });
}

/** True when clamd answers (`PING` → `PONG`). */
export async function pingClamav(config: ClamavConfig): Promise<boolean> {
  try {
    return (await exchange({ ...config, timeoutMs: 5000 }, 'PING', undefined)) === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Scans `data` with clamd.
 * @throws {@link ClamavError} when clamd cannot scan it (unreachable, size limit, error): the
 * file must then stay blocked, never be taken for clean.
 */
export async function scanWithClamav(config: ClamavConfig, data: Uint8Array): Promise<ScanResult> {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += CHUNK) {
    chunks.push(data.subarray(offset, Math.min(offset + CHUNK, data.byteLength)));
  }
  const answer = await exchange(config, 'INSTREAM', chunks);
  if (answer === 'stream: OK') return { status: 'clean' };
  const found = /^stream: (.{1,200}) FOUND$/.exec(answer);
  if (found?.[1]) return { status: 'infected', signature: found[1] };
  throw new ClamavError(`clamd could not scan the file: ${answer.slice(0, 200)}`);
}
