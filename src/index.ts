import { config } from "./config.js";
import { createServer } from "./server.js";
import { startScheduler } from "./services/scheduler.js";

const app = createServer();

app.listen(config.port, () => {
  console.log(`Sequence Mail démarré : ${config.baseUrl}`);
  if (!config.google.clientId) {
    console.warn("⚠ GOOGLE_CLIENT_ID/SECRET manquants — à renseigner dans Paramètres (ou .env) pour connecter des comptes");
  }
  startScheduler();
});
