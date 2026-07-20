-- RFC 8693: developer_apps.jwks_uri must use a public host (not loopback).
UPDATE "developer_apps"
SET "jwks_uri" = 'https://pymthouse.com/api/v1/oidc/jwks'
WHERE "jwks_uri" IS NULL
   OR position('localhost' in "jwks_uri") > 0
   OR position('127.0.0.1' in "jwks_uri") > 0;
