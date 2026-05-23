import type { AuthResult } from "@/lib/auth";
import type { SignerConfig } from "@/db/schema";
import {
  decodeOrchestratorInfo,
  encodeSegCredsBase64FromDecodedOrchestrator,
} from "@/lib/proto";
import { resolvePaymentPipelineModelConstraint, resolveGatewayAttribution } from "@/lib/billing-runtime";
import { recordLivePaymentUsage } from "@/lib/signer-usage";
import {
  resolveDiscoveryOrchServiceUrl,
  resolveTicketParamsBaseUrlOverride,
  defaultPaymentCapabilityOffering,
} from "@/lib/signer-lpnm/socket-resolver";
import {
  payerCreatePayment,
  payerIdentify,
  payerSignByocJob,
} from "@/lib/signer-lpnm/payer-daemon-client";
import type { RegistryGenerateLivePaymentFields } from "@/lib/signer-lpnm/registry-payment";
export interface ProxyResult {
  status: number;
  body: unknown;
}

function pickTrimmedString(
  body: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function defaultWorkUnitNameForCapability(capability: string): string {
  const c = capability.trim().toLowerCase();
  if (c === "openai:audio-speech") return "characters";
  if (c === "openai:audio-transcriptions") return "audio_seconds";
  if (c === "openai:chat-completions") return "tokens";
  if (c === "openai:embeddings") return "tokens";
  if (c === "openai:images-generations") return "images";
  return "work-units";
}

function resolveWorkUnitName(
  requestBody: Record<string, unknown>,
  capability: string,
): string {
  return (
    pickTrimmedString(
      requestBody,
      "workUnitName",
      "work_unit_name",
      "workUnit",
      "work_unit",
    ) ?? defaultWorkUnitNameForCapability(capability)
  );
}

function hex0x(buf: Buffer): string {
  return `0x${buf.toString("hex")}`;
}

export async function lpnmProxySignOrchestratorInfo(
  _requestBody: unknown,
  socketPath: string,
): Promise<ProxyResult> {
  try {
    const { address, signature } = await payerIdentify(socketPath);
    return {
      status: 200,
      body: {
        address: hex0x(Buffer.from(address)),
        signature: hex0x(Buffer.from(signature)),
      },
    };
  } catch (e) {
    console.error("[lpnm] sign-orchestrator-info:", e);
    return { status: 502, body: { error: "PayerDaemon Identify failed" } };
  }
}

export async function lpnmProxyGenerateLivePayment(
  args: {
    auth: AuthResult;
    signer: SignerConfig;
    providerAppId: string | null;
    usageUserId: string | null;
    requestBody: Record<string, unknown>;
    socketPath: string;
    feeWei: bigint;
    platformCutWei: bigint;
    pricePerUnit: bigint;
    pixelsPerUnit: bigint;
    pixels: bigint;
    orchestratorData: string | undefined;
    streamSessionId: string | null;
    billingOracleProviderKey: string;
  },
): Promise<ProxyResult> {
  if (!args.orchestratorData) {
    return { status: 400, body: { error: "missing orchestrator" } };
  }

  if (args.feeWei <= 0n) {
    return { status: 400, body: { error: "computed fee must be > 0" } };
  }

  let orch;
  try {
    orch = await decodeOrchestratorInfo(args.orchestratorData);
  } catch (err) {
    console.warn("[lpnm] decode OrchestratorInfo:", err);
    return { status: 400, body: { error: "invalid orchestrator" } };
  }

  if (orch.address?.length !== 20) {
    return { status: 400, body: { error: "orchestrator address missing" } };
  }

  const constraint = await resolvePaymentPipelineModelConstraint(args.requestBody);
  const defaults = defaultPaymentCapabilityOffering();
  const capability = constraint?.pipeline ?? defaults.capability;
  const offering = constraint ? constraint.modelId : defaults.offering;
  const workUnitName = resolveWorkUnitName(args.requestBody, capability);

  const ticketParamsBaseUrl =
    orch.transcoder?.trim().replace(/\/+$/, "") ||
    resolveTicketParamsBaseUrlOverride();
  if (!ticketParamsBaseUrl) {
    return {
      status: 503,
      body: {
        error:
          "Missing ticket params URL: OrchestratorInfo.transcoder empty and LPNM_TICKET_PARAMS_BASE_URL unset",
      },
    };
  }

  let paymentB64: string;
  try {
    const r = await payerCreatePayment(args.socketPath, {
      fundedValueWei: args.feeWei,
      recipient20: Buffer.from(orch.address),
      capability,
      offering,
      ticketParamsBaseUrl,
      pricePerUnitWei: args.pricePerUnit,
      unitsPerPrice: args.pixelsPerUnit,
      estimatedUnits: args.pixels,
      workUnitName,
    });
    paymentB64 = r.paymentB64;
  } catch (e) {
    console.error("[lpnm] CreatePayment:", e);
    return { status: 502, body: { error: "PayerDaemon CreatePayment failed" } };
  }

  let segCreds: string | undefined;
  try {
    segCreds = (await encodeSegCredsBase64FromDecodedOrchestrator(orch)) ?? undefined;
  } catch (e) {
    console.warn("[lpnm] seg creds:", e);
  }

  const attribution = resolveGatewayAttribution(args.requestBody);
  await recordLivePaymentUsage({
    auth: args.auth,
    requestBody: args.requestBody,
    signer: args.signer,
    providerAppId: args.providerAppId,
    usageUserId: args.usageUserId,
    feeWei: args.feeWei,
    platformCutWei: args.platformCutWei,
    pricePerUnit: args.pricePerUnit,
    pixelsPerUnit: args.pixelsPerUnit,
    pixels: args.pixels,
    streamSessionId: args.streamSessionId,
    constraint,
    attribution,
    orchestratorAddress:
      orch.address?.length === 20
        ? `0x${Buffer.from(orch.address).toString("hex")}`
        : undefined,
    billingOracleProviderKey: args.billingOracleProviderKey,
  });

  return {
    status: 200,
    body: {
      payment: paymentB64,
      segCreds: segCreds ?? "",
      state: { state: "", sig: "" },
    },
  };
}

export async function lpnmProxyGenerateLivePaymentFromRegistry(
  args: {
    auth: AuthResult;
    signer: SignerConfig;
    providerAppId: string | null;
    usageUserId: string | null;
    requestBody: Record<string, unknown>;
    socketPath: string;
    feeWei: bigint;
    platformCutWei: bigint;
    pricePerUnit: bigint;
    pixelsPerUnit: bigint;
    pixels: bigint;
    streamSessionId: string | null;
    fields: RegistryGenerateLivePaymentFields;
    billingOracleProviderKey: string;
  },
): Promise<ProxyResult> {
  if (args.feeWei <= 0n) {
    return { status: 400, body: { error: "computed fee must be > 0" } };
  }

  const recipient20 = Buffer.from(args.fields.recipient.slice(2), "hex");
  if (recipient20.length !== 20) {
    return { status: 400, body: { error: "invalid registry recipient length" } };
  }

  const constraint = await resolvePaymentPipelineModelConstraint(args.requestBody);
  const capability = args.fields.capability;
  const offering = args.fields.offering;
  const ticketParamsBaseUrl = args.fields.ticketParamsBaseUrl;
  const workUnitName = resolveWorkUnitName(args.requestBody, capability);

  let paymentB64: string;
  try {
    const r = await payerCreatePayment(args.socketPath, {
      fundedValueWei: args.feeWei,
      recipient20,
      capability,
      offering,
      ticketParamsBaseUrl,
      pricePerUnitWei: args.pricePerUnit,
      unitsPerPrice: args.pixelsPerUnit,
      estimatedUnits: args.pixels,
      workUnitName,
    });
    paymentB64 = r.paymentB64;
  } catch (e) {
    console.error("[lpnm] CreatePayment (registry):", e);
    return { status: 502, body: { error: "PayerDaemon CreatePayment failed" } };
  }

  const attribution = resolveGatewayAttribution(args.requestBody);
  await recordLivePaymentUsage({
    auth: args.auth,
    requestBody: args.requestBody,
    signer: args.signer,
    providerAppId: args.providerAppId,
    usageUserId: args.usageUserId,
    feeWei: args.feeWei,
    platformCutWei: args.platformCutWei,
    pricePerUnit: args.pricePerUnit,
    pixelsPerUnit: args.pixelsPerUnit,
    pixels: args.pixels,
    streamSessionId: args.streamSessionId,
    constraint,
    attribution,
    orchestratorAddress: args.fields.recipient,
    billingOracleProviderKey: args.billingOracleProviderKey,
  });

  return {
    status: 200,
    body: {
      payment: paymentB64,
      segCreds: "",
      state: { state: "", sig: "" },
    },
  };
}

export async function lpnmProxySignByocJob(
  requestBody: unknown,
  socketPath: string,
): Promise<ProxyResult> {
  if (!requestBody || typeof requestBody !== "object") {
    return { status: 400, body: { error: "JSON body required" } };
  }
  const b = requestBody as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  const capability = typeof b.capability === "string" ? b.capability : "";
  const request = typeof b.request === "string" ? b.request : "";
  const parameters = typeof b.parameters === "string" ? b.parameters : "";
  let timeoutSeconds = 0;
  if (typeof b.timeout_seconds === "number") {
    timeoutSeconds = b.timeout_seconds;
  } else if (typeof b.timeoutSeconds === "number") {
    timeoutSeconds = b.timeoutSeconds;
  }
  if (!id.trim() || !capability.trim()) {
    return { status: 400, body: { error: "id and capability required" } };
  }
  if (timeoutSeconds <= 0) {
    return { status: 400, body: { error: "timeout_seconds must be > 0" } };
  }
  try {
    const { sender, signature } = await payerSignByocJob(socketPath, {
      id,
      capability,
      request,
      parameters,
      timeoutSeconds,
    });
    return {
      status: 200,
      body: {
        sender: hex0x(Buffer.from(sender)),
        signature: hex0x(Buffer.from(signature)),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIMPLEMENTED") || msg.includes("unknown service")) {
      return { status: 501, body: { error: "SignBYOCJob not supported by this payer-daemon" } };
    }
    console.error("[lpnm] sign-byoc-job:", e);
    return { status: 502, body: { error: "PayerDaemon SignBYOCJob failed" } };
  }
}

export async function lpnmProxyDiscoverOrchestrators(): Promise<ProxyResult> {
  const orchUrl = resolveDiscoveryOrchServiceUrl();
  if (!orchUrl) {
    return {
      status: 503,
      body: { error: "LPNM_DISCOVERY_ORCH_URL is not configured" },
    };
  }
  const defaults = defaultPaymentCapabilityOffering();
  return {
    status: 200,
    body: [
      {
        address: orchUrl,
        score: 1,
        capabilities: [defaults.capability],
      },
    ],
  };
}
