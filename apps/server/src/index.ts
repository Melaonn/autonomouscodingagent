import { config, validateConfig } from './config.js';
import { Store } from './store.js';
import { RunService } from './run-service.js';
import { buildApi } from './api.js';
import { openSecret, sealSecret } from './security.js';
import { setRepositoryOAuth, type RepositoryOAuthCredential } from './github.js';
validateConfig();
const store = await Store.open(config.dataDir, config.databaseUrl);
await store.deleteSecret('github-token');
const storedGitHubToken = await store.secret('github-oauth-token');
if (storedGitHubToken) {
  const opened = openSecret(storedGitHubToken, config.sessionSecret);
  let credential: RepositoryOAuthCredential;
  try {
    credential = JSON.parse(opened) as RepositoryOAuthCredential;
  } catch {
    credential = { accessToken: opened };
  }
  setRepositoryOAuth(credential, (updated) =>
    store.setSecret('github-oauth-token', sealSecret(JSON.stringify(updated), config.sessionSecret)),
  );
}
const runs = new RunService(store);
const app = await buildApi(store, runs);
runs.start();
const shutdown = async () => {
  runs.stop();
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
await app.listen({ host: config.host, port: config.port });
