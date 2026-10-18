import { config } from "./config.js";
import { createServer } from "./server.js";
import { startScheduler } from "./services/scheduler.js";

const app = createServer();

app.listen(config.port, () => {
  console.log(`Sequence Mail running: ${config.baseUrl}`);
  if (!config.google.clientId) {
    console.warn("⚠ GOOGLE_CLIENT_ID/SECRET missing — set them in Settings (or .env) to connect accounts");
  }
  startScheduler();
});
