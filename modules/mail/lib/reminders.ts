// SPDX-License-Identifier: LGPL-3.0-only
import { AccessError, MissingRecordError, type Environment } from '@socle/framework';
import { z } from 'zod';

/** Calendar day at an instant; legacy or invalid zones fall back to UTC. */
export function reminderDay(instant: string, timeZone: string | null): string {
  z.iso.datetime().parse(instant);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  const parts = formatter.formatToParts(new Date(instant));
  const part = (name: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Trusted scheduler only. The marker and unique reminder share the worker transaction. */
export async function remindActivities(
  env: Environment,
  instant = new Date().toISOString(),
): Promise<number> {
  if (env.side !== 'server' || !env.su)
    throw new AccessError('Activity reminders require the trusted scheduler.');
  z.iso.datetime().parse(instant);
  const tomorrow = new Date(new Date(instant).getTime() + 86_400_000).toISOString().slice(0, 10);
  const candidates = await env.model('mail.activity').search(
    [
      ['state', '=', 'planned'],
      ['remindedAt', '=', null],
      ['dueDate', '<=', tomorrow],
    ],
    { limit: 500, order: 'dueDate, id' },
  );
  let count = 0;
  const retireOrphan = async (id: string): Promise<void> => {
    const found = await env.model('mail.activity').search([['id', '=', id]], { limit: 1 });
    if (!found.length) return;
    await found.lockForUpdate();
    const [row] = await found.read(['state']);
    if (row?.state === 'planned') await found.write({ state: 'cancelled' });
  };
  for (const candidate of await candidates.read(['id', 'resModel', 'resId'])) {
    const model = String(candidate.resModel);
    if (!env.registry.has(model) || !env.registry.get(model).mixins.includes('mail.thread')) {
      await retireOrphan(String(candidate.id));
      continue;
    }
    // Same lock order as completion/anonymization: parent, then activity. Never revive a
    // completed activity using the snapshot collected before a competing transaction.
    try {
      await env
        .model(model)
        .browse([String(candidate.resId)])
        .lockForUpdate();
      const activity = env.model('mail.activity').browse([String(candidate.id)]);
      await activity.lockForUpdate();
      const [row] = await activity.read([
        'state',
        'remindedAt',
        'dueDate',
        'reminderTimeZone',
        'assignedUserId',
      ]);
      if (
        !row ||
        row.state !== 'planned' ||
        row.remindedAt !== null ||
        String(row.dueDate) >
          reminderDay(
            instant,
            typeof row.reminderTimeZone === 'string' ? row.reminderTimeZone : null,
          )
      )
        continue;
      await env.model('mail.activity.reminder').create({
        activityId: activity.id,
        userId: row.assignedUserId,
      });
      await activity.write({ remindedAt: instant });
      count += 1;
    } catch (error) {
      if (!(error instanceof MissingRecordError)) throw error;
      await retireOrphan(String(candidate.id));
    }
  }
  return count;
}
