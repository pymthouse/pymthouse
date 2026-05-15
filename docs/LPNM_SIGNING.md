# Livepeer Network Modules (LPNM) remote signing

Per-developer-app `signing_mode` can be set to `lpnm_payer_daemon` so PymtHouse serves the existing `/api/v1/signer/*` HTTP contract by talking to **livepeer-network-modules** `livepeer-payment-daemon` in **sender** mode over a **unix socket**. **No capability-broker** is required: ticket-params HTTP resolution uses **`OrchestratorInfo.transcoder`** from the request (with an optional env fallback).

Legacy apps keep `legacy_remote_signer` (default): requests still forward through the signer DMZ to **go-livepeer** `remote_signer.go`.

## Environment variables (PymtHouse process)

| Variable | Purpose |
|----------|---------|
| `LPNM_PAYER_DAEMON_SOCKET` | Unix path to `PayerDaemon` gRPC (default `/run/pymthouse/payer.sock`). Ignored when the app row sets `payer_daemon_socket`. Point at the host bind mount used by `docker/payment-daemon` (e.g. `<repo>/data/lpnm-run/payer-daemon.sock`). |
| `LPNM_TICKET_PARAMS_BASE_URL` | Optional fallback when `OrchestratorInfo.transcoder` is empty — base URL the payer-daemon uses to fetch ticket params (no trailing slash). |
| `LPNM_DISCOVERY_ORCH_URL` | Orchestrator **address** (e.g. `0x…`) returned by `/discover-orchestrators` in LPNM mode, paired with `LPNM_PAYMENT_CAPABILITY` as the capability list. |
| `LPNM_PAYMENT_CAPABILITY` | Default capability id when the request does not imply one (default `live-video-to-video`). |
| `LPNM_PAYMENT_OFFERING` | Default offering id (default `default`). |

Serverless / Vercel deployments cannot host a stable unix-socket sidecar: keep **`signing_mode = legacy_remote_signer`** there.

## Local Docker (payer + service-registry, **images only**)

The payer stack lives under **`docker/payment-daemon/`**. It uses **`tztcloud/livepeer-payment-daemon`** and **`tztcloud/livepeer-service-registry-daemon`** images (no build from source).

```bash
cd docker/payment-daemon
cp .env .env.local   # optional: keep secrets out of git
docker compose up -d
```

Edit **`docker/payment-daemon/.env`**:

- **`PAYMENT_DAEMON_SOCKET_DIR`** — host directory bind-mounted to `/var/run/livepeer` in both containers (e.g. `<repo>/data/lpnm-run`). The payer socket is **`payer-daemon.sock`** there.
- **`PAYMENT_KEYSTORE`** / **`PAYMENT_KEYSTORE_PASSWORD_FILE`** — sender keystore paths (see compose file defaults).
- **`CHAIN_RPC`**, **`AI_SERVICE_REGISTRY_ADDRESS`**, etc. — as already configured for your network.

The payment-daemon image runs as **nonroot (UID 65532)**. Ensure the socket directory is writable by that uid:

```bash
mkdir -p ./data/lpnm-run && sudo chown -R 65532:65532 ./data/lpnm-run
```

Point PymtHouse at the payer socket:

```bash
export LPNM_PAYER_DAEMON_SOCKET="/absolute/path/to/pymthouse/data/lpnm-run/payer-daemon.sock"
```

If orchestrators omit `transcoder` on `OrchestratorInfo`, set **`LPNM_TICKET_PARAMS_BASE_URL`** to the HTTPS base the payer-daemon should query for ticket params.

The repo **root** `docker-compose.yml` only runs **signer-dmz**; it does **not** build or run the payer daemon.

## App settings API

`PUT /api/v1/apps/:id` accepts:

- `signingMode`: `legacy_remote_signer` | `lpnm_payer_daemon`
- `payerDaemonSocket`: optional string (max 512 chars) or empty / null to clear and fall back to `LPNM_PAYER_DAEMON_SOCKET` / default.

`GET /api/v1/apps/:id` includes the stored `signingMode` and `payerDaemonSocket` on the app object.
