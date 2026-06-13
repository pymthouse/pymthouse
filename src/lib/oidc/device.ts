/** oidc-provider deviceFlow.mask — eight alphanumeric chars, often shown as XXXX-XXXX. */
export const DEVICE_USER_CODE_MASK = "****-****";

export const DEVICE_USER_CODE_LENGTH = DEVICE_USER_CODE_MASK.split("*").length - 1;

export function normalizeUserCode(value: string): string {
  return value
    .replace(/[a-z]/g, (char) => char.toUpperCase())
    .replace(/\W/g, "");
}

export function isCompleteUserCode(value: string): boolean {
  return normalizeUserCode(value).length === DEVICE_USER_CODE_LENGTH;
}
