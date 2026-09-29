// SPDX-License-Identifier: LGPL-3.0-only
//
// A software authenticator for tests: what a phone or a security key does during a WebAuthn
// ceremony, with a real ES256 key pair and real signatures, so that the server code is tested
// against genuine responses (attestation "none", the format every platform passkey can use).
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const head = (major: number, n: number): Buffer => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
};

/** The few CBOR types WebAuthn uses here: integers, text, bytes and maps. */
export function cbor(value: unknown): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    const entries = [...(value as Map<unknown, unknown>)].flatMap(([k, v]) => [cbor(k), cbor(v)]);
    return Buffer.concat([head(5, value.size), ...entries]);
  }
  throw new TypeError('Unsupported CBOR value.');
}

const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export interface CeremonyOptions {
  /** Where the browser says the page is (default: the real origin). */
  readonly origin?: string | undefined;
  /** The relying party id the authenticator signs for (default: the real one). */
  readonly rpId?: string | undefined;
  /** False simulates a device that did not verify the user. */
  readonly userVerified?: boolean | undefined;
  /** Signature counter to report (default: one more than the last). */
  readonly counter?: number | undefined;
}

export interface VirtualAuthenticator {
  /** The credential id (base64url). */
  readonly id: string;
  /** Answers `navigator.credentials.create()`. */
  create(
    options: { challenge: string },
    rp: { id: string; origin: string },
    overrides?: CeremonyOptions,
  ): Record<string, unknown>;
  /** Answers `navigator.credentials.get()`. */
  get(
    options: { challenge: string },
    rp: { id: string; origin: string },
    userHandle: string,
    overrides?: CeremonyOptions,
  ): Record<string, unknown>;
}

export function virtualAuthenticator(): VirtualAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(16);
  const id = credentialId.toString('base64url');
  let counter = 0;

  const clientData = (type: string, challenge: string, origin: string): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  const counterBytes = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };

  return {
    id,
    create(options, rp, overrides = {}) {
      const flags = UP | AT | (overrides.userVerified === false ? 0 : UV);
      const cose = new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(overrides.rpId ?? rp.id),
        Buffer.from([flags]),
        counterBytes(overrides.counter ?? counter),
        Buffer.alloc(16),
        idLength,
        credentialId,
        cbor(cose),
      ]);
      const attestationObject = cbor(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: clientData(
            'webauthn.create',
            options.challenge,
            overrides.origin ?? rp.origin,
          ).toString('base64url'),
          attestationObject: attestationObject.toString('base64url'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },

    get(options, rp, userHandle, overrides = {}) {
      counter = overrides.counter ?? counter + 1;
      const flags = UP | (overrides.userVerified === false ? 0 : UV);
      const authData = Buffer.concat([
        sha256(overrides.rpId ?? rp.id),
        Buffer.from([flags]),
        counterBytes(counter),
      ]);
      const data = clientData('webauthn.get', options.challenge, overrides.origin ?? rp.origin);
      const signature = sign('sha256', Buffer.concat([authData, sha256(data)]), privateKey);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: data.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle: Buffer.from(userHandle).toString('base64url'),
        },
        clientExtensionResults: {},
      };
    },
  };
}
