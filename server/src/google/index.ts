import type { Config } from "../config.ts";
import type { VaultService } from "../vault/service.ts";
import { GoogleService } from "./service.ts";

export { GoogleService, GoogleError, type GoogleConnection } from "./service.ts";
export { SCOPES, servicesOf } from "./oauth.ts";
export { GOOGLE_TOOL_SPECS, runGoogleTool } from "./tools.ts";
export { GOOGLE_GUIDE, googleContext } from "./prompt.ts";
export { registerGoogleRoutes } from "./web.ts";
export { installGoogleRuntime, googleRuntime } from "./runtime.ts";

export function makeGoogle(cfg: Config, vault: VaultService, log?: (msg: string, err?: unknown) => void): GoogleService {
  return new GoogleService({
    endpoints: cfg.google.endpoints,
    publicUrl: cfg.publicUrl,
    redirectBase: cfg.google.redirectBase,
    clientId: cfg.google.clientId,
    clientSecret: cfg.google.clientSecret,
    vault,
    log,
  });
}
