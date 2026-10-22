import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";

const cfg = loadConfig();
const app = await createApp(cfg);
const url = await app.start();
app.http.log.info(`Mell écoute sur ${url} (modèle : ${cfg.models.tool} via ${cfg.llm === "fake" ? "factice" : cfg.llm === "openai" ? cfg.openai.base : cfg.anthropicApiKey && /^claude-/.test(cfg.models.tool) ? "API Anthropic" : `Bedrock ${cfg.bedrockRegion}`})`);
if (cfg.vault.backend === "memory") app.http.log.warn("coffre en mémoire : les secrets sont perdus à l'arrêt (voir infra/vault/README.md)");
else app.http.log.info(`coffre : OpenBao sur ${cfg.vault.addr}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.stop();
    process.exit(0);
  });
}
