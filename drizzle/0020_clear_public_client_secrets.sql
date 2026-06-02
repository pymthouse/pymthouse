-- Public OIDC clients (token_endpoint_auth_method = 'none') must never hold a
-- usable client secret. Legacy state from before the public/M2M split could leave
-- a client_secret_hash on the public app_ row, which made the dashboard surface a
-- misleading "Generate / Rotate Secret" control and report hasSecret = true.
-- Clear it so public clients stay public; confidential credentials live only on
-- the m2m_ backend helper sibling.
UPDATE "oidc_clients"
SET "client_secret_hash" = NULL
WHERE "token_endpoint_auth_method" = 'none'
  AND "client_secret_hash" IS NOT NULL;
