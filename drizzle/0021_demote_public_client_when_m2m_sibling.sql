-- When developer_apps has a confidential m2m_ sibling, the primary app_ row must stay
-- public (token_endpoint_auth_method = none, no secret). Legacy apps were left
-- confidential on app_ after the split (0020 only cleared rows already at auth none).
UPDATE oidc_clients AS pub
SET
  client_secret_hash = NULL,
  token_endpoint_auth_method = 'none',
  grant_types = array_to_string(
    array_remove(string_to_array(pub.grant_types, ','), 'client_credentials'),
    ','
  )
FROM developer_apps AS d
WHERE d.oidc_client_id = pub.id
  AND d.m2m_oidc_client_id IS NOT NULL
  AND (
    pub.client_secret_hash IS NOT NULL
    OR pub.token_endpoint_auth_method <> 'none'
    OR pub.grant_types LIKE '%client_credentials%'
  );
