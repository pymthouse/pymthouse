import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "node:path";

const PROTO_FILES = [
  "livepeer/payments/v1/types.proto",
  "livepeer/payments/v1/payer_daemon.proto",
];

const PROTO_ROOT = path.join(process.cwd(), "proto");

export interface CreatePaymentGrpcInput {
  faceValueWei: bigint;
  recipient20: Buffer;
  capability: string;
  offering: string;
  ticketParamsBaseUrl: string;
}

interface GrpcPayerDaemonClient extends grpc.Client {
  createPayment(
    req: {
      faceValue: Buffer;
      recipient: Buffer;
      capability: string;
      offering: string;
      ticketParamsBaseUrl: string;
    },
    cb: (
      err: grpc.ServiceError | null,
      resp: { paymentBytes: Buffer },
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

export async function getPayerDaemonGrpcClient(
  socketPath: string,
): Promise<GrpcPayerDaemonClient> {
  let p = clientCache.get(socketPath);
  if (!p) {
    p = dial(socketPath);
    clientCache.set(socketPath, p);
  }
  return p;
}

export async function payerCreatePayment(
  socketPath: string,
  input: CreatePaymentGrpcInput,
): Promise<{ paymentB64: string }> {
  const client = await getPayerDaemonGrpcClient(socketPath);
  const resp = await new Promise<{ paymentBytes: Buffer }>((resolve, reject) => {
    client.createPayment(
      {
        faceValue: bigintToBigEndian(input.faceValueWei),
        recipient: input.recipient20,
        capability: input.capability,
        offering: input.offering,
        ticketParamsBaseUrl: input.ticketParamsBaseUrl,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
  return { paymentB64: Buffer.from(resp.paymentBytes).toString("base64") };
}

export async function payerIdentify(
  socketPath: string,
): Promise<{ address: Buffer; signature: Buffer }> {
  const client = await getPayerDaemonGrpcClient(socketPath);
  return new Promise((resolve, reject) => {
    client.identify({}, (err, result) => (err ? reject(err) : resolve(result)));
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
