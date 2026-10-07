# Single sign-on (OIDC) and customer connections (OAuth)

## Single sign-on

Any OpenID Connect provider (Google Workspace, Microsoft Entra ID, Keycloak, Zoho, Okta…) can be added next to
password sign-in.

1. Register a web application ("confidential client") at the provider with the redirect URI
   `https://app.example.com/api/v1/auth/oidc/callback` (your `API_URL` + `/v1/auth/oidc/callback`).
2. In Dokploy set `OIDC_ISSUER_URL` (the issuer, e.g. `https://accounts.google.com`), `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`, optionally `OIDC_DISPLAY_NAME` (button text) and `OIDC_SCOPES`.
3. Redeploy. The login page shows **Sign in with …**.

Behaviour and safeguards:

- Authorization code flow with PKCE; `state`, `nonce` and the verifier travel in a 10-minute, single-use,
  encrypted HttpOnly cookie. The ID token (signature via the provider's JWKS, issuer, audience, expiry, nonce) is
  validated by `openid-client`.
- Identities are linked by issuer + subject. On first SSO sign-in an existing account is linked only if the
  provider marks the email `email_verified`; otherwise sign-in is refused.
- New accounts are created only with `OIDC_ALLOW_SIGNUP=true` (default: invite-only via existing accounts).
- Operators must still enter their OctaveOneCloud TOTP code after SSO; operator routes stay MFA-protected.
- `returnTo` accepts only same-site paths (no open redirects). Errors return to `/login?sso_error=…`.

## Customer connections

Apps and agents sometimes need a customer's own account (send email, publish posts). Customers connect it under
**Organisation → Connections**; owners and admins can connect and disconnect.

Configure each provider in Dokploy (endpoints from the provider's OAuth documentation — nothing is hard-coded):

```
CONNECTOR_<NAME>_LABEL=Gmail
CONNECTOR_<NAME>_AUTHORIZE_URL=…
CONNECTOR_<NAME>_TOKEN_URL=…
CONNECTOR_<NAME>_CLIENT_ID=…
CONNECTOR_<NAME>_CLIENT_SECRET=…
CONNECTOR_<NAME>_SCOPES=space separated, least privilege
CONNECTOR_<NAME>_APPS=app.crm,app.marketing        # only these apps may obtain tokens
CONNECTOR_<NAME>_EXTRA_AUTH_PARAMS=access_type=offline&prompt=consent   # provider-specific, optional
```

Register `https://app.example.com/api/v1/connectors/callback` as the redirect URI. Client credentials are sent in
the token request body (`client_secret_post`); providers that require HTTP Basic are not supported yet.

Safeguards:

- PKCE (S256) and a single-use encrypted flow cookie bound to the user and organisation that started it; the
  callback re-checks that the user still has `services.manage`.
- Tokens are encrypted with `CREDENTIAL_ENCRYPTION_KEY` (AES-256-GCM, bound to org + provider); they never appear
  in API responses to browsers or in logs.
- Apps get a current access token with `POST /api/v1/app-api/connectors/token { orgId, provider }` (signed like the
  other app API calls) only if listed in `CONNECTOR_<NAME>_APPS` and provisioned for that organisation. Tokens
  close to expiry are refreshed under a row lock (no double refresh). Each release is audited.
- Reconnecting replaces the previous grant; disconnecting revokes it here immediately — customers should also
  remove access in the provider account (provider-side revocation is not standardised).
- Consequential actions using a connection (sending, publishing, spending) still go through human approvals.

Each provider must be verified like any other integration (scopes, consent screen, app review where the provider
requires it) and recorded in `docs/provider-capabilities.md` before customers use it.
