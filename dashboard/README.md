# MCP Server Builder dashboard

A hosted web dashboard where you and invited client staff sign in with Microsoft
Entra ID, fill in the intake wizard, save manifests per client workspace, and
download the generated MCP server as a .zip.

- Settings: `.env.example` (the server refuses to start with unsafe settings)
- Security design, test coverage and Azure App Service steps: `../docs/DASHBOARD-SECURITY.md`
- Storage: PostgreSQL (`DATABASE_URL`); manifests are encrypted before they are stored
- Tests: `npm test` (29 security tests against a local test identity provider). They need a
  PostgreSQL server; each run creates and drops its own database. By default they use
  `postgres://postgres@127.0.0.1:55432/postgres`; set `TEST_DATABASE_URL` to use another one.
  Quick local server: `docker run -d -p 55432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16`

## Try it on your own computer (demo mode)

```
npm install            # at the repository root
cd dashboard && npm install
npm run demo           # then open http://127.0.0.1:8080
```

Demo mode runs the real dashboard with an in-memory PostgreSQL (PGlite) and a local
page that stands in for the Microsoft sign-in (pick Rafael/admin, Alice, Bob, Victor or
Mallory). It listens on 127.0.0.1 only, uses a new random encryption key each run, and
keeps nothing after you stop it. It is not used in production (`npm start`).
