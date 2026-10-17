import { buildApp } from './app.js';
import { config } from './config.js';
import { startScheduler } from './sync.js';

const app = await buildApp({ logger: true });
const stop = startScheduler();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stop(); await app.close(); process.exit(0); });
await app.listen({ host: '0.0.0.0', port: config.PORT });
