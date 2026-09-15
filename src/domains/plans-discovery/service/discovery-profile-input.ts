import type { DiscoveryPolicy } from "@/shared/discovery/discovery-plans";
import { parseDiscoveryPolicyInput } from "@/shared/discovery/discovery-plans";
import type {
  CreateDiscoveryProfileInput,
  DiscoveryProfileCapabilityInput,
  UpdateDiscoveryProfileInput,
} from "../types/discovery-profiles";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

function parseDiscoveryProfileCapabilities(
  input: unknown,
): Ok<DiscoveryProfileCapabilityInput[]> | Err {
  if (input === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: "capabilities must be an array" };
  }
  try {
    const seen = new Set<string>();
    const capabilities = input.map((raw, index) => {
      const value = (raw ?? {}) as Record<string, unknown>;
      const pipeline = typeof value.pipeline === "string" ? value.pipeline.trim() : "";
      const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
      if (!pipeline) {
        throw new Error(`capabilities[${index}].pipeline is required`);
      }
      if (!modelId) {
        throw new Error(`capabilities[${index}].modelId is required`);
      }
      const capKey = `${pipeline}::${modelId}`;
      if (seen.has(capKey)) {
        throw new Error(
          `duplicate capability at capabilities[${index}] for pipeline "${pipeline}" and modelId "${modelId}"`,
        );
      }
      seen.add(capKey);
      const dp = parseDiscoveryPolicyInput(
        value.discoveryPolicy,
        `capabilities[${index}].discoveryPolicy`,
      );
      if (!dp.ok) {
        throw new Error(dp.error);
      }
      return { pipeline, modelId, discoveryPolicy: dp.policy };
    });
    return { ok: true, value: capabilities };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid capabilities",
    };
  }
}

export function parseCreateDiscoveryProfileInput(
  body: unknown,
): Ok<CreateDiscoveryProfileInput> | Err {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid JSON" };
  }
  const record = body as Record<string, unknown>;
  const name = String(record.name || "").trim();
  if (!name) {
    return { ok: false, error: "name is required" };
  }

  const policyParsed = parseDiscoveryPolicyInput(record.policy, "policy");
  if (!policyParsed.ok) {
    return { ok: false, error: policyParsed.error };
  }

  const parsedCaps = parseDiscoveryProfileCapabilities(record.capabilities);
  if (!parsedCaps.ok) {
    return parsedCaps;
  }

  return {
    ok: true,
    value: {
      name,
      policy: policyParsed.policy,
      capabilities: parsedCaps.value,
    },
  };
}

export function parseUpdateDiscoveryProfileInput(
  body: unknown,
  existing: { name: string; policy: DiscoveryPolicy | null },
): Ok<UpdateDiscoveryProfileInput> | Err {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid JSON" };
  }
  const record = body as Record<string, unknown>;

  const name = record.name !== undefined ? String(record.name || "").trim() : existing.name;
  if (!name) {
    return { ok: false, error: "name is required" };
  }

  const value: UpdateDiscoveryProfileInput = { name };

  if (record.policy !== undefined) {
    const parsed = parseDiscoveryPolicyInput(record.policy, "policy");
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    value.policy = parsed.policy;
  }

  if (record.capabilities !== undefined) {
    const parsedCaps = parseDiscoveryProfileCapabilities(record.capabilities);
    if (!parsedCaps.ok) {
      return parsedCaps;
    }
    value.capabilities = parsedCaps.value;
  }

  return { ok: true, value };
}
