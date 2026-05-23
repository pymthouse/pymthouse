import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createHash } from "node:crypto";
import path from "node:path";

const PROTO_FILES = [
  "livepeer/payments/v1/types.proto",
  "livepeer/payments/v1/payer_daemon.proto",
];

const PROTO_ROOT = path.join(process.cwd(), "proto");

export interface CreatePaymentGrpcInput {
  fundedValueWei: bigint;
  recipient20: Buffer;
  capability: string;
  offering: string;
  ticketParamsBaseUrl: string;
  pricePerUnitWei: bigint;
  unitsPerPrice: bigint;
  estimatedUnits: bigint;
  workUnitName: string;
}

interface GrpcPayerDaemonClient extends grpc.Client {
  createPayment(
    req: {
      recipient: Buffer;
      ticketParamsBaseUrl: string;
      acceptedPrice: {
        pricePerUnitWei: { value: Buffer };
        unitsPerPrice: string;
        workUnitName: string;
        capability: string;
        offering: string;
        quoteRef: {
          quoteId: string;
          quoteVersion: string;
          constraintFingerprint: Buffer;
          routeFingerprint: Buffer;
        };
      };
      funding: {
        estimatedUnits: string;
        fundedValueWei: { value: Buffer };
      };
    },
    cb: (
      err: grpc.ServiceError | null,
      resp: { paymentBytes: Buffer },
    ) => void,
  ): void;
  getDepositInfo(
    req: Record<string, never>,
    cb: (
      err: grpc.ServiceError | null,
      resp: {
        deposit: Buffer;
        reserve: Buffer;
        withdrawRound: string;
      },
    ) => void,
  ): void;
  health(
    req: Record<string, never>,
    cb: (err: grpc.ServiceError | null, resp: { status: string }) => void,
  ): void;
  identify(
    req: Record<string, never>,
    cb: (
      err: grpc.ServiceError | null,
      resp: { address: Buffer; signature: Buffer },
    ) => void,
  ): void;
  signByocJob(
    req: {
      id: string;
      capability: string;
      request: string;
      parameters: string;
      timeoutSeconds: number;
    },
    cb: (
      err: grpc.ServiceError | null,
      resp: { sender: Buffer; signature: Buffer },
    ) => void,
  ): void;
}

interface PayerDaemonProto {
  livepeer: { payments: { v1: { PayerDaemon: grpc.ServiceClientConstructor } } };
}

const clientCache = new Map<string, Promise<GrpcPayerDaemonClient>>();

function bigintToBigEndian(n: bigint): Buffer {
  if (n === 0n) return Buffer.alloc(0);
  const bytes: number[] = [];
  let v = n;
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return Buffer.from(bytes);
}

async function dial(socketPath: string): Promise<GrpcPayerDaemonClient> {
  const def = await protoLoader.load(PROTO_FILES, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_ROOT],
  });
  const proto = grpc.loadPackageDefinition(def) as unknown as PayerDaemonProto;
  const ClientCtor = proto.livepeer.payments.v1.PayerDaemon;
  const client = new ClientCtor(
    `unix:${socketPath}`,
    grpc.credentials.createInsecure(),
  ) as unknown as GrpcPayerDaemonClient;

  await new Promise<void>((resolve, reject) => {
    client.health({}, (err) => (err ? reject(err) : resolve()));
  });
  return client;
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

function asUint64String(v: bigint, fieldName: string): string {
  if (v < 0n) {
    throw new Error(`${fieldName} must be >= 0`);
  }
  return v.toString();
}

function defaultQuoteId(input: CreatePaymentGrpcInput): string {
  const digest = createHash("sha256")
    .update(
      `${input.capability}|${input.offering}|${input.workUnitName}|${input.pricePerUnitWei.toString()}|${input.unitsPerPrice.toString()}`,
    )
    .digest("hex");
  return `pymthouse-${digest.slice(0, 16)}`;
}

export function buildCreatePaymentRequest(input: CreatePaymentGrpcInput): {
  recipient: Buffer;
  ticketParamsBaseUrl: string;
  acceptedPrice: {
    pricePerUnitWei: { value: Buffer };
    unitsPerPrice: string;
    workUnitName: string;
    capability: string;
    offering: string;
    quoteRef: {
      quoteId: string;
      quoteVersion: string;
      constraintFingerprint: Buffer;
      routeFingerprint: Buffer;
    };
  };
  funding: {
    estimatedUnits: string;
    fundedValueWei: { value: Buffer };
  };
} {
  if (input.pricePerUnitWei <= 0n) {
    throw new Error("pricePerUnitWei must be > 0");
  }
  if (input.unitsPerPrice <= 0n) {
    throw new Error("unitsPerPrice must be > 0");
  }
  if (input.fundedValueWei <= 0n) {
    throw new Error("fundedValueWei must be > 0");
  }
  const workUnitName = input.workUnitName.trim();
  if (!workUnitName) {
    throw new Error("workUnitName must be non-empty");
  }
  const capability = input.capability.trim();
  if (!capability) {
    throw new Error("capability must be non-empty");
  }
  const offering = input.offering.trim();
  if (!offering) {
    throw new Error("offering must be non-empty");
  }
  const quoteId = defaultQuoteId({
    ...input,
    workUnitName,
    capability,
    offering,
  });
  return {
    recipient: input.recipient20,
    ticketParamsBaseUrl: input.ticketParamsBaseUrl,
    acceptedPrice: {
      pricePerUnitWei: { value: bigintToBigEndian(input.pricePerUnitWei) },
      unitsPerPrice: asUint64String(input.unitsPerPrice, "unitsPerPrice"),
      workUnitName,
      capability,
      offering,
      quoteRef: {
        quoteId,
        quoteVersion: "1",
        constraintFingerprint: sha256(`constraint:${capability}|${offering}`),
        routeFingerprint: sha256(`route:${capability}|${offering}`),
      },
    },
    funding: {
      estimatedUnits: asUint64String(input.estimatedUnits, "estimatedUnits"),
      fundedValueWei: { value: bigintToBigEndian(input.fundedValueWei) },
    },
  };
}

export async function getPayerDaemonGrpcClient(
  socketPath: string,
): Promise<GrpcPayerDaemonClient> {
  let p = clientCache.get(socketPath);
  if (!p) {
    p = dial(socketPath).catch((error) => {
      clientCache.delete(socketPath);
      throw error;
    });
    clientCache.set(socketPath, p);
  }
  return p;
}

export async function payerCreatePayment(
  socketPath: string,
  input: CreatePaymentGrpcInput,
): Promise<{ paymentB64: string }> {
  const client = await getPayerDaemonGrpcClient(socketPath);
  const req = buildCreatePaymentRequest(input);
  const resp = await new Promise<{ paymentBytes: Buffer }>((resolve, reject) => {
    client.createPayment(req, (err, result) => (err ? reject(err) : resolve(result)));
  });
  return { paymentB64: Buffer.from(resp.paymentBytes).toString("base64") };
}

export async function payerHealth(
  socketPath: string,
): Promise<{ status: string }> {
  const client = await getPayerDaemonGrpcClient(socketPath);
  return new Promise((resolve, reject) => {
    client.health({}, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

export async function payerIdentify(
  socketPath: string,
): Promise<{ address: Buffer; signature: Buffer }> {
  const client = await getPayerDaemonGrpcClient(socketPath);
  return new Promise((resolve, reject) => {
    client.identify({}, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

export async function payerGetDepositInfo(
  socketPath: string,
): Promise<{ deposit: Buffer; reserve: Buffer; withdrawRound: string }> {
  const client = await getPayerDaemonGrpcClient(socketPath);
  return new Promise((resolve, reject) => {
    client.getDepositInfo({}, (err, result) =>
      err ? reject(err) : resolve(result),
    );
  });
}

export async function payerSignByocJob(
  socketPath: string,
  input: {
    id: string;
    capability: string;
    request: string;
    parameters: string;
    timeoutSeconds: number;
  },
): Promise<{ sender: Buffer; signature: Buffer }> {
  const client = await getPayerDaemonGrpcClient(socketPath);
  return new Promise((resolve, reject) => {
    client.signByocJob(
      {
        id: input.id,
        capability: input.capability,
        request: input.request,
        parameters: input.parameters,
        timeoutSeconds: input.timeoutSeconds,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
}
