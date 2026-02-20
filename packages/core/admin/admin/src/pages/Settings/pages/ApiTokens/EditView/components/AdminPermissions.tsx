import * as React from 'react';

import { Page } from '../../../../../../components/PageHelpers';
import { useAuth } from '../../../../../../features/Auth';
import { useGetRolePermissionLayoutQuery } from '../../../../../../services/users';
import { Permissions, PermissionsAPI } from '../../../Roles/components/Permissions';

import type { Permission } from '../../../../../../../../shared/contracts/shared';

interface AdminPermissionsProps {
  disabled?: boolean;
  initialAdminPermissions: Permission[];
}

const AdminPermissions = React.forwardRef<PermissionsAPI, AdminPermissionsProps>(
  ({ disabled, initialAdminPermissions }, ref) => {
    const { permissions: userPermissions } = useAuth('AdminPermissions', (auth) => auth);

    const { data: layout, isLoading, error } = useGetRolePermissionLayoutQuery({ role: '' });

    if (isLoading) {
      return <Page.Loading />;
    }

    if (error !== undefined || layout === undefined) {
      return null;
    }

    return (
      <Permissions
        ref={ref}
        layout={layout}
        permissions={initialAdminPermissions}
        userPermissions={userPermissions}
        isFormDisabled={disabled}
      />
    );
  }
);

export { AdminPermissions };
export type { AdminPermissionsProps };
