import { config } from "./config.js";
import { createServer } from "./server.js";
import { consolidateProfiles } from "./services/li-consolidate.js";
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

  // One LinkedIn account per profile: a dashboard account and an owner's on the same profile are merged.
  const consolidate = () => {
    try {
      for (const m of consolidateProfiles().merged) {
        console.log(`[linkedin] #${m.from.id} ${m.from.name} merged into #${m.into.id} ${m.into.name} (profile ${m.profile})`);
      }
    } catch (err) {
      console.error("[linkedin] account merge:", err instanceof Error ? err.message : err);
    }
  };
  consolidate();
  setInterval(consolidate, 5 * 60_000).unref();
});
