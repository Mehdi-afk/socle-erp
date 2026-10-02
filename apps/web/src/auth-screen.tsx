// SPDX-License-Identifier: LGPL-3.0-only
import { Button, SelectField, TextField } from '@socle/ui';
import { useEffect, useRef, useState } from 'react';

import {
  AuthError,
  oidcStartPath,
  type AuthClient,
  type AuthMethod,
  type AuthProvider,
  type AuthResult,
} from './auth-client.js';
import { copyFor } from './copy.js';

type Challenge = Extract<AuthResult, { kind: 'challenge' }>;
export interface AuthScreenProps {
  readonly client: AuthClient;
  readonly language: string;
  readonly initialChallenge?: Challenge;
  readonly notice?: string;
  readonly onAuthenticated: () => void;
}

/** Only in-memory passwords, challenges, setup keys and recovery codes. */
export function AuthScreen(props: AuthScreenProps): React.ReactElement {
  const [scope, setScope] = useState({ client: props.client, revision: 0 });
  if (scope.client !== props.client)
    setScope({ client: props.client, revision: scope.revision + 1 });
  return <AuthForm key={scope.revision} {...props} />;
}

function AuthForm({
  client,
  language,
  initialChallenge,
  notice,
  onAuthenticated,
}: AuthScreenProps): React.ReactElement {
  const copy = copyFor(language);
  const [challenge, setChallenge] = useState(initialChallenge);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [method, setMethod] = useState<AuthMethod>(
    initialChallenge?.methods.find(
      (item) => initialChallenge.mfa !== 'enroll' || item !== 'passkey',
    ) ?? 'totp',
  );
  const [secret, setSecret] = useState<string>();
  const [codes, setCodes] = useState<readonly string[]>();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<AuthError>();
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<readonly AuthProvider[]>([]);
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    void client
      .providers()
      .then((items) => {
        if (mountedRef.current) setProviders(items);
      })
      .catch(() => {
        /* Password sign-in remains available when provider discovery is unavailable. */
      });
    return () => {
      mountedRef.current = false;
    };
  }, [client]);

  async function run(work: () => Promise<void>): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      if (mountedRef.current)
        setError(failure instanceof AuthError ? failure : new AuthError('unavailable'));
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (challenge === undefined) {
      const result = await client.login(login.trim(), password);
      if (!mountedRef.current) return;
      setPassword('');
      if (result.kind === 'authenticated') {
        onAuthenticated();
        return;
      }
      setChallenge(result);
      setMethod(
        result.methods.find((item) => result.mfa !== 'enroll' || item !== 'passkey') ?? 'totp',
      );
      return;
    }
    if (method === 'passkey') {
      await client.passkey(challenge.challenge);
    } else if (challenge.mfa === 'enroll' && method === 'totp') {
      const result = await client.confirmTotp(challenge.challenge, code.trim());
      if (mountedRef.current) {
        setCodes(result);
        setSecret(undefined);
        setCode('');
      }
      return;
    } else if (challenge.mfa === 'enroll' && method === 'email') {
      await client.confirmEmail(challenge.challenge, code.trim());
    } else {
      await client.verify(
        challenge.challenge,
        method === 'email'
          ? { emailCode: code.trim() }
          : method === 'recovery'
            ? { recovery: code.trim() }
            : { code: code.trim() },
      );
    }
    if (mountedRef.current) {
      setCode('');
      onAuthenticated();
    }
  }

  function restart(): void {
    if (pendingRef.current) return;
    setChallenge(undefined);
    setSecret(undefined);
    setCode('');
    setError(undefined);
    setSent(false);
    setPassword('');
  }
  const methods =
    challenge?.methods.filter(
      (item) => challenge.mfa !== 'enroll' || (item !== 'passkey' && item !== 'recovery'),
    ) ?? [];
  return (
    <section className="web-auth-card" aria-labelledby="auth-title">
      <header>
        <h1 id="auth-title">
          {codes !== undefined
            ? copy.codes
            : challenge === undefined
              ? copy.title
              : challenge.mfa === 'enroll'
                ? copy.enroll
                : copy.verify}
        </h1>
        <p>
          {codes !== undefined
            ? copy.codesHint
            : challenge === undefined
              ? copy.subtitle
              : challenge.mfa === 'enroll'
                ? copy.enrollHint
                : copy.verifyHint}
        </p>
      </header>
      {notice === undefined || challenge !== undefined ? null : (
        <p className="web-notice" role="status">
          {notice}
        </p>
      )}
      {error === undefined ? null : (
        <p className="web-error" role="alert">
          {new AuthError(error.code, language).message}
        </p>
      )}
      {codes !== undefined ? (
        <>
          <ul className="web-recovery-codes" dir="ltr">
            {codes.map((item) => (
              <li key={item}>
                <code>{item}</code>
              </li>
            ))}
          </ul>
          <Button variant="primary" onClick={onAuthenticated}>
            {copy.savedCodes}
          </Button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(submit);
          }}
          aria-busy={busy}
        >
          {challenge === undefined ? (
            <>
              <TextField
                label={copy.login}
                name="username"
                autoComplete="username"
                value={login}
                required
                maxLength={254}
                disabled={busy}
                onChange={(event) => {
                  setLogin(event.target.value);
                }}
              />
              <TextField
                label={copy.password}
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                required
                maxLength={1024}
                disabled={busy}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </>
          ) : (
            <>
              <SelectField
                label={copy.method}
                value={method}
                options={methods.map((item) => ({ value: item, label: copy[item] }))}
                disabled={busy}
                onChange={(event) => {
                  const next = methods.find((item) => item === event.target.value);
                  if (next !== undefined) {
                    setMethod(next);
                    setCode('');
                    setError(undefined);
                    setSent(false);
                    setSecret(undefined);
                  }
                }}
              />
              {method === 'totp' && challenge.mfa === 'enroll' ? (
                secret === undefined ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        const result = await client.setupTotp(challenge.challenge);
                        if (mountedRef.current) setSecret(result.secret);
                      });
                    }}
                  >
                    {copy.setup}
                  </Button>
                ) : (
                  <TextField
                    label={copy.secret}
                    value={secret}
                    readOnly
                    autoComplete="off"
                    dir="ltr"
                    hint={copy.secretHint}
                  />
                )
              ) : null}
              {method === 'email' ? (
                <>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        if (challenge.mfa === 'enroll')
                          await client.enableEmail(challenge.challenge);
                        else await client.sendEmail(challenge.challenge);
                        if (mountedRef.current) setSent(true);
                      });
                    }}
                  >
                    {copy.send}
                  </Button>
                  {sent ? (
                    <p className="web-notice" role="status">
                      {copy.sent}
                    </p>
                  ) : null}
                </>
              ) : null}
              {method === 'passkey' ? null : (
                <TextField
                  label={method === 'recovery' ? copy.recovery : copy.code}
                  value={code}
                  required
                  autoComplete={method === 'recovery' ? 'off' : 'one-time-code'}
                  inputMode={method === 'recovery' ? 'text' : 'numeric'}
                  pattern={method === 'recovery' ? undefined : '[0-9]{6}'}
                  maxLength={method === 'recovery' ? 30 : 6}
                  dir="ltr"
                  disabled={busy}
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                />
              )}
            </>
          )}
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={
              busy || (challenge?.mfa === 'enroll' && method === 'totp' && secret === undefined)
            }
          >
            {challenge === undefined
              ? copy.signIn
              : method === 'passkey'
                ? copy.passkey
                : copy.confirm}
          </Button>
          {challenge === undefined ? (
            providers.map((provider) => (
              <a
                className="web-provider"
                key={provider.id}
                href={oidcStartPath(provider.id)}
                aria-disabled={busy}
                onClick={(event) => {
                  if (pendingRef.current) event.preventDefault();
                }}
              >
                {copy.oidc} {provider.label}
              </a>
            ))
          ) : (
            <Button variant="ghost" disabled={busy} onClick={restart}>
              {copy.restart}
            </Button>
          )}
        </form>
      )}
    </section>
  );
}
