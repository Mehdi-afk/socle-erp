// SPDX-License-Identifier: LGPL-3.0-only
import { z } from 'zod';

const id = z.uuid().transform((value) => value.toLowerCase());
const scalar = z.union([z.string().max(100_000), z.number(), z.boolean(), z.null()]);
export const threadMessageSchema = z.strictObject({
  id,
  kind: z.enum(['comment', 'note', 'tracking']),
  body: z.string().max(20_000),
  authorId: z.string().min(1).max(254),
  createdAt: z.iso.datetime(),
  changes: z
    .record(
      z.string().regex(/^[a-z][A-Za-z0-9]*$/),
      z.strictObject({ before: scalar, after: scalar }),
    )
    .nullable(),
});
export const threadActivitySchema = z.strictObject({
  id,
  summary: z.string().min(1).max(254),
  typeId: id,
  dueDate: z.iso.date(),
  state: z.enum(['planned', 'done', 'cancelled']),
  feedback: z.string().max(10_000).nullable(),
  assignedUserId: z.string().min(1).max(254),
});
export const threadPageSchema = z.strictObject({
  messages: z.array(threadMessageSchema).max(50),
  before: id.nullable(),
  activities: z.array(threadActivitySchema).max(100),
  types: z
    .array(
      z.strictObject({
        id,
        code: z.string().max(64),
        name: z.string().max(254),
        color: z.number().int().min(1).max(8),
      }),
    )
    .max(100),
  following: z.boolean(),
  internal: z.boolean(),
  canPost: z.boolean(),
});
export const notificationSchema = z.strictObject({
  id,
  model: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9_.]*$/),
  recordId: id,
  kind: z.enum(['comment', 'note', 'tracking', 'reminder']),
});
export const calendarEventSchema = threadActivitySchema.extend({
  resModel: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9_.]*$/),
  resId: id,
  typeName: z.string().max(254),
  typeCode: z.string().max(64),
  color: z.number().int().min(1).max(8),
});
