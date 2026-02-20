import { isObject } from '../../../../../utils/objects';

/**
 * Sets all the none object values of an object to the given one
 * It preserves the shape of the object, it only modifies the leafs
 * of an object.
 * This utility is very helpful when dealing with parent<>children checkboxes
 */
const updateValues = (obj: object, valueToSet: boolean, isFieldUpdate = false): object => {
  return Object.keys(obj).reduce((acc, current) => {
    const currentValue = obj[current as keyof object];

    if (current === 'conditions' && !isFieldUpdate) {
      // @ts-expect-error – TODO: type better
      acc[current] = currentValue;

      return acc;
    }

    if (isObject(currentValue)) {
      return { ...acc, [current]: updateValues(currentValue, valueToSet, current === 'fields') };
    }

    // @ts-expect-error – TODO: type better
    acc[current] = valueToSet;

    return acc;
  }, {});
};

/**
 * Permission-aware version of updateValues.
 * When permissionChecker is undefined (Role editing), behaves like updateValues.
 * When permissionChecker is provided (App Token editing), filters leaf updates based on permissions.
 */
const updateValuesWithPermissions = (
  obj: object,
  valueToSet: boolean,
  permissionChecker?: (path: string[]) => boolean,
  currentPath: string[] = [],
  isFieldUpdate = false
): object => {
  if (permissionChecker === undefined) {
    return updateValues(obj, valueToSet, isFieldUpdate);
  }

  return Object.keys(obj).reduce((acc, current) => {
    const currentValue = obj[current as keyof object];
    const newPath = [...currentPath, current];

    if (current === 'conditions' && !isFieldUpdate) {
      // @ts-expect-error – TODO: type better
      acc[current] = currentValue;
      return acc;
    }

    if (isObject(currentValue)) {
      return {
        ...acc,
        [current]: updateValuesWithPermissions(
          currentValue,
          valueToSet,
          permissionChecker,
          newPath,
          current === 'fields'
        ),
      };
    }

    const hasPermission = permissionChecker(newPath);

    // @ts-expect-error – TODO: type better
    acc[current] = hasPermission ? valueToSet : currentValue;

    return acc;
  }, {});
};

export { updateValues, updateValuesWithPermissions };
