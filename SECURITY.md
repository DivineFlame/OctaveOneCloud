# Security policy

Please report vulnerabilities **privately** through GitHub Security Advisories
(Security → Report a vulnerability) rather than public issues. Include steps to reproduce and impact;
do not include real customer data or credentials.

Scope highlights: authentication/session handling, tenant isolation, payment and webhook processing,
supplier (ResellerClub) actions, stored credentials, and the operations console.

Operational rules for contributors:

- Never commit `.env` files, API keys, webhook secrets or database dumps. CI and `.gitignore` guard common cases,
  but review your diff.
- Rotate any secret that was ever pushed, even briefly; removing it from history is not enough.
- Supplier and payment credentials belong only in the deployment environment (Dokploy → Environment).
