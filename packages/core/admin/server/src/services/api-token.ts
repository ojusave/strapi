import crypto from 'crypto';
import {
  omit,
  difference,
  isNil,
  isEmpty,
  map,
  isArray,
  uniq,
  isNumber,
  differenceWith,
  isEqual,
  pick,
  prop,
} from 'lodash/fp';
import type { Core, Data } from '@strapi/types';
import { errors } from '@strapi/utils';
import type {
  Update,
  ApiToken,
  ApiTokenBody,
  ContentApiApiToken,
} from '../../../shared/contracts/api-token';
import type { AdminUser, Permission } from '../../../shared/contracts/shared';
import constants from './constants';
import { getService } from '../utils';
import permissionDomain from '../domain/permission';
import { validatePermissionsExist } from '../validation/permission';

const { SUPER_ADMIN_CODE } = constants;

const { ValidationError, NotFoundError } = errors;

const assertOwnerMatchesCallingUser = async (
  adminUserOwner: Data.ID,
  callingUser: AdminUser | undefined
): Promise<void> => {
  if (callingUser === undefined || callingUser === null) {
    throw new ValidationError('adminUserOwner requires an authenticated admin user');
  }

  const ownerId = String(adminUserOwner);
  const callingUserId = String(callingUser.id);

  if (ownerId !== callingUserId) {
    throw new ValidationError('adminUserOwner must match the authenticated admin user');
  }

  const existingUser = await strapi.db.query('admin::user').findOne({
    select: ['id'],
    where: { id: callingUser.id },
  });

  if (existingUser === null || existingUser === undefined) {
    throw new ValidationError('adminUserOwner must reference an existing admin user');
  }
};

const isSuperAdmin = (user: AdminUser | undefined): boolean =>
  user?.roles?.some((r) => r.code === SUPER_ADMIN_CODE) === true;

type DBApiToken = ApiToken & {
  permissions: (number | {
    id: number | `${number}`;
    action: string;
  })[];
};

const SELECT_FIELDS = [
  'id',
  'kind',
  'name',
  'description',
  'lastUsedAt',
  'type',
  'lifespan',
  'expiresAt',
  'createdAt',
  'updatedAt',
];

const POPULATE_FIELDS = ['permissions', 'adminPermissions', 'adminUserOwner'];

// TODO: we need to ensure the permissions are actually valid registered permissions!

/**
 * Assert that a token's permissions attribute is valid for its type
 */
const assertCustomTokenPermissionsValidity = (
  type: ContentApiApiToken['type'],
  permissions: string[] | null | undefined
) => {
  // Ensure non-custom tokens doesn't have permissions
  if (type !== constants.API_TOKEN_TYPE.CUSTOM && !isEmpty(permissions)) {
    throw new ValidationError('Non-custom tokens should not reference permissions');
  }

  // Custom type tokens should always have permissions attached to them
  if (type === constants.API_TOKEN_TYPE.CUSTOM && !isArray(permissions)) {
    throw new ValidationError('Missing permissions attribute for custom token');
  }

  // Permissions provided for a custom type token should be valid/registered permissions UID
  if (type === constants.API_TOKEN_TYPE.CUSTOM) {
    const validPermissions = strapi.contentAPI.permissions.providers.action.keys();
    const invalidPermissions = difference(permissions, validPermissions) as string[];

    if (!isEmpty(invalidPermissions)) {
      throw new ValidationError(`Unknown permissions provided: ${invalidPermissions.join(', ')}`);
    }
  }
};

/**
 * Check if a token's lifespan is valid
 */
const isValidLifespan = (lifespan: unknown) => {
  if (isNil(lifespan)) {
    return true;
  }

  if (!isNumber(lifespan) || !Object.values(constants.API_TOKEN_LIFESPANS).includes(lifespan)) {
    return false;
  }

  return true;
};

/**
 * Assert that a token's lifespan is valid
 */
const assertValidLifespan = (lifespan: unknown) => {
  if (!isValidLifespan(lifespan)) {
    throw new ValidationError(
      `lifespan must be one of the following values:
      ${Object.values(constants.API_TOKEN_LIFESPANS).join(', ')}`
    );
  }
};

/** API/body shape: permission without ids/timestamps and without actionParameters (defaulted by domain when creating). */
type PermissionInput = Omit<Permission, 'id' | 'createdAt' | 'updatedAt' | 'actionParameters'>;

/**
 * Assert that a legacy-kind token body does not carry admin-only fields
 */
const assertLegacyKindFields = (attributes: ApiTokenBody): void => {
  const raw = attributes as Record<string, unknown>;
  if (raw.adminPermissions !== undefined && raw.adminPermissions !== null) {
    throw new ValidationError('Legacy tokens cannot carry admin permissions');
  }
  if (raw.adminUserOwner !== undefined && raw.adminUserOwner !== null) {
    throw new ValidationError('Legacy tokens cannot have an admin user owner');
  }
};

/**
 * Assert that an admin-kind token body does not carry legacy-only fields
 */
const assertAdminKindFields = (attributes: ApiTokenBody): void => {
  const raw = attributes as Record<string, unknown>;
  if (raw.type !== undefined && raw.type !== null) {
    throw new ValidationError('Admin tokens cannot carry a legacy type (custom/read-only/full-access)');
  }
  if (raw.permissions !== undefined && raw.permissions !== null) {
    throw new ValidationError('Admin tokens cannot carry legacy content-API permissions');
  }
};

/**
 * Assert that admin permissions are valid
 */
const assertAdminPermissionsValidity = async (adminPermissions?: PermissionInput[]) => {
  if (!adminPermissions || adminPermissions.length === 0) {
    return;
  }

  // Validate that all actions exist in the admin action provider
  const validActions = getService('permission').actionProvider.keys();

  for (const perm of adminPermissions) {
    if (!validActions.includes(perm.action)) {
      throw new ValidationError(`Unknown admin action: ${perm.action}`);
    }
  }

  // Use existing permission validation
  await validatePermissionsExist(adminPermissions as any);
};

/**
 * Enforce that every requested admin permission stays within the calling
 * user's own permission ceiling, then return the clamped permissions.
 *
 * Super-admins bypass this (they hold every permission).
 * When admin permissions are requested, an authenticated user is required (no bypass when user is missing).
 *
 * For each requested permission:
 *  - action + subject must match at least one user permission
 *  - properties.fields must be ⊆ user's properties.fields
 *    (if the user's permission defines no fields, all fields are allowed)
 *  - conditions are inherited from the user's matching permission(s);
 *    the caller cannot configure conditions on their own tokens
 *
 * Returns the permissions with conditions enforced from the user's role.
 * Throws ValidationError if any permission exceeds the user's ceiling.
 */
const enforceAdminPermissionsCeiling = async (
  user: AdminUser | undefined | null,
  requestedPermissions?: PermissionInput[]
): Promise<PermissionInput[]> => {
  if (!requestedPermissions || requestedPermissions.length === 0) {
    return requestedPermissions || [];
  }
  if (user === undefined || user === null) {
    throw new ValidationError(
      'Admin permission ceiling cannot be enforced without an authenticated user'
    );
  }
  if (isSuperAdmin(user)) return requestedPermissions;

  const userPermissions: Permission[] = await getService('permission').findUserPermissions(user);

  const exceeding: string[] = [];

  const clamped = requestedPermissions.map((requested) => {
    const requestedSubject = requested.subject || null;

    // Find all user permissions matching action + subject
    const matchingUserPerms = userPermissions.filter((userPerm: Permission) => {
      if (userPerm.action !== requested.action) return false;
      const userSubject = userPerm.subject || null;
      return requestedSubject === userSubject;
    });

    const label =
      requestedSubject !== null ? `${requested.action} on ${requestedSubject}` : requested.action;

    if (matchingUserPerms.length === 0) {
      exceeding.push(label);
      return requested;
    }

    // --- Field-level ceiling ---
    // If any matching user perm has no fields defined → all fields are allowed.
    // Otherwise, effective user fields = union of all matching perms' fields.
    const anyUserPermHasAllFields = matchingUserPerms.some(
      (p) => !p.properties?.fields || p.properties.fields.length === 0
    );

    const requestedFields = requested.properties?.fields;

    if (
      !anyUserPermHasAllFields &&
      requestedFields !== undefined &&
      requestedFields !== null &&
      requestedFields.length > 0
    ) {
      const effectiveUserFields = uniq(
        matchingUserPerms.flatMap((p) => p.properties?.fields || [])
      );

      const exceedingFields = requestedFields.filter((f) => !effectiveUserFields.includes(f));

      if (exceedingFields.length > 0) {
        exceeding.push(`${label} (fields: ${exceedingFields.join(', ')})`);
        return requested;
      }
    }

    // --- Condition-level ceiling ---
    // Conditions are always inherited from the user's matching permission(s).
    // If any matching user perm is unconditional → token gets no conditions.
    // Otherwise → union of conditions across matching perms.
    const anyUserPermIsUnconditional = matchingUserPerms.some(
      (p) => !p.conditions || p.conditions.length === 0
    );

    const enforcedConditions: string[] = anyUserPermIsUnconditional
      ? []
      : (uniq(matchingUserPerms.flatMap((p) => p.conditions || [])) as string[]);

    return {
      ...requested,
      conditions: enforcedConditions,
    };
  });

  if (exceeding.length > 0) {
    throw new ValidationError(
      `Cannot assign admin permissions that exceed your own. ` +
        `Exceeding: ${exceeding.join(', ')}`
    );
  }

  return clamped;
};

/**
 * Create admin permissions for an API token
 */
const createApiTokenAdminPermissions = async (tokenId: Data.ID, permissions: PermissionInput[]) => {
  const { conditionProvider } = getService('permission');
  const sanitizeConditions = permissionDomain.sanitizeConditions(conditionProvider as any);

  const permissionsWithToken = permissions.map((perm) => {
    const permAsPermission = { ...perm, actionParameters: {} } as Permission;
    const sanitized = sanitizeConditions(permAsPermission);
    return permissionDomain.create({
      ...sanitized,
      apiToken: tokenId as any,
      role: null,
    } as any);
  });

  const createdPermissions = await getService('permission').createMany(permissionsWithToken as any);

  return createdPermissions;
};

/**
 * Fields to compare when checking if two permissions are equal
 */
const COMPARABLE_FIELDS = ['conditions', 'properties', 'subject', 'action', 'actionParameters'];
const pickComparableFields = pick(COMPARABLE_FIELDS);

/**
 * Helper to clean JSON (remove undefined values)
 */
const jsonClean = <T extends object>(data: T): T => JSON.parse(JSON.stringify(data));

/**
 * Compare two permissions for equality
 */
const arePermissionsEqual = (p1: Permission, p2: Permission): boolean => {
  if (p1.action === p2.action) {
    return isEqual(jsonClean(pickComparableFields(p1)), jsonClean(pickComparableFields(p2)));
  }
  return false;
};

/**
 * Assign admin permissions to an API token (similar to role permission assignment).
 * When callingUser is provided, enforces the ceiling check.
 */
const assignAdminPermissionsToToken = async (
  tokenId: Data.ID,
  permissions: PermissionInput[],
  callingUser: AdminUser
): Promise<Permission[]> => {
  await validatePermissionsExist(permissions as any);
  const clampedPermissions = await enforceAdminPermissionsCeiling(callingUser, permissions);

  const permissionsWithToken = clampedPermissions.map((perm) =>
    permissionDomain.create({
      ...perm,
      apiToken: tokenId as any,
      role: null,
    } as any)
  );

  const existingPermissions = await getService('permission').findMany({
    where: { apiToken: { id: tokenId } },
  });

  const permissionsToAdd = differenceWith(
    arePermissionsEqual,
    permissionsWithToken,
    existingPermissions
  ) as any as Permission[];

  const permissionsToDelete = differenceWith(
    arePermissionsEqual,
    existingPermissions,
    permissionsWithToken
  ) as any as Permission[];

  if (permissionsToDelete.length > 0) {
    await getService('permission').deleteByIds(permissionsToDelete.map(prop('id')) as Data.ID[]);
  }

  if (permissionsToAdd.length > 0) {
    await createApiTokenAdminPermissions(tokenId, permissionsToAdd as any);
  }

  // Return all current permissions
  const allCurrentPermissions = await getService('permission').findMany({
    where: { apiToken: { id: tokenId } },
  });

  return allCurrentPermissions;
};

/**
 * Flatten a token's database permissions objects to an array of strings
 */
const flattenTokenPermissions = (permissions: ({ action: string })[] | undefined): string[] => {
  return isArray(permissions) ? map('action', permissions) : [];
};

type WhereParams = {
  id?: string | number;
  name?: string;
  lastUsedAt?: number;
  description?: string;
  accessKey?: string;
};

type GetByOptions = {
  includeDecryptedKey?: boolean;
};

/**
 *  Get a token.
 *  By default the plaintext accessKey is NOT included.
 *  Pass { includeDecryptedKey: true } to decrypt and return it (owner-only paths).
 */
const getBy = async (
  whereParams: WhereParams = {},
  options: GetByOptions = {}
): Promise<ApiToken | null> => {
  if (Object.keys(whereParams).length === 0) {
    return null;
  }

  const { includeDecryptedKey = false } = options;

  const selectFields = includeDecryptedKey ? [...SELECT_FIELDS, 'encryptedKey'] : SELECT_FIELDS;

  const token = await strapi.db.query('admin::api-token').findOne({
    select: selectFields,
    populate: POPULATE_FIELDS,
    where: whereParams,
  });

  if (!token) {
    return token;
  }

  if (!includeDecryptedKey) {
    return {
      ...token,
      ...flattenTokenPermissions(token.permissions),
    };
  }

  const { encryptedKey, ...rest } = token;

  if (!encryptedKey) {
    return {
      ...token,
      ...flattenTokenPermissions(rest.permissions),
    };
  }

  const accessKey = getService('encryption').decrypt(encryptedKey);

  return {
    ...token,
    ...flattenTokenPermissions(rest.permissions),
    accessKey,
  };
};

/**
 * Check if token exists
 */
const exists = async (whereParams: WhereParams = {}): Promise<boolean> => {
  const apiToken = await getBy(whereParams);

  return !!apiToken;
};

/**
 * Return a secure sha512 hash of an accessKey
 */
const hash = (accessKey: string) => {
  const apiTokenCfg = strapi.config.get<Core.Config.Admin['apiToken']>('admin.apiToken');
  const salt = apiTokenCfg.salt;

  return crypto.createHmac('sha512', salt).update(accessKey).digest('hex');
};

const getExpirationFields = (lifespan: ApiTokenBody['lifespan']) => {
  // it must be nil or a finite number >= 0
  const isValidNumber = isNumber(lifespan) && Number.isFinite(lifespan) && lifespan > 0;
  if (!isValidNumber && !isNil(lifespan)) {
    throw new ValidationError('lifespan must be a positive number or null');
  }

  return {
    lifespan: lifespan || null,
    expiresAt: lifespan ? Date.now() + lifespan : null,
  };
};

/**
 * Create a token and its permissions
 */
const create = async (attributes: ApiTokenBody, callingUser?: AdminUser): Promise<ApiToken> => {
  const encryptionService = getService('encryption');
  const accessKey = crypto.randomBytes(128).toString('hex');
  const encryptedKey = encryptionService.encrypt(accessKey);

  assertValidLifespan(attributes.lifespan);

  if (attributes.kind === 'content-api') {
    assertLegacyKindFields(attributes);
    assertCustomTokenPermissionsValidity(attributes.type, attributes.permissions);

    // Legacy tokens have no owner
    const apiToken = await strapi.db.query('admin::api-token').create({
      select: SELECT_FIELDS,
      populate: POPULATE_FIELDS,
      data: {
        ...(omit(['permissions', 'adminPermissions', 'adminUserOwner'], attributes) as object),
        accessKey: hash(accessKey),
        encryptedKey,
        adminUserOwner: null,
        ...getExpirationFields(attributes.lifespan),
      },
    });

    const result = { ...apiToken, accessKey } as ApiToken;

    // If this is a custom type token, create the related content-API permissions
    if (attributes.type === constants.API_TOKEN_TYPE.CUSTOM) {
      // TODO: createMany doesn't seem to create relation properly, implement a better way rather than a ton of queries
      await Promise.all(
        uniq(attributes.permissions).map((action) =>
          strapi.db.query('admin::api-token-permission').create({
            data: { action, token: apiToken },
          })
        )
      );

      const currentPermissions = await strapi.db
        .query('admin::api-token')
        .load(apiToken, 'permissions');

      if (currentPermissions) {
        Object.assign(result, { permissions: map('action', currentPermissions) });
      }
    }

    return result;
  }

  // kind === 'admin'
  assertAdminKindFields(attributes);
  await assertAdminPermissionsValidity(attributes.adminPermissions);
  const clampedAdminPermissions = await enforceAdminPermissionsCeiling(
    callingUser,
    attributes.adminPermissions
  );

  // Owner: when explicitly provided, it must match the caller.
  // When omitted, always defaults to the calling user (including super admins).
  let ownerId: Data.ID;
  if (attributes.adminUserOwner !== undefined && attributes.adminUserOwner !== null) {
    await assertOwnerMatchesCallingUser(attributes.adminUserOwner, callingUser);
    ownerId = attributes.adminUserOwner;
  } else {
    if (callingUser === undefined || callingUser === null) {
      throw new ValidationError('Creating an admin token requires an authenticated admin user');
    }
    ownerId = callingUser.id;
  }

  const apiToken = await strapi.db.query('admin::api-token').create({
    select: SELECT_FIELDS,
    populate: POPULATE_FIELDS,
    data: {
      ...(omit(['permissions', 'adminPermissions', 'adminUserOwner'], attributes) as object),
      accessKey: hash(accessKey),
      encryptedKey,
      adminUserOwner: ownerId,
      ...getExpirationFields(attributes.lifespan),
    },
  });

  const result = { ...apiToken, accessKey } as ApiToken;

  // Handle admin permissions (using ceiling-clamped permissions with inherited conditions)
  if (clampedAdminPermissions.length > 0) {
    await createApiTokenAdminPermissions(apiToken.id, clampedAdminPermissions);

    const currentAdminPermissions = await strapi.db
      .query('admin::api-token')
      .load(apiToken, 'adminPermissions');

    if (currentAdminPermissions) {
      Object.assign(result, { adminPermissions: currentAdminPermissions });
    }
  }

  return result;
};

const regenerate = async (id: string | number): Promise<ApiToken> => {
  const accessKey = crypto.randomBytes(128).toString('hex');
  const encryptionService = getService('encryption');
  const encryptedKey = encryptionService.encrypt(accessKey);

  const apiToken: ApiToken = await strapi.db.query('admin::api-token').update({
    select: ['id', 'accessKey'],
    where: { id },
    data: {
      accessKey: hash(accessKey),
      encryptedKey,
    },
  });

  if (!apiToken) {
    throw new NotFoundError('The provided token id does not exist');
  }

  return {
    ...apiToken,
    accessKey,
  };
};

const checkSaltIsDefined = () => {
  const apiTokenCfg = strapi.config.get<Core.Config.Admin['apiToken']>('admin.apiToken');
  if (!apiTokenCfg?.salt) {
    // TODO V5: stop reading API_TOKEN_SALT
    if (process.env.API_TOKEN_SALT) {
      process.emitWarning(`[deprecated] In future versions, Strapi will stop reading directly from the environment variable API_TOKEN_SALT. Please set apiToken.salt in config/admin.js instead.
For security reasons, keep storing the secret in an environment variable and use env() to read it in config/admin.js (ex: \`apiToken: { salt: env('API_TOKEN_SALT') }\`). See https://docs.strapi.io/developer-docs/latest/setup-deployment-guides/configurations/optional/environment.html#configuration-using-environment-variables.`);

      strapi.config.set('admin.apiToken.salt', process.env.API_TOKEN_SALT);
    } else {
      throw new Error(
        `Missing apiToken.salt. Please set apiToken.salt in config/admin.js (ex: you can generate one using Node with \`crypto.randomBytes(16).toString('base64')\`).
For security reasons, prefer storing the secret in an environment variable and read it in config/admin.js. See https://docs.strapi.io/developer-docs/latest/setup-deployment-guides/configurations/optional/environment.html#configuration-using-environment-variables.`
      );
    }
  }
};

/**
 * Return a list of tokens visible to the calling user.
 * Super-admins see all tokens; regular admins see only ownerless tokens and their own.
 */
const list = async (callingUser: AdminUser): Promise<Array<ApiToken>> => {
  const where = isSuperAdmin(callingUser)
    ? {}
    : {
        $or: [{ adminUserOwner: null }, { adminUserOwner: { id: callingUser.id } }],
      };

  const tokens = await strapi.db.query('admin::api-token').findMany({
    select: SELECT_FIELDS,
    populate: POPULATE_FIELDS,
    orderBy: { name: 'ASC' },
    where,
  });

  if (!tokens) {
    return tokens;
  }

  return tokens.map((token) => (token.kind === 'content-api' ? {
    ...token,
    permissions: flattenTokenPermissions(token.permissions),
  } : token));
};

/**
 * Revoke (delete) a token
 */
const revoke = async (id: string | number): Promise<ApiToken> => {
  return strapi.db
    .query('admin::api-token')
    .delete({ select: SELECT_FIELDS, populate: POPULATE_FIELDS, where: { id } });
};

/**
 * Retrieve a token by id
 */
const getById = async (id: string | number, options?: GetByOptions) => {
  return getBy({ id }, options);
};

/**
 * Retrieve a token by name
 */
const getByName = async (name: string, options?: GetByOptions) => {
  return getBy({ name }, options);
};

/**
 * Update a token and its permissions
 */
const update = async (
  id: string | number,
  attributes: Update.Request['body'],
  callingUser?: AdminUser
): Promise<ApiToken> => {
  const originalToken = await strapi.db
    .query('admin::api-token')
    .findOne({ select: SELECT_FIELDS, where: { id } });

  if (!originalToken) {
    throw new NotFoundError('Token not found');
  }

  const raw = attributes as Record<string, unknown>;

  // kind is immutable after creation
  if (raw.kind !== undefined && raw.kind !== null && raw.kind !== originalToken.kind) {
    throw new ValidationError('kind is immutable after creation');
  }

  const resolvedKind: 'content-api' | 'admin' = originalToken.kind;

  assertValidLifespan(attributes.lifespan);

  let clampedAdminPermissions: PermissionInput[] | undefined;

  if (resolvedKind === 'content-api') {
    assertLegacyKindFields(attributes);

    const incomingType = raw.type as ContentApiApiToken['type'] | undefined;
    const incomingPermissions = raw.permissions as string[] | null | undefined;
    const resolvedType = incomingType ?? (originalToken.type as ContentApiApiToken['type']);
    const changingTypeToCustom =
      incomingType === constants.API_TOKEN_TYPE.CUSTOM &&
      originalToken.type !== constants.API_TOKEN_TYPE.CUSTOM;

    // Only re-validate if permissions or type are being changed
    if (incomingPermissions !== undefined || changingTypeToCustom) {
      assertCustomTokenPermissionsValidity(
        resolvedType,
        incomingPermissions ?? (originalToken.permissions as string[])
      );
    }
  } else {
    // kind === 'admin'
    assertAdminKindFields(attributes);

    const incomingAdminPermissions = raw.adminPermissions as PermissionInput[] | undefined;
    if (incomingAdminPermissions !== undefined) {
      await assertAdminPermissionsValidity(incomingAdminPermissions);
      clampedAdminPermissions = await enforceAdminPermissionsCeiling(
        callingUser,
        incomingAdminPermissions
      );
    }

    const incomingAdminUserOwner = raw.adminUserOwner;
    if (incomingAdminUserOwner !== undefined) {
      // Owner is immutable; the provided value must match the existing one
      const existingOwner = originalToken.adminUserOwner;
      const existingOwnerId =
        existingOwner === null || existingOwner === undefined
          ? null
          : String(typeof existingOwner === 'object' ? existingOwner.id : existingOwner);
      const requestedOwnerId =
        incomingAdminUserOwner === null ? null : String(incomingAdminUserOwner);

      if (requestedOwnerId !== existingOwnerId) {
        throw new ValidationError('adminUserOwner cannot be changed on update');
      }
    }
  }

  const updatedToken = await strapi.db.query('admin::api-token').update({
    select: SELECT_FIELDS,
    where: { id },
    // kind is immutable — strip it along with relation fields so the DB write is clean
    data: omit(['kind', 'permissions', 'adminPermissions', 'adminUserOwner'], attributes) as object,
  });

  if (resolvedKind === 'content-api') {
    const incomingPermissions = raw.permissions as string[] | null | undefined;

    // custom tokens need to have their permissions updated as well
    if (updatedToken.type === constants.API_TOKEN_TYPE.CUSTOM && incomingPermissions !== undefined) {
      const currentPermissionsResult = await strapi.db
        .query('admin::api-token')
        .load(updatedToken, 'permissions');

      const currentPermissions = map('action', currentPermissionsResult || []);
      const newPermissions = uniq(incomingPermissions || []);

      const actionsToDelete = difference(currentPermissions, newPermissions);
      const actionsToAdd = difference(newPermissions, currentPermissions);

      // TODO: improve efficiency here
      await Promise.all(
        actionsToDelete.map((action) =>
          strapi.db.query('admin::api-token-permission').delete({
            where: { action, token: id },
          })
        )
      );

      // TODO: improve efficiency here
      await Promise.all(
        actionsToAdd.map((action) =>
          strapi.db.query('admin::api-token-permission').create({
            data: { action, token: id },
          })
        )
      );
    }
    // if type is not custom, make sure any old permissions get removed
    else if (updatedToken.type !== constants.API_TOKEN_TYPE.CUSTOM) {
      await strapi.db.query('admin::api-token-permission').delete({
        where: { token: id },
      });
    }

    const permissionsFromDb = await strapi.db
      .query('admin::api-token')
      .load(updatedToken, 'permissions');

    return {
      ...updatedToken,
      permissions: permissionsFromDb ? permissionsFromDb.map((p: any) => p.action) : undefined,
    } as ApiToken;
  }

  // kind === 'admin'
  if (clampedAdminPermissions !== undefined) {
    if (callingUser === undefined) {
      throw new ValidationError('Updating admin permissions requires an authenticated admin user');
    }
    await assignAdminPermissionsToToken(id, clampedAdminPermissions, callingUser);
  }

  const adminPermissionsFromDb = await strapi.db
    .query('admin::api-token')
    .load(updatedToken, 'adminPermissions');

  const adminUserOwnerFromDb = await strapi.db
    .query('admin::api-token')
    .load(updatedToken, 'adminUserOwner');

  return {
    ...updatedToken,
    adminPermissions: adminPermissionsFromDb || [],
    adminUserOwner: adminUserOwnerFromDb,
  } as ApiToken;
};

const count = async (where = {}): Promise<number> => {
  return strapi.db.query('admin::api-token').count({ where });
};

export type { GetByOptions };

export {
  create,
  count,
  regenerate,
  exists,
  checkSaltIsDefined,
  hash,
  list,
  revoke,
  getById,
  update,
  getByName,
  getBy,
  assignAdminPermissionsToToken,
};
