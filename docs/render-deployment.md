# Free Render demo deployment

The repository includes a Render Blueprint that creates one free Node web service and one free PostgreSQL database in Singapore. This is suitable for an interview demonstration. Render's free web service sleeps after inactivity, and its free database expires after 30 days, so it is not a production company deployment.

## Deploy

1. Open the Blueprint deployment page for this repository and select the `codex/improve-sdlc-feedback` branch if Render asks for a branch.
2. Supply the four secret values requested by Render:
   - `GITHUB_CLIENT_ID`: the installation-wide GitHub OAuth application client ID.
   - `GITHUB_CLIENT_SECRET`: the matching OAuth client secret.
   - `GITHUB_ALLOWED_USERS`: comma-separated GitHub logins allowed to sign in, or `*` for a public demo.
   - `GITHUB_ADMIN_USERS`: comma-separated allowed logins that receive administrator access.
3. Deploy the Blueprint and wait for `/healthz` to report healthy.
4. In the GitHub OAuth application settings, change:
   - Homepage URL to `https://<render-hostname>`
   - Authorization callback URL to `https://<render-hostname>/auth/github/callback`
5. Connect any Codex installation to the hosted control plane:

   ```powershell
   npx -y @melaonn/sdlc-mcp install --server https://<render-hostname>
   ```

The local MCP process still inspects and edits the developer's local checkout and executes local quality gates. Render hosts only the dashboard, lifecycle state, company context, and remote delivery coordination.

The hosted service does not use a shared MCP token. Each `install` command creates a short-lived pairing code and a separate local device credential.

GitHub browser login identifies the dashboard user; it does not grant repository scopes. On the first governed prompt, the local Codex process reads the checkout's existing Git remote and registers the repository automatically. Repository fetch, branch, commit, and push operations continue to use the developer's local Git and Git Credential Manager setup. An administrator can enter owner/repository details in the dashboard as a fallback, but no extra GitHub login is required.

## Free-tier limitations

- The web service spins down after 15 minutes without inbound traffic and can take about one minute to wake.
- The free PostgreSQL database is limited to 1 GB and expires 30 days after creation.
- Free instances have no production availability or backup guarantee.
- Replace the free database and service plans before using this for company production data.
