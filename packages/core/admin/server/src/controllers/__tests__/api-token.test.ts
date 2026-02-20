import { errors } from '@strapi/utils';
import { omit } from 'lodash/fp';
// @ts-expect-error - types are not generated for this file
// eslint-disable-next-line import/no-relative-packages
import createContext from '../../../../../../../tests/helpers/create-context';
import constants from '../../services/constants';
import apiTokenController from '../api-token';

describe('API Token Controller', () => {
  describe('Create API Token', () => {
    const legacyBody = {
      kind: 'content-api',
      name: 'api-token_tests-name',
      description: 'api-token_tests-description',
      type: 'read-only',
    };
    const adminBody = {
      kind: 'admin',
      name: 'api-token_tests-name',
      description: 'api-token_tests-description',
      adminPermissions: [],
    };
    const callingUser = { id: 1, roles: [{ code: 'strapi-super-admin' }] };

    test('Fails if API Token already exists', async () => {
      const exists = jest.fn(() => true);
      const ctx = createContext({ body: legacyBody });

      global.strapi = {
        contentAPI: {
          permissions: {
            providers: {
              action: {
                keys() {
                  return ['foo', 'bar'];
                },
              },
            },
          },
        },
        admin: {
          services: {
            'api-token': {
              exists,
            },
          },
        },
      } as any;

      expect.assertions(3);

      try {
        await apiTokenController.create(ctx as any);
      } catch (e: any) {
        expect(e instanceof errors.ApplicationError).toBe(true);
        expect(e.message).toEqual('Name already taken');
      }

      expect(exists).toHaveBeenCalledWith({ name: legacyBody.name });
    });

    describe('Content API kind', () => {
      test('Create API Token Successfully', async () => {
        const create = jest.fn().mockResolvedValue(legacyBody);
        const exists = jest.fn(() => false);
        const badRequest = jest.fn();
        const created = jest.fn();
        const ctx = createContext(
          { body: legacyBody },
          { badRequest, created, state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                exists,
                create,
              },
            },
          },
        } as any;

        await apiTokenController.create(ctx as any);

        expect(exists).toHaveBeenCalledWith({ name: legacyBody.name });
        expect(badRequest).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith(legacyBody, callingUser);
        expect(created).toHaveBeenCalled();
      });

      test('Create API Token with valid lifespan', async () => {
        const lifespan = constants.API_TOKEN_LIFESPANS.DAYS_7;
        const createBody = {
          ...legacyBody,
          lifespan,
        };
        const tokenBody = {
          ...createBody,
          expiresAt: Date.now() + lifespan,
          permissions: undefined,
        };

        const create = jest.fn().mockResolvedValue(tokenBody);
        const exists = jest.fn(() => false);
        const badRequest = jest.fn();
        const created = jest.fn();
        const ctx = createContext(
          { body: createBody },
          { badRequest, created, state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                exists,
                create,
              },
            },
          },
        } as any;

        await apiTokenController.create(ctx as any);

        expect(exists).toHaveBeenCalledWith({ name: tokenBody.name });
        expect(badRequest).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith(createBody, callingUser);
        expect(created).toHaveBeenCalledWith({ data: tokenBody });
      });

      test('Throws with invalid lifespan', async () => {
        const lifespan = 1235; // not in constants.API_TOKEN_LIFESPANS
        const createBody = {
          ...legacyBody,
          lifespan,
        };

        const create = jest.fn();
        const created = jest.fn();
        const ctx = createContext({ body: createBody }, { created });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                create,
              },
            },
          },
        } as any;

        await expect(apiTokenController.create(ctx as any)).rejects.toThrow(
          /lifespan must be one of the following values/
        );
        expect(create).not.toHaveBeenCalled();
        expect(created).not.toHaveBeenCalled();
      });

      test('Throws with negative lifespan', async () => {
        const lifespan = -1;
        const createBody = {
          ...legacyBody,
          lifespan,
        };

        const create = jest.fn();
        const created = jest.fn();
        const ctx = createContext({ body: createBody }, { created });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                create,
              },
            },
          },
        } as any;

        await expect(apiTokenController.create(ctx as any)).rejects.toThrow(
          /lifespan must be one of the following values/
        );
        expect(create).not.toHaveBeenCalled();
        expect(created).not.toHaveBeenCalled();
      });

      test('Ignores a received expiresAt', async () => {
        const lifespan = constants.API_TOKEN_LIFESPANS.DAYS_7;

        const createBody = {
          ...legacyBody,
          expiresAt: 1234,
          lifespan,
        };
        const tokenBody = {
          ...createBody,
          expiresAt: Date.now() + lifespan,
          permissions: undefined,
        };

        const create = jest.fn().mockResolvedValue(tokenBody);
        const exists = jest.fn(() => false);
        const badRequest = jest.fn();
        const created = jest.fn();
        const ctx = createContext(
          { body: createBody },
          { badRequest, created, state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                exists,
                create,
              },
            },
          },
        } as any;

        await apiTokenController.create(ctx as any);

        expect(exists).toHaveBeenCalledWith({ name: tokenBody.name });
        expect(badRequest).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith(omit(['expiresAt'], createBody), callingUser);
        expect(created).toHaveBeenCalledWith({ data: tokenBody });
      });

      test('Does not forward admin fields for legacy kind', async () => {
        const createBody = {
          ...legacyBody,
          adminUserOwner: 33,
        };
        const create = jest.fn().mockResolvedValue(legacyBody);
        const exists = jest.fn(() => false);
        const created = jest.fn();
        const ctx = createContext({ body: createBody }, { created, state: { user: callingUser } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                exists,
                create,
              },
            },
          },
        } as any;

        await apiTokenController.create(ctx as any);

        expect(create).toHaveBeenCalledWith(
          {
            kind: 'content-api',
            name: createBody.name,
            description: createBody.description,
            type: createBody.type,
            permissions: undefined,
            lifespan: undefined,
          },
          callingUser
        );
      });
    });

    describe('Admin kind', () => {
      test('Create API Token Successfully', async () => {
        const create = jest.fn().mockResolvedValue(adminBody);
        const exists = jest.fn(() => false);
        const badRequest = jest.fn();
        const created = jest.fn();
        const ctx = createContext({ body: adminBody }, { badRequest, created, state: { user: callingUser } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                exists,
                create,
              },
            },
          },
        } as any;

        await apiTokenController.create(ctx as any);

        expect(exists).toHaveBeenCalledWith({ name: adminBody.name });
        expect(badRequest).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith(adminBody, callingUser);
        expect(created).toHaveBeenCalled();
      });

      test('Does not forward content API fields for admin kind', async () => {
        const createBody = {
          ...adminBody,
          type: 'full-access',
          permissions: ['api::article.article.find'],
        };
        const create = jest.fn().mockResolvedValue(createBody);
        const exists = jest.fn(() => false);
        const created = jest.fn();
        const ctx = createContext({ body: createBody }, { created, state: { user: callingUser } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                exists,
                create,
              },
            },
          },
        } as any;

        await apiTokenController.create(ctx as any);

        expect(create).toHaveBeenCalledWith(
          {
            kind: 'admin',
            name: createBody.name,
            description: createBody.description,
            adminPermissions: createBody.adminPermissions,
            adminUserOwner: undefined,
            lifespan: undefined,
          },
          callingUser
        );
      });

      test('Create API Token with admin owner and valid lifespan', async () => {
        const lifespan = constants.API_TOKEN_LIFESPANS.DAYS_7;
        const createBody = {
          ...adminBody,
          adminUserOwner: 1,
          lifespan,
        };
        const tokenBody = {
          ...createBody,
          expiresAt: Date.now() + lifespan,
        };

        const create = jest.fn().mockResolvedValue(tokenBody);
        const exists = jest.fn(() => false);
        const created = jest.fn();
        const ctx = createContext({ body: createBody }, { created, state: { user: callingUser } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                exists,
                create,
              },
            },
          },
        } as any;

        await apiTokenController.create(ctx as any);

        expect(create).toHaveBeenCalledWith(
          {
            kind: 'admin',
            name: createBody.name,
            description: createBody.description,
            adminPermissions: createBody.adminPermissions,
            adminUserOwner: createBody.adminUserOwner,
            lifespan,
          },
          callingUser
        );
      });
    });
  });

  describe('List API tokens', () => {
    const tokens = [
      {
        id: 1,
        name: 'api-token_tests-name',
        description: 'api-token_tests-description',
        type: 'read-only',
      },
      {
        id: 2,
        name: 'api-token_tests-name-2',
        description: 'api-token_tests-description-2',
        type: 'full-access',
      },
    ];

    test('List API tokens successfully', async () => {
      const list = jest.fn().mockResolvedValue(tokens);
      const send = jest.fn();
      const callingUser = { id: 1, roles: [{ code: 'strapi-super-admin' }] };
      const ctx = createContext({}, { send, state: { user: callingUser } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              list,
            },
          },
        },
      } as any;

      await apiTokenController.list(ctx as any);

      expect(list).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith({ data: tokens });
    });
  });

  describe('Delete an API token', () => {
    const token = {
      id: 1,
      name: 'api-token_tests-name',
      description: 'api-token_tests-description',
      type: 'read-only',
    };

    test('Deletes an API token successfully', async () => {
      const revoke = jest.fn().mockResolvedValue(token);
      const deleted = jest.fn();
      const ctx = createContext({ params: { id: token.id } }, { deleted });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              revoke,
            },
          },
        },
      } as any;

      await apiTokenController.revoke(ctx as any);

      expect(revoke).toHaveBeenCalledWith(token.id);
      expect(deleted).toHaveBeenCalledWith({ data: token });
    });

    test('Does not return an error if the resource does not exists', async () => {
      const revoke = jest.fn().mockResolvedValue(null);
      const deleted = jest.fn();
      const ctx = createContext({ params: { id: token.id } }, { deleted });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              revoke,
            },
          },
        },
      } as any;

      await apiTokenController.revoke(ctx as any);

      expect(revoke).toHaveBeenCalledWith(token.id);
      expect(deleted).toHaveBeenCalledWith({ data: null });
    });
  });

  describe('Regenerate an API token', () => {
    const legacyToken = {
      id: 1,
      kind: 'content-api',
      name: 'api-token_tests-regenerate',
      description: 'api-token_tests-description',
      type: 'read-only',
    };

    const ownerUser = { id: 42, roles: [{ code: 'strapi-editor' }] };
    const superAdmin = { id: 99, roles: [{ code: 'strapi-super-admin' }] };

    test('Regenerates an ownerless content API token successfully', async () => {
      const regenerate = jest.fn().mockResolvedValue(legacyToken);
      const getById = jest.fn().mockResolvedValue(legacyToken);
      const created = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { created, state: { user: superAdmin } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              regenerate,
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.regenerate(ctx as any);

      expect(regenerate).toHaveBeenCalledWith(legacyToken.id);
    });

    test('Regenerates an owned admin token when caller is the owner', async () => {
      const adminToken = { ...legacyToken, kind: 'admin', adminUserOwner: ownerUser.id };
      const regenerate = jest.fn().mockResolvedValue({ ...adminToken, accessKey: 'new-key' });
      const getById = jest.fn().mockResolvedValue(adminToken);
      const created = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { created, state: { user: ownerUser } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              regenerate,
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.regenerate(ctx as any);

      expect(regenerate).toHaveBeenCalledWith(legacyToken.id);
    });

    test('Forbids regenerate when caller is not the owner', async () => {
      const otherUser = { id: 55, roles: [{ code: 'strapi-editor' }] };
      const adminToken = { ...legacyToken, kind: 'admin', adminUserOwner: ownerUser.id };
      const regenerate = jest.fn();
      const getById = jest.fn().mockResolvedValue(adminToken);
      const created = jest.fn();
      const forbidden = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { created, forbidden, state: { user: otherUser } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              regenerate,
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.regenerate(ctx as any);

      expect(forbidden).toHaveBeenCalled();
      expect(regenerate).not.toHaveBeenCalled();
    });

    test('Forbids regenerate when super admin tries to regenerate another user\'s token', async () => {
      const adminToken = { ...legacyToken, kind: 'admin', adminUserOwner: ownerUser.id };
      const regenerate = jest.fn();
      const getById = jest.fn().mockResolvedValue(adminToken);
      const created = jest.fn();
      const forbidden = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { created, forbidden, state: { user: superAdmin } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              regenerate,
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.regenerate(ctx as any);

      expect(forbidden).toHaveBeenCalled();
      expect(regenerate).not.toHaveBeenCalled();
    });

    test('Fails if token not found', async () => {
      const regenerate = jest.fn().mockResolvedValue(legacyToken);
      const getById = jest.fn().mockResolvedValue(null);
      const created = jest.fn();
      const notFound = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { created, notFound, state: { user: superAdmin } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              regenerate,
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.regenerate(ctx as any);

      expect(regenerate).not.toHaveBeenCalled();
      expect(getById).toHaveBeenCalledWith(legacyToken.id);
      expect(notFound).toHaveBeenCalledWith('API Token not found');
    });
  });

  describe('Retrieve an API token', () => {
    const legacyToken = {
      id: 1,
      kind: 'content-api',
      name: 'api-token_tests-name',
      description: 'api-token_tests-description',
      type: 'read-only',
    };

    const ownerUser = { id: 42, roles: [{ code: 'strapi-editor' }] };
    const superAdmin = { id: 99, roles: [{ code: 'strapi-super-admin' }] };

    test('Retrieve a content API token includes accessKey for any caller', async () => {
      const tokenWithKey = { ...legacyToken, accessKey: 'plaintext-key' };
      // first call (no key), second call (with key)
      const getById = jest.fn()
        .mockResolvedValueOnce(legacyToken)
        .mockResolvedValueOnce(tokenWithKey);
      const send = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { send, state: { user: superAdmin } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.get(ctx as any);

      expect(getById).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith({ data: tokenWithKey });
    });

    test('Retrieve an admin token returns accessKey only for the owner', async () => {
      const adminToken = { ...legacyToken, kind: 'admin', adminUserOwner: ownerUser.id };
      const adminTokenWithKey = { ...adminToken, accessKey: 'plaintext-key' };
      const getById = jest.fn()
        .mockResolvedValueOnce(adminToken)
        .mockResolvedValueOnce(adminTokenWithKey);
      const send = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { send, state: { user: ownerUser } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.get(ctx as any);

      expect(getById).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith({ data: adminTokenWithKey });
    });

    test('Retrieve an admin token does NOT return accessKey for super admin (not the owner)', async () => {
      const adminToken = { ...legacyToken, kind: 'admin', adminUserOwner: ownerUser.id };
      const getById = jest.fn().mockResolvedValue(adminToken);
      const send = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { send, state: { user: superAdmin } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.get(ctx as any);

      // Only one call — no second fetch for the key
      expect(getById).toHaveBeenCalledTimes(1);
      const sentData = send.mock.calls[0][0].data;
      expect(sentData.accessKey).toBeUndefined();
    });

    test('Fails if the API token does not exist', async () => {
      const getById = jest.fn().mockResolvedValue(null);
      const notFound = jest.fn();
      const ctx = createContext({ params: { id: legacyToken.id } }, { notFound, state: { user: superAdmin } });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.get(ctx as any);

      expect(getById).toHaveBeenCalledWith(legacyToken.id);
      expect(notFound).toHaveBeenCalledWith('API Token not found');
    });
  });

  describe('Update API Token', () => {
    const legacyBody = {
      kind: 'content-api',
      name: 'api-token_tests-name',
      description: 'api-token_tests-description',
      type: 'read-only',
    };
    const adminBody = {
      kind: 'admin',
      name: 'api-token_tests-name',
      description: 'api-token_tests-description',
      adminPermissions: [],
      adminUserOwner: 1,
    };

    const id = 1;

    test('Fails if the token does not exist', async () => {
      const getById = jest.fn(() => null);
      const notFound = jest.fn();
      const ctx = createContext({ body: legacyBody, params: { id } }, { notFound });

      global.strapi = {
        admin: {
          services: {
            'api-token': {
              getById,
            },
          },
        },
      } as any;

      await apiTokenController.update(ctx as any);

      expect(getById).toHaveBeenCalledWith(id);
      expect(notFound).toHaveBeenCalledWith('API Token not found');
    });

    describe('Content API kind', () => {
      test('Fails if the name is already taken', async () => {
        const getById = jest.fn(() => ({ id, ...legacyBody }));
        const getByName = jest.fn(() => ({ id: 2, name: legacyBody.name }));
        const ctx = createContext({ body: legacyBody, params: { id } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
              },
            },
          },
        } as any;

        expect.assertions(3);

        try {
          await apiTokenController.update(ctx as any);
        } catch (e: any) {
          expect(e instanceof errors.ApplicationError).toBe(true);
          expect(e.message).toEqual('Name already taken');
        }

        expect(getByName).toHaveBeenCalledWith(legacyBody.name);
      });

      test('Updates API Token Successfully', async () => {
        const update = jest.fn().mockResolvedValue(legacyBody);
        const getById = jest.fn(() => ({ id, ...legacyBody }));
        const getByName = jest.fn(() => null);
        const notFound = jest.fn();
        const send = jest.fn();
        const callingUser = { id: 1, roles: [{ code: 'strapi-super-admin' }] };
        const ctx = createContext(
          { body: legacyBody, params: { id } },
          { notFound, send, state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await apiTokenController.update(ctx as any);

        expect(getById).toHaveBeenCalledWith(id);
        expect(getByName).toHaveBeenCalledWith(legacyBody.name);
        expect(notFound).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledWith(id, legacyBody, callingUser);
        expect(send).toHaveBeenCalled();
      });

      test('Rejects content API update when injecting adminUserOwner', async () => {
        const invalidBody = {
          ...legacyBody,
          adminUserOwner: 2,
        };
        const update = jest.fn(() => {
          throw new errors.ValidationError('Legacy tokens cannot have an admin user owner');
        });
        const getById = jest.fn(() => ({ id, ...legacyBody }));
        const getByName = jest.fn(() => null);
        const callingUser = { id: 1, roles: [{ code: 'strapi-super-admin' }] };
        const ctx = createContext({ body: invalidBody, params: { id } }, { state: { user: callingUser } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await expect(apiTokenController.update(ctx as any)).rejects.toThrow(
          'Legacy tokens cannot have an admin user owner'
        );
      });

      test('Rejects content API update when injecting adminPermissions', async () => {
        const invalidBody = {
          ...legacyBody,
          adminPermissions: [],
        };
        const update = jest.fn(() => {
          throw new errors.ValidationError('Legacy tokens cannot carry admin permissions');
        });
        const getById = jest.fn(() => ({ id, ...legacyBody }));
        const getByName = jest.fn(() => null);
        const callingUser = { id: 1, roles: [{ code: 'strapi-super-admin' }] };
        const ctx = createContext({ body: invalidBody, params: { id } }, { state: { user: callingUser } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await expect(apiTokenController.update(ctx as any)).rejects.toThrow(
          'Legacy tokens cannot carry admin permissions'
        );
      });

      test('Rejects update when kind is changed from content-api to admin', async () => {
        const mutatedKindBody = {
          ...legacyBody,
          kind: 'admin',
        };
        const update = jest.fn(() => {
          throw new errors.ValidationError('kind is immutable after creation');
        });
        const getById = jest.fn(() => ({ id, ...legacyBody }));
        const getByName = jest.fn(() => null);
        const callingUser = { id: 1, roles: [{ code: 'strapi-super-admin' }] };
        const ctx = createContext(
          { body: mutatedKindBody, params: { id } },
          { state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await expect(apiTokenController.update(ctx as any)).rejects.toThrow(
          'kind is immutable after creation'
        );
        expect(update).toHaveBeenCalledTimes(1);
      });
    });

    describe('Admin kind', () => {
      test('Updates API Token Successfully for token owner', async () => {
        const update = jest.fn().mockResolvedValue(adminBody);
        const getById = jest.fn(() => ({ id, ...adminBody }));
        const getByName = jest.fn(() => null);
        const send = jest.fn();
        const callingUser = { id: 1, roles: [{ code: 'strapi-editor' }] };
        const ctx = createContext(
          { body: adminBody, params: { id } },
          { send, state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await apiTokenController.update(ctx as any);

        expect(update).toHaveBeenCalledWith(id, adminBody, callingUser);
        expect(send).toHaveBeenCalledWith({ data: adminBody });
      });

      test('Forbids update when caller is not owner and not super admin', async () => {
        const update = jest.fn();
        const forbidden = jest.fn();
        const getById = jest.fn(() => ({ id, ...adminBody }));
        const getByName = jest.fn(() => null);
        const callingUser = { id: 2, roles: [{ code: 'strapi-editor' }] };
        const ctx = createContext(
          { body: adminBody, params: { id } },
          { forbidden, state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await apiTokenController.update(ctx as any);

        expect(forbidden).toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      });

      test('Allows update when caller is super admin', async () => {
        const update = jest.fn().mockResolvedValue(adminBody);
        const getById = jest.fn(() => ({ id, ...adminBody }));
        const getByName = jest.fn(() => null);
        const send = jest.fn();
        const callingUser = { id: 99, roles: [{ code: 'strapi-super-admin' }] };
        const ctx = createContext(
          { body: adminBody, params: { id } },
          { send, state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await apiTokenController.update(ctx as any);

        expect(update).toHaveBeenCalledWith(id, adminBody, callingUser);
        expect(send).toHaveBeenCalled();
      });

      test('Rejects admin update when injecting type', async () => {
        const invalidBody = {
          ...adminBody,
          type: 'read-only',
        };
        const update = jest.fn(() => {
          throw new errors.ValidationError('Admin tokens cannot carry a legacy type');
        });
        const getById = jest.fn(() => ({ id, ...adminBody }));
        const getByName = jest.fn(() => null);
        const callingUser = { id: 1, roles: [{ code: 'strapi-editor' }] };
        const ctx = createContext({ body: invalidBody, params: { id } }, { state: { user: callingUser } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await expect(apiTokenController.update(ctx as any)).rejects.toThrow(
          'Admin tokens cannot carry a legacy type'
        );
      });

      test('Rejects admin update when injecting permissions', async () => {
        const invalidBody = {
          ...adminBody,
          permissions: [],
        };
        const update = jest.fn(() => {
          throw new errors.ValidationError('Admin tokens cannot carry legacy content-API permissions');
        });
        const getById = jest.fn(() => ({ id, ...adminBody }));
        const getByName = jest.fn(() => null);
        const callingUser = { id: 1, roles: [{ code: 'strapi-editor' }] };
        const ctx = createContext({ body: invalidBody, params: { id } }, { state: { user: callingUser } });

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await expect(apiTokenController.update(ctx as any)).rejects.toThrow(
          'Admin tokens cannot carry legacy content-API permissions'
        );
      });

      test('Rejects update when kind is changed from admin to content-api', async () => {
        const mutatedKindBody = {
          ...adminBody,
          kind: 'content-api',
        };
        const update = jest.fn(() => {
          throw new errors.ValidationError('kind is immutable after creation');
        });
        const getById = jest.fn(() => ({ id, ...adminBody }));
        const getByName = jest.fn(() => null);
        const callingUser = { id: 1, roles: [{ code: 'strapi-super-admin' }] };
        const ctx = createContext(
          { body: mutatedKindBody, params: { id } },
          { state: { user: callingUser } }
        );

        global.strapi = {
          admin: {
            services: {
              'api-token': {
                getById,
                getByName,
                update,
              },
            },
          },
        } as any;

        await expect(apiTokenController.update(ctx as any)).rejects.toThrow(
          'kind is immutable after creation'
        );
        expect(update).toHaveBeenCalledTimes(1);
      });
    });
  });
});
