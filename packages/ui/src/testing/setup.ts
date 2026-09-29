// SPDX-License-Identifier: LGPL-3.0-only
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom lacks a few browser APIs that the pop-up components (Radix) use: stub them if missing.
const polyfill = (target: object, name: string, value: unknown): void => {
  if (!Reflect.has(target, name)) Reflect.set(target, name, value);
};

class ResizeObserverStub {
  observe = (): void => undefined;
  unobserve = (): void => undefined;
  disconnect = (): void => undefined;
}

// The build test of the guide runs in Node, without a DOM.
if (typeof document !== 'undefined') {
  polyfill(globalThis, 'ResizeObserver', ResizeObserverStub);
  polyfill(Element.prototype, 'hasPointerCapture', () => false);
  polyfill(Element.prototype, 'setPointerCapture', () => undefined);
  polyfill(Element.prototype, 'releasePointerCapture', () => undefined);
  polyfill(Element.prototype, 'scrollIntoView', () => undefined);
}

afterEach(() => {
  cleanup();
});
