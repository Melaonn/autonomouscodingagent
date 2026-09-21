# Free Render demo deployment

The repository includes a Render Blueprint that creates one free Node web service and one free PostgreSQL database in Singapore. This is suitable for an interview demonstration. Render's free web service sleeps after inactivity, and its free database expires after 30 days, so it is not a production company deployment.

## Deploy

1. Open the Blueprint deployment page for this repository and select the `codex/improve-sdlc-feedback` branch if Render asks for a branch.
2. Supply the five secret values requested by Render:
   - `LOCAL_MCP_TOKEN`: copy the value from the local `.env` file. It must be at least 32 characters.
   - `GITHUB_CLIENT_ID`: the installation-wide GitHub OAuth application client ID.
   - `GITHUB_CLIENT_SECRET`: the matching OAuth client secret.
   - `GITHUB_ALLOWED_USERS`: comma-separated GitHub logins allowed to sign in, or `*` for a public demo.
   - `GITHUB_ADMIN_USERS`: comma-separated allowed logins that receive administrator access.
3. Deploy the Blueprint and wait for `/healthz` to report healthy.
4. In the GitHub OAuth application settings, change:
   - Homepage URL to `https://<render-hostname>`
   - Authorization callback URL to `https://<render-hostname>/auth/github/callback`
5. Connect the existing local Codex installation to the hosted control plane:

   ```powershell
   .\connect-codex.ps1 -ServerUrl https://<render-hostname>
   ```

The local MCP process still inspects and edits the developer's local checkout and executes local quality gates. Render hosts only the dashboard, lifecycle state, company context, and remote delivery coordination.

## Free-tier limitations

- The web service spins down after 15 minutes without inbound traffic and can take about one minute to wake.
- The free PostgreSQL database is limited to 1 GB and expires 30 days after creation.
- Free instances have no production availability or backup guarantee.
- Replace the free database and service plans before using this for company production data.
