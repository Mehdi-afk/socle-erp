// SPDX-License-Identifier: LGPL-3.0-only
import {
  AccessError,
  MissingRecordError,
  ValidationError,
  type Environment,
  type Recordset,
  type WriteChange,
  type DomainCondition,
} from '@socle/framework';
import { z } from 'zod';

const uuid = z.uuid().transform((id) => id.toLowerCase());
export const targetSchema = z.strictObject({ model: z.string().min(1).max(63), id: uuid });
export const pageSchema = z.strictObject({ before: uuid.optional() });
export const messageSchema = z.strictObject({
  body: z.string().trim().min(1).max(10_000),
  kind: z.enum(['comment', 'note']),
});
export const activitySchema = z.strictObject({
  summary: z.string().trim().min(1).max(254),
  typeId: uuid,
  dueDate: z.iso.date(),
});
export const finishSchema = z.strictObject({
  state: z.enum(['done', 'cancelled']),
  feedback: z.string().trim().max(10_000).default(''),
});
export const followSchema = z.strictObject({ following: z.boolean() });

export interface MailTarget {
  readonly model: string;
  readonly id: string;
}
export interface MailVisibility {
  readonly internal: boolean;
}

/** Only real, readable thread records are eligible; every operation repeats this check. */
async function targetOf(env: Environment, input: MailTarget, write = false): Promise<Recordset> {
  const { model, id } = targetSchema.parse(input);
  if (env.side !== 'server' || env.su) throw new AccessError('A real server user is required.');
  if (!env.registry.has(model) || !env.registry.get(model).mixins.includes('mail.thread'))
    throw new MissingRecordError(model, [id]);
  const found = await env.model(model).search([['id', '=', id]], { limit: 1 });
  if (found.length !== 1) throw new MissingRecordError(model, [id]);
  // ORM ACL + record write rules, not a harmless write or a caller-supplied permission.
  if (write) await found.lockForUpdate();
  return found;
}

async function companyOf(records: Recordset): Promise<string | null> {
  if (!records.env.registry.field(records.model, 'companyId')) return null;
  const [row] = await records.read(['companyId']);
  return typeof row?.companyId === 'string' ? row.companyId : null;
}

function visibleTrackedField(env: Environment, model: string, name: string): boolean {
  const field = env.registry.field(model, name);
  return (
    field?.tracking === true &&
    !field.sensitive &&
    !field.groups?.length &&
    ['char', 'text', 'integer', 'boolean', 'date', 'datetime', 'selection', 'decimal'].includes(
      field.type,
    )
  );
}

function filterTracking(env: Environment, model: string, rows: Record<string, unknown>[]): void {
  for (const row of rows) {
    if (row.kind === 'tracking' && row.changes && typeof row.changes === 'object') {
      row.changes = Object.fromEntries(
        Object.entries(row.changes).filter(([name]) => visibleTrackedField(env, model, name)),
      );
    }
  }
}

async function notifyFollowers(
  env: Environment,
  target: MailTarget,
  messageId: string,
): Promise<void> {
  const technical = env.sudo('Notify record subscribers inside the message transaction');
  const followers = await technical
    .model('mail.follower')
    .search([...domainOf(target), ['userId', '!=', env.user.id]]);
  for (const row of await followers.read(['userId'])) {
    await technical.model('mail.notification').create({ messageId, userId: row.userId });
  }
}

const messageFields = ['id', 'kind', 'body', 'changes', 'createdAt', 'authorId'] as const;
const activityFields = [
  'id',
  'summary',
  'typeId',
  'dueDate',
  'state',
  'feedback',
  'assignedUserId',
] as const;
const domainOf = ({ model, id }: MailTarget): readonly DomainCondition[] => [
  ['resModel', '=', model],
  ['resId', '=', id],
];

/** A bounded conversation page and the caller's activities; notes are internal-user-only. */
export async function readThread(
  env: Environment,
  input: MailTarget,
  visibility: MailVisibility,
  page: unknown = {},
) {
  const target = targetSchema.parse(input);
  const { before } = pageSchema.parse(page);
  await targetOf(env, target);
  const technical = env.sudo('Read conversation after checking parent access');
  const messages = await technical
    .model('mail.message')
    .search(
      [
        ...domainOf(target),
        ...(visibility.internal && env.hasGroup('base.group_user')
          ? []
          : [['kind', '!=', 'note'] as const]),
        ...(before === undefined ? [] : [['id', '<', before] as const]),
      ],
      { limit: 51, order: 'id desc' },
    );
  const rows = await messages.read(messageFields);
  filterTracking(env, target.model, rows);
  const activities = await technical
    .model('mail.activity')
    .search(
      [...domainOf(target), ['assignedUserId', '=', env.user.id], ['state', '=', 'planned']],
      { limit: 100, order: 'dueDate, id' },
    );
  const types = await technical
    .model('mail.activity.type')
    .search([], { limit: 100, order: 'code' });
  const followers = await technical
    .model('mail.follower')
    .search([...domainOf(target), ['userId', '=', env.user.id]], { limit: 1 });
  return {
    messages: rows.slice(0, 50).reverse(),
    before: rows.length > 50 ? String(rows[49]?.id) : null,
    activities: await activities.read(activityFields),
    types: await types.read(['id', 'code', 'name', 'color']),
    following: followers.length > 0,
  };
}

/** Stores text, never HTML. The author, company and parent cannot be supplied by the caller. */
export async function postMessage(
  env: Environment,
  input: MailTarget,
  value: unknown,
  visibility: MailVisibility,
) {
  const target = targetSchema.parse(input);
  const message = messageSchema.parse(value);
  if (message.kind === 'note' && (!visibility.internal || !env.hasGroup('base.group_user')))
    throw new AccessError('Internal notes require an internal user.');
  const parent = await targetOf(env, target, true);
  const technical = env.sudo('Append conversation after checking parent write access');
  const created = await technical.model('mail.message').create({
    resModel: target.model,
    resId: target.id,
    companyId: await companyOf(parent),
    authorId: env.user.id,
    ...message,
  });
  const [row] = await created.read(messageFields);
  await notifyFollowers(env, target, created.id);
  return row;
}

/** Registers or removes the caller only; no follower identity is accepted from the network. */
export async function followThread(
  env: Environment,
  input: MailTarget,
  value: unknown,
): Promise<void> {
  const target = targetSchema.parse(input);
  const { following } = followSchema.parse(value);
  const parent = await targetOf(env, target, true);
  const technical = env.sudo('Change own subscription after checking parent write access');
  const followers = await technical
    .model('mail.follower')
    .search([...domainOf(target), ['userId', '=', env.user.id]]);
  if (!following) await followers.unlink();
  else if (followers.length === 0)
    await technical.model('mail.follower').create({
      resModel: target.model,
      resId: target.id,
      userId: env.user.id,
      companyId: await companyOf(parent),
    });
}

/** Schedules a personal activity on a writable record. */
export async function scheduleActivity(env: Environment, input: MailTarget, value: unknown) {
  const target = targetSchema.parse(input);
  const activity = activitySchema.parse(value);
  const parent = await targetOf(env, target, true);
  const technical = env.sudo('Schedule own activity after checking parent write access');
  const types = await technical
    .model('mail.activity.type')
    .search([['id', '=', activity.typeId]], { limit: 1 });
  if (types.length !== 1) throw new ValidationError('Unknown activity type.');
  const created = await technical.model('mail.activity').create({
    ...activity,
    reminderTimeZone: env.user.tz,
    resModel: target.model,
    resId: target.id,
    assignedUserId: env.user.id,
    companyId: await companyOf(parent),
  });
  const [row] = await created.read(activityFields);
  return row;
}

/** Completion and its immutable conversation entry share the caller's transaction. */
export async function finishActivity(
  env: Environment,
  input: MailTarget,
  activityId: string,
  value: unknown,
): Promise<void> {
  const target = targetSchema.parse(input);
  const id = uuid.parse(activityId);
  const finish = finishSchema.parse(value);
  const parent = await targetOf(env, target, true);
  const technical = env.sudo('Finish own activity after checking parent write access');
  const activities = await technical
    .model('mail.activity')
    .search(
      [
        ...domainOf(target),
        ['id', '=', id],
        ['assignedUserId', '=', env.user.id],
        ['state', '=', 'planned'],
      ],
      { limit: 1 },
    );
  const [row] = await activities.read(['summary']);
  if (!row) throw new MissingRecordError('mail.activity', [id]);
  await activities.write(finish);
  if (finish.state === 'done') {
    const message = await technical.model('mail.message').create({
      resModel: target.model,
      resId: target.id,
      authorId: env.user.id,
      companyId: await companyOf(parent),
      kind: 'comment',
      body: String(row.summary) + (finish.feedback ? `\n${finish.feedback}` : ''),
    });
    await notifyFollowers(env, target, message.id);
  }
}

/** Tracks only safe scalar fields; restricted, sensitive and relational values stay private. */
export async function recordTracking(
  env: Environment,
  model: string,
  changes: readonly WriteChange[],
): Promise<void> {
  for (const change of changes) {
    const tracked = Object.entries(change.values).filter(([name]) =>
      visibleTrackedField(env, model, name),
    );
    if (tracked.length === 0) continue;
    const technical = env.sudo('Append tracked field changes in the write transaction');
    const parent = technical.model(model).browse([change.id]);
    const created = await technical.model('mail.message').create({
      resModel: model,
      resId: change.id,
      authorId: env.user.id,
      companyId: await companyOf(parent),
      kind: 'tracking',
      body: 'Field changes',
      changes: Object.fromEntries(
        tracked.map(([name, value]) => [
          name,
          {
            before:
              typeof value.before === 'string'
                ? value.before.slice(0, 10_000)
                : (value.before ?? null),
            after:
              typeof value.after === 'string'
                ? value.after.slice(0, 10_000)
                : (value.after ?? null),
          },
        ]),
      ),
    });
    await notifyFollowers(env, { model, id: change.id }, created.id);
  }
}

/** Mail data in a contact export retains the same parent and internal-note authorization. */
export async function exportThread(
  env: Environment,
  id: string,
): Promise<Record<string, Record<string, unknown>[]>> {
  const target = targetSchema.parse({ model: 'res.partner', id });
  await targetOf(env, target);
  const technical = env.sudo('Export authorized conversation data for a contact');
  const messages = await technical
    .model('mail.message')
    .search([
      ...domainOf(target),
      ...(env.hasGroup('base.group_user') ? [] : [['kind', '!=', 'note'] as const]),
    ]);
  const activities = await technical
    .model('mail.activity')
    .search([...domainOf(target), ['assignedUserId', '=', env.user.id]]);
  const rows = await messages.read(messageFields);
  filterTracking(env, target.model, rows);
  const reminders = await technical.model('mail.activity.reminder').search([
    ['activityId', 'in', activities.ids],
    ['userId', '=', env.user.id],
  ]);
  return {
    'mail.messages': rows,
    'mail.activities': await activities.read(activityFields),
    'mail.reminders': await reminders.read(['id', 'activityId', 'isRead', 'createdAt']),
  };
}

/** Called after the base retention checks; ordinary message changes stay forbidden. */
export async function anonymizeThread(env: Environment, id: string): Promise<void> {
  const target = targetSchema.parse({ model: 'res.partner', id });
  await targetOf(env, target, true);
  const technical = env.sudo('GDPR: erase conversation contents after contact retention checks');
  const messages = await technical.model('mail.message').search(domainOf(target));
  for (const message of messages) {
    const privacy = message as Recordset & { eraseForPrivacy(): Promise<void> };
    await privacy.eraseForPrivacy();
  }
  const activities = await technical.model('mail.activity').search(domainOf(target));
  await activities.write({ summary: 'Anonymisé', feedback: null, state: 'cancelled' });
  const followers = await technical.model('mail.follower').search(domainOf(target));
  await followers.unlink();
  const notifications = await technical
    .model('mail.notification')
    .search([['messageId', 'in', messages.ids]]);
  await notifications.unlink();
  const reminders = await technical
    .model('mail.activity.reminder')
    .search([['activityId', 'in', activities.ids]]);
  await reminders.unlink();
}

async function reminderTarget(env: Environment, activityId: string): Promise<MailTarget | null> {
  const [row] = await env
    .sudo('Resolve own activity reminder without exposing its contents')
    .model('mail.activity')
    .browse([activityId])
    .read(['resModel', 'resId', 'state', 'assignedUserId']);
  if (!row || row.state !== 'planned' || row.assignedUserId !== env.user.id) return null;
  const target = { model: String(row.resModel), id: String(row.resId) };
  await targetOf(env, target);
  return target;
}

/** Every notification rechecks current parent rights, so revoked access cannot leak a preview. */
export async function readNotifications(env: Environment, visibility: MailVisibility) {
  if (env.su || env.side !== 'server') throw new AccessError('A real server user is required.');
  const technical = env.sudo('Read own notifications with live parent authorization');
  const found = await technical.model('mail.notification').search(
    [
      ['userId', '=', env.user.id],
      ['isRead', '=', false],
    ],
    { limit: 100, order: 'id desc' },
  );
  const result: Record<string, unknown>[] = [];
  for (const notification of await found.read(['id', 'messageId'])) {
    const [message] = await technical
      .model('mail.message')
      .browse([String(notification.messageId)])
      .read(['resModel', 'resId', ...messageFields]);
    if (
      !message ||
      (message.kind === 'note' && (!visibility.internal || !env.hasGroup('base.group_user')))
    )
      continue;
    const target = { model: String(message.resModel), id: String(message.resId) };
    try {
      await targetOf(env, target);
      result.push({
        id: notification.id,
        model: target.model,
        recordId: target.id,
        kind: message.kind,
      });
    } catch (error) {
      if (!(error instanceof AccessError) && !(error instanceof MissingRecordError)) throw error;
    }
  }
  const reminders = await technical.model('mail.activity.reminder').search(
    [
      ['userId', '=', env.user.id],
      ['isRead', '=', false],
    ],
    { limit: 100, order: 'id desc' },
  );
  for (const reminder of await reminders.read(['id', 'activityId'])) {
    try {
      const target = await reminderTarget(env, String(reminder.activityId));
      if (target)
        result.push({
          id: reminder.id,
          model: target.model,
          recordId: target.id,
          kind: 'reminder',
        });
    } catch (error) {
      if (!(error instanceof AccessError) && !(error instanceof MissingRecordError)) throw error;
    }
  }
  return result.sort((a, b) => String(b.id).localeCompare(String(a.id))).slice(0, 100);
}

export async function markNotificationRead(env: Environment, id: string): Promise<void> {
  const notificationId = uuid.parse(id);
  if (env.su || env.side !== 'server') throw new AccessError('A real server user is required.');
  const technical = env.sudo('Mark own notification after checking its parent');
  const found = await technical.model('mail.notification').search(
    [
      ['id', '=', notificationId],
      ['userId', '=', env.user.id],
    ],
    { limit: 1 },
  );
  const [row] = await found.read(['messageId']);
  if (!row) {
    const reminders = await technical.model('mail.activity.reminder').search(
      [
        ['id', '=', notificationId],
        ['userId', '=', env.user.id],
      ],
      { limit: 1 },
    );
    const [reminder] = await reminders.read(['activityId']);
    if (!reminder || !(await reminderTarget(env, String(reminder.activityId))))
      throw new MissingRecordError('mail.notification', [notificationId]);
    await reminders.write({ isRead: true });
    return;
  }
  const [message] = await technical
    .model('mail.message')
    .browse([String(row.messageId)])
    .read(['resModel', 'resId', 'kind']);
  if (!message || (message.kind === 'note' && !env.hasGroup('base.group_user')))
    throw new MissingRecordError('mail.notification', [notificationId]);
  await targetOf(env, { model: String(message.resModel), id: String(message.resId) });
  await found.write({ isRead: true });
}

/** Pure status calculation uses a calendar day supplied in the user's time zone. */
export function activityStatus(dueDate: string, today: string): 'overdue' | 'today' | 'planned' {
  z.iso.date().parse(dueDate);
  z.iso.date().parse(today);
  return dueDate < today ? 'overdue' : dueDate === today ? 'today' : 'planned';
}

/** Personal calendar rows are filtered against live parent rights before leaving the server. */
export async function readActivities(env: Environment) {
  if (env.su || env.side !== 'server') throw new AccessError('A real server user is required.');
  const found = await env
    .sudo('List own activities with live parent authorization')
    .model('mail.activity')
    .search(
      [
        ['assignedUserId', '=', env.user.id],
        ['state', '=', 'planned'],
      ],
      { limit: 500, order: 'dueDate, id' },
    );
  const result: Record<string, unknown>[] = [];
  const types = await env
    .sudo('Read activity category names')
    .model('mail.activity.type')
    .search([], { limit: 100 });
  const typeRows = await types.read(['id', 'name', 'code', 'color']);
  for (const row of await found.read([...activityFields, 'resModel', 'resId'])) {
    try {
      await targetOf(env, { model: String(row.resModel), id: String(row.resId) });
      const type = typeRows.find((item) => item.id === row.typeId);
      if (type)
        result.push({ ...row, typeName: type.name, typeCode: type.code, color: type.color });
    } catch (error) {
      if (!(error instanceof AccessError) && !(error instanceof MissingRecordError)) throw error;
    }
  }
  return result;
}
