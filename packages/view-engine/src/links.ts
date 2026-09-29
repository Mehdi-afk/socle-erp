// SPDX-License-Identifier: LGPL-3.0-only
//
// Values that become links (phone, email, web address) come from users: they are turned into a
// link only when they have a safe shape, so that `javascript:` and its cousins can never be run.

/** `tel:` link for a phone number, or undefined when it does not look like one. */
export function phoneHref(value: string): string | undefined {
  const digits = value.replace(/[\s.\-()]/g, '');
  return /^\+?\d{4,20}$/.test(digits) ? `tel:${digits}` : undefined;
}

/** `mailto:` link for an email address, or undefined. */
export function emailHref(value: string): string | undefined {
  const address = value.trim();
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(address)
    ? `mailto:${address}`
    : undefined;
}

/** The address itself for an `http` or `https` web address, or undefined for anything else. */
export function webHref(value: string): string | undefined {
  const text = value.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
