# MCP Server Builder dashboard

A hosted web dashboard where you and invited client staff sign in with Microsoft
Entra ID, fill in the intake wizard, save manifests per client workspace, and
download the generated MCP server as a .zip.

- Settings: `.env.example` (the server refuses to start with unsafe settings)
- Security design, test coverage and Azure App Service steps: `../docs/DASHBOARD-SECURITY.md`
- Tests: `npm test` (29 security tests against a local test identity provider)
