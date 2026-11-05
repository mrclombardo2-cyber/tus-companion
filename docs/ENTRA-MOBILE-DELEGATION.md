# Mobile-to-Cloudflare TUS delegated authorization

## CURRENT STATUS: requires approval from TUS

This integration is OFF unless an approved TUS Entra administrator supplies the genuine timetable resource scope and corresponding app registration. A generic Microsoft/Graph login or student password does not grant access to Timetables/Scientia.

Microsoft documented mechanism:
https://learn.microsoft.com/en-us/entra/identity/app-proxy/application-proxy-configure-native-client-application

TUS IT helpdesk for Midlands (works on iPhone):
https://itservicedesk.midlands.tus.ie/

### Request to send to TUS IT / identity integration team

Subject: Approved delegated read access for TUS Athlone Timetables/Scientia

I am a TUS Athlone student developing an independent timetable companion. I want to replace manually exported Microsoft SSO browser cookies with secure, revocable, delegated Microsoft Entra access to the Timetables/Scientia resource currently served at https://timetables.midlands.tus.ie/2627/default.aspx.

Could your identity/integration team please confirm:
1. Is the Timetables application published through Microsoft Entra Application Proxy and does it support delegated bearer-token access, or is there an approved read-only timetable API?
2. Is independent automated timetable retrieval and redistribution permitted?
3. If supported, can TUS approve a single-tenant confidential web application using Authorization Code + PKCE, the resource-specific delegated user_impersonation permission, offline_access, and your normal Conditional Access/MFA rules?

Proposed callback: https://tus-companion.tusathlone.workers.dev/api/entraid/callback

Please provide the tenant ID, application proxy resource scope/Application ID URI, and how approval should be obtained. Do not send any passwords, client secrets, MFA codes or session cookies by email or helpdesk message.

### What TUS administrators must authorize

- Access to the actual Timetables/Scientia Application Proxy resource, not just Microsoft Graph.
- A single-tenant *confidential Web client* registration with the precise HTTPS callback above.
- Delegated user_impersonation permission on the Timetables resource, with valid university consent and policy approval.
- Renewable offline_access as permitted by TUS security policy.
- A designated authorized operator's Entra Object ID (OID), not merely their email.
- Confirmation that the independently operated Cloudflare collector may process the timetable data.

### Secure Cloudflare configuration once approved

Protect these configuration values in the Cloudflare Worker environment, never in this GitHub repository:

- TUS_ENTRA_TENANT_ID: TUS tenant GUID
- TUS_ENTRA_CLIENT_ID: approved confidential web client GUID
- TUS_ENTRA_CLIENT_SECRET: client secret, created and transferred securely by authorized administrator
- TUS_ENTRA_PROXY_SCOPE: exact delegated resource scope, e.g. api://RESOURCE-APPLICATION-ID/user_impersonation
- TUS_ENTRA_OPERATOR_OID: immutable Object ID of authorized central source account
- SESSION_CIPHER_KEY_B64: existing 32-byte encryption secret in Cloudflare

For security, the mobile authorization routes are inert unless all values are present and valid. Do not insert dummy IDs or placeholders in production.

### Once university consent and configuration are complete

1. On iPhone Safari, visit https://tus-companion.tusathlone.workers.dev/api/entraid/status. The expected response is waiting-for-phone-authorization.
2. Open https://tus-companion.tusathlone.workers.dev/api/entraid/connect.
3. Authenticate only on official Microsoft login and approve any MFA prompt.
4. The Cloudflare callback checks the single-use CSRF cookie, PKCE S256, signed ID token (JWKS), issuer, audience, nonce, TUS tenant and exact approved operator OID.
5. The system attempts a real request to the Scientia timetable using the delegated access token. A mere successful login is insufficient. If TUS rejects the token the connection is NOT saved, and the university must supply an authorized API/access route.
6. Once the timetable responds, Cloudflare encrypts the access/refresh tokens using AES-GCM with separate associated data, refreshes them using CAS, and uses the bearer token only for the TUS timetable host. The phone may then be switched off.
7. When TUS policy requires new user interaction, reconnect via the same phone link; there is no MFA bypass.

### Fail-closed behavior

- Without university configuration, the route responds with needs-university-approval and the PWA does not show a delegated reconnect option.
- Generic Graph scopes and unsupported proxy scopes are rejected during configuration.
- A token for an unapproved operator, a wrong tenant, an invalid signature, an incorrect nonce or a missing refresh token cannot replace the central session.
- A valid Microsoft sign-in without successful timetable access cannot replace the central session.
- Legacy encrypted browser-cookie sync continues operating if delegation is not enabled.
- No password, MFA code, Microsoft authorization code or token must be stored in GitHub Actions logs, issues, emails or code.

University authorization remains necessary and is NOT granted by simply deploying this code.
