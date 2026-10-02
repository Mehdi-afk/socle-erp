// SPDX-License-Identifier: LGPL-3.0-only
import {
  Button,
  Skeleton,
  UiProvider,
  applyPreferences,
  directionOf,
  type Preferences,
} from '@socle/ui';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AuthError, createAuthClient, type AuthClient, type AuthResult } from './auth-client.js';
import { AuthScreen } from './auth-screen.js';
import { copyFor } from './copy.js';
import { DEFAULT_PREFERENCES, PreferenceControls } from './preferences.js';
import { connectWebClient, type WebClient, type WebClientOptions } from './rpc-data-source.js';
import { RpcDataError } from './rpc-errors.js';
import './app.css';

const Workspace = lazy(() => import('./workspace.js'));
export interface WebRuntime {
  readonly auth: () => AuthClient;
  readonly connect: (options: WebClientOptions) => Promise<WebClient>;
}
const browserRuntime: WebRuntime = { auth: createAuthClient, connect: connectWebClient };
type Callback = AuthResult | { readonly kind: 'failed' };
type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous'; readonly expired?: boolean }
  | { readonly kind: 'challenge'; readonly result: Extract<AuthResult, { kind: 'challenge' }> }
  | { readonly kind: 'active'; readonly client: WebClient }
  | { readonly kind: 'failed'; readonly error: RpcDataError };

/** The production entrypoint and an injectable runtime for session lifecycle tests. */
export function WebApp({
  runtime = browserRuntime,
  callback,
}: {
  readonly runtime?: WebRuntime;
  readonly callback?: Callback;
}): React.ReactElement {
  const [scope, setScope] = useState({ runtime, revision: 0 });
  if (scope.runtime !== runtime) setScope({ runtime, revision: scope.revision + 1 });
  return (
    <AppSession
      key={scope.revision}
      runtime={runtime}
      {...(callback === undefined ? {} : { callback })}
    />
  );
}

function AppSession({
  runtime,
  callback,
}: {
  readonly runtime: WebRuntime;
  readonly callback?: Callback;
}): React.ReactElement {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [state, setState] = useState<State>(() =>
    callback?.kind === 'challenge'
      ? { kind: 'challenge', result: callback }
      : callback?.kind === 'failed'
        ? { kind: 'anonymous' }
        : { kind: 'loading' },
  );
  const auth = useMemo(() => runtime.auth(), [runtime]);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const clientRef = useRef<WebClient | undefined>(undefined);
  const generationRef = useRef(0);
  const leavingRef = useRef(false);
  const expiredWhileLeavingRef = useRef(false);
  const copy = copyFor(preferences.language);
  const closeCurrent = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.abort();
    clientRef.current?.dispose();
    clientRef.current = undefined;
  }, []);
  const expiredDuringLogout = (): boolean => expiredWhileLeavingRef.current;

  useEffect(() => {
    applyPreferences(document.documentElement, preferences);
  }, [preferences]);

  const open = useCallback(async (): Promise<void> => {
    if (leavingRef.current) return;
    const version = ++generationRef.current;
    requestRef.current?.abort();
    clientRef.current?.dispose();
    clientRef.current = undefined;
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ kind: 'loading' });
    try {
      const client = await runtime.connect({
        language: preferences.language,
        signal: controller.signal,
      });
      if (controller.signal.aborted || version !== generationRef.current) {
        client.dispose();
        return;
      }
      clientRef.current = client;
      setState({ kind: 'active', client });
    } catch (failure) {
      if (controller.signal.aborted || version !== generationRef.current) return;
      const error = failure instanceof RpcDataError ? failure : new RpcDataError('unavailable');
      setState(
        error.code === 'unauthenticated' || error.code === 'csrf'
          ? { kind: 'anonymous' }
          : { kind: 'failed', error },
      );
    }
  }, [runtime, preferences.language]);
  const restore = useEffectEvent(() => {
    if (callback?.kind !== 'challenge' && callback?.kind !== 'failed') void open();
  });
  useEffect(() => {
    restore();
    return () => {
      closeCurrent();
      auth.dispose();
    };
  }, [auth, closeCurrent]);

  const expired = useCallback(() => {
    if (leavingRef.current) {
      expiredWhileLeavingRef.current = true;
      return;
    }
    ++generationRef.current;
    requestRef.current?.abort();
    clientRef.current?.dispose();
    clientRef.current = undefined;
    setState({ kind: 'anonymous', expired: true });
  }, []);
  const logout = useCallback(async (): Promise<void> => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    expiredWhileLeavingRef.current = false;
    const version = generationRef.current;
    const owner = clientRef.current;
    try {
      await auth.logout();
    } catch (error) {
      leavingRef.current = false;
      if (version === generationRef.current && expiredDuringLogout()) expired();
      throw error;
    }
    leavingRef.current = false;
    if (version !== generationRef.current || owner !== clientRef.current) return;
    ++generationRef.current;
    requestRef.current?.abort();
    clientRef.current?.dispose();
    clientRef.current = undefined;
    setState({ kind: 'anonymous' });
  }, [auth, expired]);

  return (
    <UiProvider dir={directionOf(preferences.language)}>
      {state.kind === 'active' ? (
        <Suspense fallback={<Loading copy={copy.loading} />}>
          <Workspace
            client={state.client}
            preferences={preferences}
            onPreferences={setPreferences}
            onExpired={expired}
            onLogout={logout}
          />
        </Suspense>
      ) : (
        <div className="web-login-page">
          <header className="web-login-header">
            <Brand />
            <PreferenceControls value={preferences} onChange={setPreferences} />
          </header>
          <main className="web-login-main">
            {state.kind === 'loading' ? (
              <Loading copy={copy.loading} />
            ) : state.kind === 'failed' ? (
              <section className="web-auth-card">
                <h1>{copy.failed}</h1>
                <p className="web-error" role="alert">
                  {new RpcDataError(state.error.code, preferences.language).message}
                </p>
                <Button
                  variant="primary"
                  onClick={() => {
                    void open();
                  }}
                >
                  {copy.retry}
                </Button>
              </section>
            ) : (
              <AuthScreen
                client={auth}
                language={preferences.language}
                onAuthenticated={() => {
                  void open();
                }}
                {...(state.kind === 'challenge' ? { initialChallenge: state.result } : {})}
                {...(state.kind === 'anonymous' && state.expired
                  ? { notice: copy.expired }
                  : callback?.kind === 'failed'
                    ? { notice: copy.oidcFailed }
                    : {})}
              />
            )}
          </main>
          <footer className="web-login-footer">Socle ERP</footer>
        </div>
      )}
    </UiProvider>
  );
}

export function Brand(): React.ReactElement {
  return (
    <span className="web-brand">
      <span className="web-brand-mark" aria-hidden="true">
        s
      </span>
      Socle<span className="web-brand-suffix">ERP</span>
    </span>
  );
}
function Loading({ copy }: { readonly copy: string }): React.ReactElement {
  return (
    <div className="web-loading">
      <Skeleton label={copy} />
    </div>
  );
}

/** Localize errors from auth operations (logout) without exposing transport details. */
export function authMessage(error: unknown, language: string): string {
  return new AuthError(error instanceof AuthError ? error.code : 'unavailable', language).message;
}
