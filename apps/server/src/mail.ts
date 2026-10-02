// SPDX-License-Identifier: LGPL-3.0-only
import { canAccessModel, effectiveGroups, type UserContext } from '@socle/framework';
import {
  activitySchema,
  finishActivity,
  finishSchema,
  followSchema,
  followThread,
  messageSchema,
  pageSchema,
  postMessage,
  readActivities,
  readThread,
  scheduleActivity,
  targetSchema,
  readNotifications,
  markNotificationRead,
} from '@socle/module-mail';
import type { RunInTransaction } from '@socle/sync';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { HttpError } from './http-error.js';
import type { TenantRuntime } from './tenants.js';

interface Deps {
  readonly tenantOf: (request: FastifyRequest) => TenantRuntime;
  readonly userOf: (request: FastifyRequest) => Promise<UserContext>;
  readonly runner: (
    tenant: TenantRuntime,
    user: UserContext,
    request: FastifyRequest,
  ) => RunInTransaction;
}

/** All mutations reuse the server's Origin/session/CSRF pipeline and transactional audit. */
export function registerMailRoutes(app: FastifyInstance, deps: Deps): void {
  const context = async (request: FastifyRequest) => {
    const tenant = deps.tenantOf(request);
    if (!tenant.registry.has('mail.message'))
      throw new HttpError(404, 'not_found', 'Mail is not installed.');
    const user = await deps.userOf(request);
    const groups = effectiveGroups(tenant.security, user.groupIds);
    return { tenant, user, visibility: { internal: groups.has('base.group_user') } };
  };

  app.post('/mail/:model/:id/read', async (request) => {
    const target = targetSchema.parse(request.params);
    const page = pageSchema.parse(request.body);
    const { tenant, user, visibility } = await context(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => ({
      ...(await readThread(env, target, visibility, page)),
      internal: visibility.internal,
      canPost: canAccessModel(
        tenant.security,
        effectiveGroups(tenant.security, user.groupIds),
        target.model,
        'write',
      ),
    }));
  });
  app.post('/mail/:model/:id/messages', async (request) => {
    const target = targetSchema.parse(request.params);
    const value = messageSchema.parse(request.body);
    const { tenant, user, visibility } = await context(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => ({
      message: await postMessage(env, target, value, visibility),
    }));
  });
  app.post('/mail/:model/:id/follow', async (request) => {
    const target = targetSchema.parse(request.params);
    const value = followSchema.parse(request.body);
    const { tenant, user } = await context(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => {
      await followThread(env, target, value);
      return { ok: true };
    });
  });
  app.post('/mail/:model/:id/activities', async (request) => {
    const target = targetSchema.parse(request.params);
    const value = activitySchema.parse(request.body);
    const { tenant, user } = await context(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => ({
      activity: await scheduleActivity(env, target, value),
    }));
  });
  app.post('/mail/:model/:id/activities/:activityId', async (request) => {
    const params = targetSchema.extend({ activityId: z.uuid() }).parse(request.params);
    const value = finishSchema.parse(request.body);
    const { tenant, user } = await context(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => {
      await finishActivity(env, { model: params.model, id: params.id }, params.activityId, value);
      return { ok: true };
    });
  });
  app.post('/mail/activities', async (request) => {
    z.strictObject({}).parse(request.body);
    const { tenant, user } = await context(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => ({
      activities: await readActivities(env),
    }));
  });
  app.post('/mail/notifications/read', async (request) => {
    z.strictObject({}).parse(request.body);
    const { tenant, user, visibility } = await context(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => ({ notifications: await readNotifications(env, visibility) }));
  });
  app.post('/mail/notifications/:notificationId/seen', async (request) => {
    const { notificationId } = z.strictObject({ notificationId: z.uuid() }).parse(request.params);
    z.strictObject({}).parse(request.body);
    const { tenant, user } = await context(request);
    return deps.runner(
      tenant,
      user,
      request,
    )(async ({ env }) => {
      await markNotificationRead(env, notificationId);
      return { ok: true };
    });
  });
}
