/**
 * ERC-8021 schema-2 transaction attribution suffix for Base builder codes.
 * https://eips.ethereum.org/EIPS/eip-8021
 */

export function encodeErc8021Schema2Suffix(builderCode: string): `0x${string}` {
  const code = builderCode.trim();
  if (!code || code.length > 32) {
    throw new Error("invalid_builder_code");
  }

  const codeBytes = Buffer.from(code, "utf8");
  const header = Buffer.from([0x02, codeBytes.length]);
  const payload = Buffer.concat([header, codeBytes]);
  return `0x${payload.toString("hex")}` as `0x${string}`;
}

export function appendBuilderCodeSuffix(
  calldata: `0x${string}`,
  builderCode: string | null | undefined,
): `0x${string}` {
  if (!builderCode?.trim()) {
    return calldata;
  }
  const suffix = encodeErc8021Schema2Suffix(builderCode);
  return `${calldata}${suffix.slice(2)}` as `0x${string}`;
}
