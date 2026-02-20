import type { Context } from 'koa';

import { strings, errors } from '@strapi/utils';
import { trim, has } from 'lodash/fp';
import { getService } from '../utils';
import constants from '../services/constants';
import {
  validateApiTokenCreationInput,
  validateApiTokenUpdateInput,
} from '../validation/api-tokens';
import { validatedUpdatePermissionsInput } from '../validation/permission';

import {
  Create,
  List,
  Revoke,
  Get,
  Update,
  GetAdminPermissions,
  UpdateAdminPermissions,
  AdminApiToken,
} from '../../../shared/contracts/api-token';
import type { AdminUser } from '../../../shared/contracts/shared';

const { ApplicationError } = errors;

// ---------------------------------------------------------------------------
// Access-control helpers — kind-aware
// ---------------------------------------------------------------------------

const isSuperAdmin = (user: AdminUser): boolean =>
  user.roles.some((r) => r.code === constants.SUPER_ADMIN_CODE) === true;

const getOwnerId = (token: AdminApiToken): string => {
  const owner = token.adminUserOwner;
  return String(typeof owner === 'object' ? owner.id : owner);
};

/** Returns true when user is the recorded owner of an admin token. */
const isTokenOwner = (user: AdminUser, token: AdminApiToken): boolean =>
  getOwnerId(token) === String(user.id);

/** Owner OR super-admin can manage an admin token (read metadata, update…). */
const canAccessAdminToken = (user: AdminUser, token: AdminApiToken): boolean =>
  isTokenOwner(user, token) || isSuperAdmin(user);

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export default {
  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------
  async create(ctx: Context) {
    const { body } = ctx.request as Create.Request;
    const apiTokenService = getService('api-token');

    const name = trim(body.name);
    const description = trim(body.description);

    // Build a kind-specific attributes object — only the relevant fields are forwarded.
    const attributes =
      body.kind === 'content-api'
        ? ({
            kind: 'content-api' as const,
            name,
            description,
            type: body.type,
            permissions: body.permissions,
            lifespan: body.lifespan,
          } satisfies Create.Request['body'])
        : ({
            kind: 'admin' as const,
            name,
            description,
            adminPermissions: body.adminPermissions,
            adminUserOwner: body.adminUserOwner,
            lifespan: body.lifespan,
          } satisfies Create.Request['body']);

    await validateApiTokenCreationInput(attributes);

    const alreadyExists = await apiTokenService.exists({ name });
    if (alreadyExists) {
      throw new ApplicationError('Name already taken');
    }

    const apiToken = await apiTokenService.create(attributes, ctx.state.user);
    ctx.created({ data: apiToken } satisfies Create.Response);
  },

  // -------------------------------------------------------------------------
  // Regenerate
  // -------------------------------------------------------------------------
  async regenerate(ctx: Context) {
    const { id } = ctx.params;
    const apiTokenService = getService('api-token');

    const token = await apiTokenService.getById(id);
    if (!token) {
      ctx.notFound('API Token not found');
      return;
    }

    if (token.kind === 'admin' && !isTokenOwner(ctx.state.user, token)) {
      // Admin tokens: only the owner can regenerate — super-admin does NOT bypass.
      return ctx.forbidden();
    }
    // Legacy tokens: anyone with route permission can regenerate (back-compat).

    const accessToken = await apiTokenService.regenerate(id);
    ctx.created({ data: accessToken });
  },

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------
  async list(ctx: Context) {
    const apiTokenService = getService('api-token');
    const apiTokens = await apiTokenService.list(ctx.state.user);

    ctx.send({ data: apiTokens } satisfies List.Response);
  },

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------
  async revoke(ctx: Context) {
    const { id } = ctx.params as Revoke.Params;
    const apiTokenService = getService('api-token');
    const apiToken = await apiTokenService.revoke(id);

    ctx.deleted({ data: apiToken } satisfies Revoke.Response);
  },

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------
  async get(ctx: Context) {
    const { id } = ctx.params;
    const apiTokenService = getService('api-token');

    // Fetch without decrypted key first (used for ownership determination).
    const token = await apiTokenService.getById(id);
    if (!token) {
      ctx.notFound('API Token not found');
      return;
    }

    if (token.kind === 'content-api') {
      // Legacy tokens: always expose the decrypted key (back-compat).
      const withKey = await apiTokenService.getById(id, { includeDecryptedKey: true });
      ctx.send({ data: withKey ?? token } satisfies Get.Response);
      return;
    }

    // Admin tokens: only the owner can read the plaintext key.
    // Super-admin can view metadata but never sees another user's key.
    if (isTokenOwner(ctx.state.user, token)) {
      const withKey = await apiTokenService.getById(id, { includeDecryptedKey: true });
      ctx.send({ data: withKey ?? token } satisfies Get.Response);
      return;
    }

    ctx.send({ data: token } satisfies Get.Response);
  },

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------
  async update(ctx: Context) {
    const { body } = ctx.request as Update.Request;
    const { id } = ctx.params as Update.Params;
    const apiTokenService = getService('api-token');

    // Trim name / description in-place (both fields exist on all body shapes).
    const mutableBody = body as Record<string, unknown>;
    if (has('name', mutableBody)) {
      mutableBody.name = trim(body.name);
    }
    if (has('description', mutableBody) || mutableBody.description === null) {
      mutableBody.description = trim(body.description);
    }

    await validateApiTokenUpdateInput(body);

    const existingToken = await apiTokenService.getById(id);
    if (!existingToken) {
      return ctx.notFound('API Token not found');
    }

    if (has('name', body)) {
      const nameAlreadyTaken = await apiTokenService.getByName(body.name);
      /**
       * Cast ids as string: the ctx param is not coerced to Number so we
       * compare as strings to avoid integer/string mismatch.
       */
      if (nameAlreadyTaken !== null && !strings.isEqual(nameAlreadyTaken.id, id)) {
        throw new ApplicationError('Name already taken');
      }
    }

    if (existingToken.kind === 'content-api') {
      // Legacy tokens: any caller with the update route permission can update.
      const apiToken = await apiTokenService.update(id, body, ctx.state.user);
      ctx.send({ data: apiToken } satisfies Update.Response);
      return;
    }

    // Admin tokens: only the owner or a super-admin can update.
    if (!canAccessAdminToken(ctx.state.user, existingToken)) {
      return ctx.forbidden();
    }

    const apiToken = await apiTokenService.update(id, body, ctx.state.user);
    ctx.send({ data: apiToken } satisfies Update.Response);
  },

  // -------------------------------------------------------------------------
  // Get layout (legacy — may be removed)
  // -------------------------------------------------------------------------
  async getLayout(ctx: Context) {
    const apiTokenService = getService('api-token');
    // TODO
    // @ts-expect-error remove this controller if not used
    const layout = await apiTokenService.getApiTokenLayout();

    ctx.send({ data: layout });
  },

  // -------------------------------------------------------------------------
  // Admin permissions — admin tokens only
  // -------------------------------------------------------------------------
  async getAdminPermissions(ctx: Context) {
    const { id } = ctx.params as GetAdminPermissions.Request['params'];
    const apiTokenService = getService('api-token');
    const permissionService = getService('permission');

    const token = await apiTokenService.getById(id);
    if (!token) {
      return ctx.notFound('apiToken.notFound');
    }

    if (token.kind === 'content-api') {
      return ctx.badRequest('Legacy tokens do not have admin permissions');
    }

    // Admin token: owner or super-admin can read permissions.
    if (!canAccessAdminToken(ctx.state.user, token)) {
      return ctx.forbidden();
    }

    const permissions = await permissionService.findMany({
      where: { apiToken: { id: token.id } },
    });

    const sanitizedPermissions = permissions.map(permissionService.sanitizePermission);

    // @ts-expect-error - transform response type to sanitized permission
    ctx.body = { data: sanitizedPermissions } satisfies GetAdminPermissions.Response;
  },

  async updateAdminPermissions(ctx: Context) {
    const { id } = ctx.params as UpdateAdminPermissions.Request['params'];
    const { body: input } = ctx.request as Omit<UpdateAdminPermissions.Request, 'params'>;
    const apiTokenService = getService('api-token');
    const permissionService = getService('permission');

    const token = await apiTokenService.getById(id);
    if (!token) {
      return ctx.notFound('apiToken.notFound');
    }

    if (token.kind === 'content-api') {
      return ctx.badRequest('Legacy tokens do not have admin permissions');
    }

    // Admin token: only owner or super-admin can mutate permissions.
    if (!canAccessAdminToken(ctx.state.user, token)) {
      return ctx.forbidden();
    }

    await validatedUpdatePermissionsInput(input);

    // Add default actionParameters (contract omits this but service requires it).
    const permissionsWithDefaults = input.permissions.map((perm: any) => ({
      ...perm,
      actionParameters: {},
    }));

    const permissions = await apiTokenService.assignAdminPermissionsToToken(
      token.id,
      permissionsWithDefaults as any,
      ctx.state.user
    );

    const sanitizedPermissions = permissions.map(permissionService.sanitizePermission);

    // @ts-expect-error - transform response type to sanitized permission
    ctx.body = { data: sanitizedPermissions } satisfies UpdateAdminPermissions.Response;
  },
};
