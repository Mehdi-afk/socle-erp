// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, use, useMemo } from 'react';

import { messagesFor, type Messages } from './messages.js';
import type { ViewContext } from './types.js';

interface Engine {
  readonly view: ViewContext;
  readonly messages: Messages;
}

const EngineContext = createContext<Engine | undefined>(undefined);

export interface ViewEngineProviderProps {
  readonly context: ViewContext;
  readonly children: React.ReactNode;
}

/** Gives every view below it the models, the data source, the language and the density. */
export function ViewEngineProvider({
  context,
  children,
}: ViewEngineProviderProps): React.ReactElement {
  const value = useMemo(
    () => ({ view: context, messages: messagesFor(context.language) }),
    [context],
  );
  return <EngineContext value={value}>{children}</EngineContext>;
}

/** The context of the view being rendered. */
export function useViewContext(): ViewContext {
  const engine = use(EngineContext);
  if (!engine) throw new Error('A view must be rendered inside a ViewEngineProvider.');
  return engine.view;
}

/** The engine's own words in the user's language. */
export function useMessages(): Messages {
  const engine = use(EngineContext);
  if (!engine) throw new Error('A view must be rendered inside a ViewEngineProvider.');
  return engine.messages;
}
