# SDLC MCP for Codex

Install and connect the governed SDLC workflow to Codex with one command:

```powershell
npx -y @melson/sdlc-mcp install
```

The installer opens a short-lived GitHub pairing page, stores a device-specific credential on the local machine, adds the `sdlc` MCP server to Codex, and installs the workflow instructions. Restart Codex after installation, open an existing Git checkout, enter Plan mode, and describe the feature or bug normally.

No repository clone, `.env` file, personal access token, or shared administrator credential is required.
