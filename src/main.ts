import { App } from '@slack/bolt';
import { Bridge, systemClock, type Diagnostic } from './bridge.js';
import { CodexModel } from './codex.js';
import { AppServerModel } from './app-server.js';
import { loadConfig, secretsFromEnvironment, SetupError } from './config.js';
import { doctor } from './doctor.js';
import { appOptions, slackSender, verifySlackIdentity, wireSlack } from './slack.js';
import { Store } from './store.js';

function diagnostics(): Diagnostic {
  let window = 0;
  let count = 0;
  return (reason, jobId) => {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== window) { window = minute; count = 0; }
    if (count++ >= 20) return;
    // Callers supply only fixed reason codes and generated correlation IDs.
    process.stderr.write(JSON.stringify({ reason, ...(jobId ? { job: jobId } : {}) }) + '\n');
  };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const command = process.argv[2];
  if (command !== undefined && command !== 'doctor') throw new SetupError('Usage: npm start, or npm run doctor. Configure BRIDGE_CONFIG.');
  const config = loadConfig(process.env.BRIDGE_CONFIG ?? 'bridge.config.json');
  const checks = await doctor(config);
  if (command === 'doctor') {
    for (const check of checks) process.stdout.write(`${check.ok ? 'OK' : 'MISSING'} ${check.check}: ${check.detail}\n`);
    if (checks.some(check => !check.ok)) process.exitCode = 1;
    return;
  }
  if (checks.some(check => !check.ok)) throw new SetupError('Operator setup is incomplete. Run npm run doctor for safe diagnostics.');
  const diagnostic = diagnostics();
  const store = new Store(config, Date.now());
  let app: App | undefined;
  let bridge: Bridge | undefined;
  let shuttingDown: Promise<void> | undefined;
  const shutdown = () => shuttingDown ??= (async () => {
    try { await bridge?.shutdown(); }
    finally {
      try { await app?.stop(); }
      finally { store.close(); }
    }
  })();
  try {
    app = new App(appOptions(process.env.SLACK_BOT_TOKEN!, process.env.SLACK_APP_TOKEN!, diagnostic));
    await app.init();
    await verifySlackIdentity(app, config);
    const model = config.codex.transport === 'app-server' ? new AppServerModel(config) : new CodexModel(config);
    bridge = new Bridge(config, store, model, slackSender(app), secretsFromEnvironment(config), diagnostic, systemClock, () => {
      process.exitCode = 1;
      void shutdown().catch(() => { diagnostic('shutdown_failed'); });
    });
    wireSlack(app, bridge, diagnostic);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => { void shutdown().catch(() => { diagnostic('shutdown_failed'); process.exitCode = 1; }); });
    }
    await app.start();
    if (shuttingDown) { await app.stop(); return; }
    bridge.start();
    if (!shuttingDown) diagnostic('bridge_started');
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch(error => {
  process.stderr.write((error instanceof SetupError ? error.message : 'Bridge stopped after an unexpected failure. Run doctor; raw diagnostics are suppressed.') + '\n');
  process.exitCode = 1;
});
