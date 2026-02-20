# Uncommitted changes review (feat/mcp/api-tokens)

## Scope (files changed)

- **Admin content-types**
  - `packages/core/admin/server/src/content-types/Permission.ts`
  - `packages/core/admin/server/src/content-types/User.ts`
  - `packages/core/admin/server/src/content-types/api-token.ts`
- **Admin API token HTTP layer**
  - `packages/core/admin/server/src/routes/api-tokens.ts`
  - `packages/core/admin/server/src/controllers/api-token.ts`
  - `packages/core/admin/server/src/validation/api-tokens.ts`
  - `packages/core/admin/shared/contracts/api-token.ts`
- **Admin permission domain/services**
  - `packages/core/admin/server/src/domain/permission/index.ts`
  - `packages/core/admin/server/src/services/permission/queries.ts`
  - `packages/core/admin/server/src/services/api-token.ts` (**main business logic**)
- **Tests**
  - `packages/core/admin/server/src/controllers/__tests__/api-token.test.ts`
  - `packages/core/admin/server/src/services/__tests__/api-token.test.ts`
  - `packages/core/admin/server/src/strategies/__tests__/api-token.test.ts`
  - `packages/core/admin/admin/tests/server.ts`
  - `packages/core/admin/admin/src/pages/Settings/pages/ApiTokens/EditView/tests/EditViewPage.test.tsx`
- **Admin UI — permission matrix (ceiling-aware)**
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/utils/createPermissionChecker.ts` (**new**)
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/utils/updateValues.ts`
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/hooks/usePermissionsDataManager.tsx` (replaced `.ts`; adds `checkUserHasPermission`)
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/components/Permissions.tsx`
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/components/CollapsePropertyMatrix.tsx`
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/components/ContentTypeCollapses.tsx`
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/components/GlobalActions.tsx`
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/components/ConditionsModal.tsx`
  - `packages/core/admin/admin/src/pages/Settings/pages/Roles/components/PluginsAndSettings.tsx`
  - `packages/core/admin/admin/src/pages/Settings/pages/ApiTokens/EditView/components/AdminPermissions.tsx` (**new**)
  - `packages/core/admin/admin/src/pages/Settings/pages/ApiTokens/EditView/EditViewPage.tsx`
  - `packages/core/admin/admin/src/pages/Settings/pages/ApiTokens/EditView/components/FormApiTokenContainer.tsx`
  - `packages/core/admin/admin/src/pages/Settings/pages/ApiTokens/EditView/constants.ts`
  - `packages/core/admin/admin/src/pages/Settings/pages/ApiTokens/ListView.tsx`
  - `packages/core/admin/admin/src/pages/Settings/components/Tokens/Table.tsx`

## High-level outcome

API Tokens are now split into two **kinds**:

- **`content-api`** tokens: original content-API tokens. Have a `type` (`read-only`, `full-access`, `custom`), carry content-API route permissions, have no owner, and have no admin permissions.
- **`admin`** tokens: new MCP-oriented tokens. Always have an owner (`adminUserOwner`), carry admin permissions (`adminPermissions`) scoped by the owner's permission ceiling, and have no content-API `type` or content-API `permissions`.

`kind` is a string enumeration persisted in the database and forms a **TypeScript discriminated union** at the contract level, so all call-sites can narrow to the precise shape at compile time.

Beyond the kind split, this work also introduces:

- **Admin permission ceiling**: a non-super-admin can only assign token admin permissions within their own permission scope; conditions are inherited (not chosen).
- **Owner-only key access**: only the token owner can read the plaintext `accessKey` for admin tokens. Content API tokens keep back-compat (any caller with route permission can read the key).
- **List ownership filter**: non-super-admins only receive content-api tokens and their own admin tokens from `GET /api-tokens`.

## Token kind discriminant

### `kind` field — DB schema (`content-types/api-token.ts`)

- New `kind` attribute: `enumeration(['content-api', 'admin'])`, `required: true`, `default: 'content-api'` (backward compat — existing rows without the field migrate to `'content-api'`).
- `type` attribute changed to `required: false` (admin tokens have no type).
- `'kind'` added to `SELECT_FIELDS` in the service so it is always returned.

### TypeScript discriminated union (`shared/contracts/api-token.ts`)

The flat `ApiToken` and `ApiTokenBody` types are replaced with discriminated unions:

```typescript
type ApiTokenBase = { id, name, description, accessKey?, encryptedKey?, createdAt, updatedAt, expiresAt, lastUsedAt, lifespan }

export type ContentApiApiToken = ApiTokenBase & {
  kind: 'content-api';
  type: 'custom' | 'full-access' | 'read-only';
  permissions: string[];
}

export type AdminApiToken = ApiTokenBase & {
  kind: 'admin';
  adminPermissions: Permission[];
  adminUserOwner: Data.ID | AdminUser;
}

export type ApiToken = ContentApiApiToken | AdminApiToken;

type ContentApiApiTokenBody = { kind: 'content-api'; name; description; type; permissions?; lifespan? }
type AdminApiTokenBody  = { kind: 'admin';  name; description; adminPermissions?; adminUserOwner?; lifespan? }
export type ApiTokenBody = ContentApiApiTokenBody | AdminApiTokenBody;
```

`ContentApiApiToken` and `AdminApiToken` are both exported for use in service/controller helpers that need to operate on a specific kind.

### Service-layer enforcement (`services/api-token.ts`)

Two new guard helpers are called at the top of `create` and `update`:

- **`assertLegacyKindFields(attributes)`**: throws `ValidationError` if `adminPermissions` or `adminUserOwner` are present on a `kind: 'content-api'` body.
- **`assertAdminKindFields(attributes)`**: throws `ValidationError` if `type` or content-API `permissions` are present on a `kind: 'admin'` body.

**`create(attributes, callingUser?)`** branches on `attributes.kind`:

- `'content-api'`: calls `assertLegacyKindFields` → runs content-api path (content-API permissions, no owner — `adminUserOwner: null` written to DB).
- `'admin'`: calls `assertAdminKindFields` → runs admin path (owner defaulting to `callingUser.id`, admin permission ceiling enforcement, persists `adminPermissions`).

**`update(id, attributes, callingUser?)`**:

- Asserts `kind` immutability: if `attributes.kind` is present and differs from `originalToken.kind` → throws `ValidationError('kind is immutable after creation')`.
- Resolves `resolvedKind` from `originalToken.kind` (authoritative source), then branches:
  - `'content-api'`: `assertLegacyKindFields`, content-api permission diff logic.
  - `'admin'`: `assertAdminKindFields`, admin permission ceiling enforcement and `assignAdminPermissionsToToken`.
- `kind` is stripped from the DB write (immutable field, never updated).

### Validation (`validation/api-tokens.ts`)

- `apiTokenCreationSchema`: added `kind: yup.string().oneOf(['content-api', 'admin']).required()`. `type` changed to `.optional()` (cross-field consistency validated in service).
- `apiTokenUpdateSchema`: added `kind: yup.string().oneOf(['content-api', 'admin']).optional()`. `type` changed to `.optional()`.

### Controller restructure (`controllers/api-token.ts`)

The old flat guards (`canAccessToken`, `canReadAccessKey`, `canUpdateToken`) that checked `adminUserOwner` presence are replaced by three kind-aware helpers:

- `isTokenOwner(user, AdminApiToken)` — exact ownership check. Used for key access and regenerate (super-admin does NOT bypass).
- `canAccessAdminToken(user, AdminApiToken)` — owner OR super-admin. Used for metadata read and update of admin tokens.

Each handler now branches on `token.kind` at the top level:

| Handler | Content API path | Admin path |
|---|---|---|
| `create` | builds `ContentApiApiTokenBody` attributes (only content-api fields forwarded) | builds `AdminApiTokenBody` attributes (only admin fields forwarded) |
| `regenerate` | no extra check — anyone with route permission | `isTokenOwner` gate; super-admin forbidden |
| `get` | always fetches with decrypted key | key only for owner; metadata-only for everyone else |
| `update` | no ownership check | `canAccessAdminToken` gate (fixes pre-existing missing check) |
| `getAdminPermissions` | `ctx.badRequest` — not applicable to content-api | `canAccessAdminToken` gate |
| `updateAdminPermissions` | `ctx.badRequest` — not applicable to content-api | `canAccessAdminToken` gate |

### Invariants enforced

| Rule | Where |
|---|---|
| `kind` stored as string in DB | Content type schema |
| TypeScript narrowing via discriminant | Contracts union |
| Content API: no `adminUserOwner`, no `adminPermissions` | `assertLegacyKindFields` in service |
| Admin: no `type`, no content-API `permissions` | `assertAdminKindFields` in service |
| `kind` immutable after creation | `update()` in service |
| Existing tokens default to `'content-api'` | DB schema default |
| Content API tokens always expose key; admin tokens owner-only | Controller `get` / `regenerate` |
| Admin token update requires owner or super-admin | Controller `update` |
| `getAdminPermissions` / `updateAdminPermissions` reject content-api tokens | Controller early `badRequest` |

## Data model changes (admin content-types)

- **`admin::permission`**
  - Added nullable relation **`apiToken`** (many permissions → one api-token).
  - `role` explicitly marked `required: false` (to allow "token permissions" that have no role).
- **`admin::api-token`**
  - Added **`kind`** enumeration (`'content-api' | 'admin'`), `required: true`, `default: 'content-api'`.
  - `type` changed to `required: false` (admin tokens have no type).
  - Added **`adminPermissions`** one-to-many relation to `admin::permission` mapped by `permission.apiToken`.
  - Added **`adminUserOwner`** many-to-one relation to `admin::user`.
- **`admin::user`**
  - Added **`apiTokens`** one-to-many relation mapped by `apiToken.adminUserOwner`.

## Admin UI — permission matrix (ceiling-aware)

### Overview

The API token edit view now exposes an **Admin** permissions tab backed by the same matrix component used in the Roles edit page, extended with ceiling enforcement so users can only grant permissions within their own admin permission scope.

### Tab visibility rules in the edit view

- **Creating a new token** → only the Admin permissions matrix is shown (no Legacy tab).
- **Editing an owned token** (`adminUserOwner` is set) → two tabs: **Legacy** (existing content-API permissions) and **Admin** (admin permissions matrix).
- **Editing an ownerless content-api token** → only the Legacy tab (unchanged behavior, full back-compat).

### `Roles/utils/createPermissionChecker.ts` (new)

Two exported helpers used during bulk checkbox operations:

- `createFieldPermissionChecker(actionId, subject, userPermissions)` — returns a path-based checker that gates field-level leaf updates to the user's allowed fields for that action/subject pair.
- `createDynamicActionPermissionChecker(subject, actionId, userPermissions)` — same but resolves the `actionId` from the path when toggling a whole content-type row.

Both return `undefined` when `userPermissions` is absent, which signals "Role editing mode — no restrictions".

### `Roles/utils/updateValues.ts`

Added `updateValuesWithPermissions(obj, valueToSet, permissionChecker?, currentPath?, isFieldUpdate?)`:

- When `permissionChecker` is `undefined`, delegates to the original `updateValues` (Role editing, no change in behavior).
- When `permissionChecker` is provided (App Token editing), only sets leaf booleans to `valueToSet` if the checker approves the path; otherwise preserves the existing value.

### `Roles/components/Permissions.tsx`

Added optional `userPermissions?: AuthPermission[]` prop (the calling admin's own permissions, used as the ceiling):

- All dispatch handlers forward `userPermissions` to the reducer.
- **`ON_CHANGE_COLLECTION_TYPE_GLOBAL_ACTION_CHECKBOX`**: uses `createFieldPermissionChecker` + `updateValuesWithPermissions`; calls `inheritConditionsAtPath` on enable.
- **`ON_CHANGE_COLLECTION_TYPE_ROW_LEFT_CHECKBOX`**: gates simple field booleans and nested field objects through the ceiling checker; calls `inheritConditionsAtPath` on enable.
- **`ON_CHANGE_CONDITIONS`**: becomes a no-op when `userPermissions` is present (conditions are inherited, not user-chosen).
- **`ON_CHANGE_SIMPLE_CHECKBOX`**: calls `inheritConditionsAtPath` on enable when in App Token context.
- **`ON_CHANGE_TOGGLE_PARENT_CHECKBOX`**: uses `createDynamicActionPermissionChecker` + `updateValuesWithPermissions`; inherits conditions for the toggled action or all actions in a group.

When `userPermissions` is `undefined` the component behaves exactly as before (Role editing mode).

### UI-level ceiling enforcement (disabled checkboxes + read-only conditions)

So that less-privileged users cannot even *select* permissions outside their ceiling, the matrix **visually disables** checkboxes the user is not allowed to grant. This is implemented via a shared helper in context and updates to all child components that render checkboxes.

#### `Roles/hooks/usePermissionsDataManager.tsx` (replaced `.ts`)

- Context now exposes **`checkUserHasPermission(action, subject?, field?)`**: returns `true` when `userPermissions` is undefined (Role editing, no restrictions), else checks for a matching permission by action + subject and, when `field` is provided, validates the field against `properties.fields` (exact or parent-path match).
- Provider is implemented as a component so it can derive `checkUserHasPermission` from `userPermissions` and pass it through context.

#### Child components (all under `Roles/components/`)

- **`CollapsePropertyMatrix.tsx`**: Threads **`subject`** prop through the component tree. **ActionRow** and **SubActionRow** call `checkUserHasPermission(actionId, subject, fieldPath)` (with `fieldPath` only when `propertyName === 'fields'`) and set `disabled={isFormDisabled || !userHasPermission}` on every field-level and parent checkboxes.
- **`ContentTypeCollapses.tsx`**: Passes **`subject={uid}`** to `Collapse` and `CollapsePropertyMatrix`. **Collapse** uses `checkUserHasPermission(actionId, subject)` to disable action-level checkboxes; passes **`isReadOnly={userPermissions !== undefined}`** to `ConditionsModal`.
- **`GlobalActions.tsx`**: For each global action, checks `checkUserHasPermission(actionId, subject)` for **all** subjects of that action; disables the global checkbox when `!userHasPermissionForAll`.
- **`ConditionsModal.tsx`**: New prop **`isReadOnly?: boolean`**. When `true`: shows inherited-readonly message, syncs local state from `modifiedData` on change, blocks edits in `handleChange`/`handleSubmit`, renders conditions as read-only text instead of `MultiSelectNested`, and footer shows only "Close". **ActionRow** supports **`isReadOnly`** and renders a read-only summary when set.
- **`PluginsAndSettings.tsx`**: **SubCategory** uses `checkUserHasPermission(action, null)` to disable plugin/settings checkboxes; passes **`isReadOnly={userPermissions !== undefined}`** to `ConditionsModal`.

Result: when editing a token as a non-super-admin, only checkboxes for permissions (and fields) the user holds are enabled; condition modal is read-only and reflects inherited conditions.

### `ApiTokens/EditView/components/AdminPermissions.tsx` (new)

Thin wrapper component:

- Fetches the admin permissions layout via `useGetRolePermissionLayoutQuery({ role: '' })` (default layout, no role scoping).
- Reads the calling user's permissions from `useAuth()` to pass as the ceiling.
- Renders `<Permissions ref={...} layout={layout} permissions={initialAdminPermissions} userPermissions={userPermissions} isFormDisabled={disabled} />`.
- Forwards a `PermissionsAPI` ref so the parent can call `getPermissions()` / `setFormAfterSubmit()` on save.

### `ApiTokens/EditView/EditViewPage.tsx`

- Added `adminPermissionsRef = React.useRef<PermissionsAPI>(null)`.
- On **create and update**: collects `adminPermissionsRef.current?.getPermissions().permissionsToSend ?? []` and passes it as `adminPermissions` in the mutation body (both `createToken` and `updateToken` already accept `adminPermissions` via the contract).
- Calls `adminPermissionsRef.current?.setFormAfterSubmit()` after a successful save to sync the form's initial state.
- Contract fix: `ApiTokenBody.adminPermissions` now omits `actionParameters` (consistent with `PermissionsAPI.getPermissions()` return type and `UpdateAdminPermissions.Request`).
- **Regenerate button (owner-only)**: Uses `useAuth` to get the current user. Helpers `getOwnerId(apiToken.adminUserOwner)` and `isCurrentUserTokenOwner(apiToken, currentUser?.id)` determine if the current user may regenerate the token. `canRegenerateToken = canRegenerate && isCurrentUserTokenOwner(...)` is passed to `FormHead` as `canRegenerate`. The Regenerate button is therefore hidden when the token has an owner and the current user is not that owner (e.g. super admin viewing another user's token). Ownerless content-api tokens: regenerate remains available when RBAC allows it.

## Contracts + validation + routes (public surface)

### Contract changes
In `packages/core/admin/shared/contracts/api-token.ts`:

- `ApiToken` is now a discriminated union `ContentApiApiToken | AdminApiToken` (see "Token kind discriminant" section above). Both variants are exported.
- `ApiTokenBody` is likewise a discriminated union `ContentApiApiTokenBody | AdminApiTokenBody`.
- New endpoints:
  - **`GetAdminPermissions`**: `GET /api-tokens/:id/admin-permissions`
  - **`UpdateAdminPermissions`**: `PUT /api-tokens/:id/admin-permissions`

### Input validation changes
In `packages/core/admin/server/src/validation/api-tokens.ts`:

- `kind` is now required on create (`oneOf(['content-api', 'admin']).required()`) and optional on update.
- `type` changed to optional on both create and update (cross-field checks live in service).
- `adminPermissions` validated as array of `permission` (from `common-validators`).
- `adminUserOwner` accepted as `mixed().nullable()`.

### Route changes
In `packages/core/admin/server/src/routes/api-tokens.ts`:

- Added `GET /api-tokens/:id/admin-permissions` (requires `admin::api-tokens.read`)
- Added `PUT /api-tokens/:id/admin-permissions` (requires `admin::api-tokens.update`)

### Controller changes
In `packages/core/admin/server/src/controllers/api-token.ts`:

The controller is restructured around `token.kind`. See "Token kind discriminant — Controller restructure" above for the per-handler breakdown. Key points:

- `create()` builds kind-specific attribute objects — only the fields belonging to the kind are forwarded to the service (no stray fields crossing the boundary).
- `list()` passes `ctx.state.user` to `apiTokenService.list(ctx.state.user)` so ownership filtering is applied.
- `get()` / `regenerate()` use `isTokenOwner` (not `isSuperAdmin`) for the key-access gate — super-admin does NOT bypass.
- `getAdminPermissions` / `updateAdminPermissions` return `400 Bad Request` for content-api tokens.

## Business logic added/changed (services)

### `packages/core/admin/server/src/services/api-token.ts`

#### 1) Token now selects/populates kind, owner + admin permissions

- `SELECT_FIELDS` includes `'kind'`.
- `POPULATE_FIELDS` is `['permissions', 'adminPermissions', 'adminUserOwner']`.

#### 1b) List: ownership filtering

`list(callingUser: AdminUser)` (required, non-optional):

- Super-admins → no `where` filter; all tokens returned (but `accessKey` is never in `SELECT_FIELDS`, so it is never exposed).
- Regular admins → `where: { $or: [{ adminUserOwner: null }, { adminUserOwner: { id: callingUser.id } }] }` — only content-api tokens and tokens owned by the caller are returned.

#### 1c) Access key: opt-in decryption

- `getBy(whereParams, options?)` no longer selects `encryptedKey` or decrypts by default. Plaintext `accessKey` is **not** returned unless requested.
- Option `{ includeDecryptedKey: true }` selects `encryptedKey`, decrypts, and returns plaintext `accessKey`. Used only when the controller has confirmed the caller is the owner (or the token is content-api).
- `getById(id, options?)` and `getByName(name, options?)` accept and forward the options.
- Auth strategy `getBy({ accessKey: hash(token) })` is unchanged and never requests decryption.

#### 2) Token creation: kind-branched

On `create(attributes, callingUser?)`:

- **`kind: 'content-api'`**
  - Calls `assertLegacyKindFields` (no admin fields allowed).
  - Validates content-API permissions (`assertCustomTokenPermissionsValidity`).
  - Writes `adminUserOwner: null` to DB.
- **`kind: 'admin'`**
  - Calls `assertAdminKindFields` (no content-api fields allowed).
  - Validates admin-permission actions exist and `validatePermissionsExist`.
  - **Enforces ceiling + clamps** via `enforceAdminPermissionsCeiling`.
  - Owner defaults to `callingUser.id`; explicit `adminUserOwner` must match caller.
  - Persists admin permissions as `admin::permission` rows with `apiToken = tokenId`, `role = null`.

#### 3) Token update: kind-immutable, kind-branched

On `update(id, attributes, callingUser?)`:

- **Kind immutability**: if `attributes.kind` is provided and differs from `originalToken.kind` → throws `ValidationError`.
- `kind` is stripped from the DB write.
- Branches on `originalToken.kind`:
  - `'content-api'`: content-api permission diff logic.
  - `'admin'`: admin permission ceiling enforcement + `assignAdminPermissionsToToken`.
- **`adminUserOwner` immutable**: if provided, it must equal the existing value.

#### 4) Core rule: admin permission "ceiling" enforcement (+ condition inheritance)

`enforceAdminPermissionsCeiling(user, requestedPermissions?) -> PermissionInput[]`:

- **Bypasses**
  - If `requestedPermissions` empty → returns `[]`
  - If user has `SUPER_ADMIN_CODE` role → returns requested as-is
- **Strict**: If admin permissions are requested but `user` is missing → throws `ValidationError` (no ceiling bypass).
- **Matching rule**
  - For each requested permission, it must match at least one user permission by:
    - `action` equality AND
    - `subject` equality, treating "missing subject" as `null`.
- **Field-level ceiling**
  - If any matching user permission has `properties.fields` undefined/empty → treat as "all fields allowed".
  - Else compute effective allowed fields as **union** across matching permissions' `properties.fields`.
  - If requested permission specifies fields, they must be a subset of the effective allowed fields.
- **Condition-level enforcement**
  - The caller cannot choose conditions for token permissions.
  - If any matching user permission is unconditional (`conditions` missing/empty) → enforced conditions become `[]`.
  - Else enforced conditions become the **union** across matching permissions' `conditions`.
  - The returned permission is "clamped" to these enforced conditions.
- If any permission exceeds the ceiling, throws `ValidationError` with a human-readable list (action/subject + optionally field names).

#### 5) Assign admin permissions to token (diff-based)

`assignAdminPermissionsToToken(tokenId, permissions, callingUser?)`:

- Validates permissions exist.
- Enforces ceiling (when caller provided) and uses **clamped** permissions.
- Converts requested permissions into permission objects linked to token (`apiToken`, `role: null`).
- Diffs against existing DB permissions for that token using `arePermissionsEqual` comparing:
  - `conditions`, `properties`, `subject`, `action`, `actionParameters`
- Deletes removed permissions and creates new ones, then returns the full current set.

### `packages/core/admin/server/src/services/permission/queries.ts`

`cleanPermissionsInDatabase()` now:

- Fetches permissions with `populate: ['role', 'apiToken']`.
- Deletes:
  - invalid permissions (existing logic: invalid action/subject/properties), and
  - **orphaned permissions** where **both** `role` and `apiToken` are missing.

This is important because permissions can now be attached to either a role or an api-token; "no role" is no longer automatically invalid, but "no role and no apiToken" is.

### `packages/core/admin/server/src/domain/permission/index.ts`

- Added `apiToken` into `permissionFields` so permission-domain creation/picking preserves token linkage.

## Admin UI — owner display

### Edit view (`FormApiTokenContainer.tsx`)

A read-only **Owner** field is shown in the token details section when:

- `adminUserOwner` is populated as an `AdminUser` object (not just an ID), AND
- the owner's `id` differs from the currently logged-in user's `id`.

This makes the field visible only to super admins viewing another user's token; owners editing their own token see no extra field. Display name is resolved as `firstname + lastname` → `username` → `email`.

### Regenerate button (EditViewPage → FormHead)

The **Regenerate** button is hidden (not rendered) when the API token has an owner and the current user is not that owner. Logic lives in `EditViewPage.tsx`: `canRegenerateToken = canRegenerate && isCurrentUserTokenOwner(apiToken, currentUser?.id)`; when the token has no owner (content-api) or the current user is the owner, the button is shown if RBAC allows (`canRegenerate`). This aligns with the backend rule that only the owner may call `POST .../regenerate` and read the new key.

### List view (`ListView.tsx` + `Table.tsx`)

Added an **Owner** column to the API tokens list table:

- `TABLE_HEADERS` in `ListView.tsx` gains an `adminUserOwner` entry (label "Owner", non-sortable).
- `Table.tsx` renders the corresponding cell conditionally on `tokenType === 'api-token'`, with the same name-resolution logic. Transfer token rows are unaffected (they keep their 4-column layout; the owner cell is never rendered for them).
- Ownerless / content-api tokens show an empty cell.

## Admin UI — kind-based rendering (EditViewPage + FormApiTokenContainer)

### Overview

The edit/create view now branches strictly on `kind` — no tab switching, no mixed layout.

### `resolvedKind` derivation

In `EditViewPage.tsx`:

- **Create mode**: `resolvedKind` is always `'admin'` (new tokens default to admin kind).
- **Edit mode**: `resolvedKind` is `apiToken.kind` (immutable, sourced from server response).

No kind selector is ever rendered; `kind` cannot be changed in the UI.

### Rendering rules

| `resolvedKind` | Permissions section | Token type selector |
|---|---|---|
| `'admin'` | `<AdminPermissions>` matrix only | Hidden |
| `'content-api'` | Legacy `<Permissions>` (content routes) | Shown |

The previous tab layout (`Legacy` / `Admin`) that was conditioned on `adminUserOwner` presence is removed. Kind is now the sole discriminant.

### `FormApiTokenContainer.tsx`

- Accepts a new required `kind: 'admin' | 'content-api'` prop.
- Renders `<TokenTypeSelect>` only when `kind === 'content-api'`.
- Owner read-only field logic is unchanged.

### Formik schema (`constants.ts`)

- `type` field changed from `required` to `optional` — admin tokens have no type.

### Discriminated request payloads

`handleSubmit` in `EditViewPage.tsx` builds strictly kind-scoped bodies:

- **Create** (always admin): `{ kind: 'admin', name, description, lifespan, adminPermissions }`
- **Update admin**: `{ kind: 'admin', name, description, adminPermissions }`
- **Update content-api**: `{ kind: 'content-api', name, description, type, permissions }`

No cross-kind fields are ever sent.

### Legacy reducer effects guarded by kind

`ON_CHANGE_READ_ONLY`, `SELECT_ALL_ACTIONS`, and `UPDATE_PERMISSIONS` dispatches are only triggered when `kind === 'content-api'`, preventing content-permissions state from polluting admin-token save payloads.

### `isCurrentUserTokenOwner` helper

Updated to check `apiToken.kind === 'admin'` before accessing `adminUserOwner`, so content-api tokens always return `true` (no owner restriction).

## Admin UI — test fixtures and tests

### `admin/tests/server.ts`

- Added `kind: 'content-api'` to existing `/admin/api-tokens` list and `/admin/api-tokens/:id` (id `'1'`) fixtures.
- Added a new `/admin/api-tokens/2` fixture returning an admin token (`kind: 'admin'`, `adminPermissions: []`, `adminUserOwner` populated).
- Extended `/admin/permissions` handler to also serve the full layout (with `collectionTypes`, `singleTypes`, `plugins`, `settings` sections) when `role === ''` — required by `AdminPermissions` which calls the endpoint without a role parameter.

### `EditView/tests/EditViewPage.test.tsx`

Replaced the single snapshot test with five focused behavioural tests:

| Test | Asserts |
|---|---|
| Create mode — renders form, hides type selector | Form fields present; `Token type` absent |
| Edit content-api (id 1) — renders type + permissions | `Token type` label present; `Address` route visible |
| Edit content-api (id 1) — hides admin matrix | Admin matrix section title absent |
| Edit admin (id 2) — hides type selector | `Token type` absent |
| Edit admin (id 2) — hides content-api permissions | Route-bound section absent |

## Backend — kind immutability tests

### `controllers/__tests__/api-token.test.ts`

Added two controller-level tests for `kind` mutation rejection:

- **Content API → admin**: update body with `kind: 'admin'` on a `content-api` token → service throws `'kind is immutable after creation'`; controller propagates the error.
- **Admin → content-api**: update body with `kind: 'content-api'` on an `admin` token → same rejection.

Both tests confirm `update` is called (rejection is service-layer, not controller-layer).

### `strategies/__tests__/api-token.test.ts`

Added `kind: 'content-api'` to the `apiToken` fixture used in authenticate tests — required because the auth strategy now explicitly rejects tokens whose `kind !== 'content-api'` with `ForbiddenError('NON CONTENT API TOKEN NOT SUPPORTED')`.

## Behavioral implications / notes

- **`kind` is the canonical discriminant**: all code should branch on `token.kind`, not on the presence of `adminUserOwner`.
- **Security posture improvement**: non-super-admins can't mint API tokens that grant broader admin powers than they personally have.
- **Condition inheritance is a strong constraint**: token admin permissions cannot be "less restrictive" (or arbitrarily different) than the caller's; conditions are enforced from the caller's own role permissions.
- **Field ceiling is enforced only when the user's permission is field-scoped**: if user has "all fields" for a matching permission (no `properties.fields`) then token can request any fields.
- **Token list visibility**: non-super-admins only receive content-api tokens and tokens they own from `GET /api-tokens`. Super admins receive all tokens. Neither role ever receives `accessKey` in the list (it is not in `SELECT_FIELDS`).
- **Access key visibility**: only the token owner can read the plaintext `accessKey` (via `GET /api-tokens/:id` or `POST .../regenerate`). Super admins can list and manage tokens but never see others' keys. Content-api tokens keep back-compat: any caller with route permission can read the key. All new admin tokens created via the UI are owned by their creator.
- **Admin UI**: Edit view uses explicit checks for `accessKey` (`!== undefined` and `!== ''`) in all three places: initial `apiToken` state, initial `showToken` state, and the render-time `canShowToken` / token box guard. When the API omits the key, "View token" is **hidden** (not merely disabled). The **Regenerate** button is similarly hidden via an explicit ownership check. Kind-based rendering replaces the previous `adminUserOwner`-based tab visibility.
- **Admin UI — permission matrix**: Ceiling is enforced in two layers: (1) **reducer** blocks state updates for bulk operations and for conditions when `userPermissions` is set; (2) **UI** disables checkboxes the user is not allowed to grant (via `checkUserHasPermission` in context) and shows the conditions modal as read-only when editing a token.

## Quick manual test ideas (high signal)

- **Kind enforcement (create)**
  - `POST /api-tokens` with `kind: 'content-api'` + `adminPermissions` → expect `ValidationError`.
  - `POST /api-tokens` with `kind: 'admin'` + `type: 'read-only'` → expect `ValidationError`.
  - `POST /api-tokens` with `kind: 'admin'` and no `callingUser` → expect `ValidationError`.
- **Kind immutability (update)**
  - `PUT /api-tokens/:id` with `kind: 'admin'` on a content-api token → expect `ValidationError`.
- **Ceiling (action/subject)**
  - As a non-super-admin, try to assign an admin permission you don't have → expect `ValidationError`.
- **Ceiling (fields)**
  - If your role permission is field-scoped, request a field outside your scope → expect `ValidationError`.
- **Conditions inheritance**
  - If your role permission has conditions, set token permission with different/no conditions → stored permission conditions should match inherited union (or empty if any unconditional match exists).
- **Token list (ownership filter)**
  - As a non-super-admin, `GET /api-tokens` → only content-api tokens and your own admin tokens are returned.
  - As super admin, `GET /api-tokens` → all tokens are returned (no `accessKey` in any entry).
- **Ownership**
  - Create an admin token; confirm `adminUserOwner` defaults to caller.
  - As a different non-super-admin, call `GET /api-tokens/:id/admin-permissions` → expect `403`.
  - Call `GET /api-tokens/:id/admin-permissions` on a content-api token → expect `400 Bad Request`.
- **Access key (owner-only)**
  - As owner, `GET /api-tokens/:id` → response includes `accessKey`; "View token" works in UI.
  - As super admin, `GET /api-tokens/:id` for a token owned by another user → response has no `accessKey`.
  - As super admin, `POST /api-tokens/:id/regenerate` for another user's token → expect `403`.
  - Content-api token: any user with read permission can `GET` and see `accessKey`.
- **Admin UI — Regenerate button**
  - As owner of an admin token, edit page shows Regenerate (when RBAC allows).
  - As super admin editing another user's token, Regenerate button is hidden.
  - Content-api token: Regenerate shown when RBAC allows.
- **Admin UI — kind-based section visibility**
  - Create a new token → admin permissions matrix shown, no token type selector.
  - Open a content-api token → token type selector + content permissions shown, no admin matrix.
  - Open an admin token → admin permissions matrix shown, no token type selector.
- **Admin UI — ceiling enforcement in matrix**
  - As a non-super-admin, enable a permission you hold → checkbox becomes checked.
  - Try to enable a permission you do not hold → checkbox stays unchecked (silently blocked by ceiling).
  - If your role permission is field-scoped, only allowed fields are selectable; others remain unchecked.
  - Condition checkboxes in the modal are read-only (inherited from your role) when editing a token.
- **Admin UI — save round-trip**
  - Enable some admin permissions on create → save → reopen → same permissions are pre-checked.
  - Uncheck a permission → save → reopen → permission is no longer checked.
