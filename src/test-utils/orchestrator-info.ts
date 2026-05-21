import path from "node:path";
import protobuf from "protobufjs";

let cachedType: Promise<protobuf.Type> | null = null;

async function getOrchestratorInfoType(): Promise<protobuf.Type> {
  if (!cachedType) {
    cachedType = (async () => {
      const protoPath = path.resolve(process.cwd(), "proto/lp_rpc.proto");
      const root = await protobuf.load(protoPath);
      return root.lookupType("net.OrchestratorInfo");
    })();
  }
  return cachedType;
}

export interface OrchestratorInfoBuildOpts {
  /** price per unit (wei). Kept within Number.MAX_SAFE_INTEGER so protobufjs encodes deterministically. */
  pricePerUnit: number;
  /** pixels per unit (int64). */
  pixelsPerUnit?: number;
  /** 20-byte ETH address. Defaults to a fixed orchestrator address. */
  address?: Buffer;
  transcoder?: string;
}

/**
 * Build a base64-encoded OrchestratorInfo protobuf message suitable for use as
 * the `Orchestrator` field on a /generate-live-payment request body. The encoded
 * message is what `decodeOrchestratorInfo` in `src/platform/livepeer/proto.ts` consumes.
 */
export async function buildOrchestratorInfoBase64(
  opts: OrchestratorInfoBuildOpts,
): Promise<string> {
  const type = await getOrchestratorInfoType();
  const payload = {
    transcoder: opts.transcoder ?? "https://test-orch.invalid",
    priceInfo: {
      pricePerUnit: opts.pricePerUnit,
      pixelsPerUnit: opts.pixelsPerUnit ?? 1,
    },
    address:
      opts.address ??
      Buffer.from("000102030405060708090a0b0c0d0e0f10111213", "hex"),
  };
  const err = type.verify(payload);
  if (err) {
    throw new Error(`invalid OrchestratorInfo payload: ${err}`);
  }
  const message = type.create(payload);
  const encoded = type.encode(message).finish();
  return Buffer.from(encoded).toString("base64");
}
