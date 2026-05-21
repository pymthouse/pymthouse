/**
 * Name of the Docker Compose service in the repo root `docker-compose.yml`
 * that runs the local signer (Apache DMZ + go-livepeer, same as production).
 */
export const DOCKER_COMPOSE_LOCAL_SIGNER_SERVICE = "signer-dmz" as const;
