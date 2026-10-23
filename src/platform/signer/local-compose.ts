/**
 * Name of the Docker Compose service in `infra/dev/docker-compose.local.yml`
 * that runs the local signer (Apache DMZ + go-livepeer, same as production).
 */
export const DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE = "signer-dmz" as const;
