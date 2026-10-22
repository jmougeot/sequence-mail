import { config } from "./config.js";
import { createServer } from "./server.js";
import { releaseAcceptedMessages } from "./services/outreach.js";
import { startScheduler } from "./services/scheduler.js";

const app = createServer();

app.listen(config.port, () => {
  console.log(`Sequence Mail running: ${config.baseUrl}`);
  if (!config.google.clientId) {
    console.warn("⚠ GOOGLE_CLIENT_ID/SECRET missing — set them in Settings (or .env) to connect accounts");
  }
  const released = releaseAcceptedMessages();
  if (released) console.log(`[linkedin] ${released} message(s) "if accepted" queued without waiting for their old delay`);
  startScheduler();
});
