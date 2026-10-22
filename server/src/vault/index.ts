import type { Config } from "../config.ts";
import type { BrowserProvider } from "./inject.ts";
import { MemoryVault } from "./memory.ts";
import { OpenBaoVault } from "./openbao.ts";
import { VaultService } from "./service.ts";

export { VaultService } from "./service.ts";
export { MemoryVault } from "./memory.ts";
export { OpenBaoVault } from "./openbao.ts";
export type { Vault, VaultRef, LoginSecret, ConnectionSecret } from "./types.ts";
export type { FillTarget, BrowserProvider } from "./inject.ts";

export function makeVault(cfg: Config): VaultService {
  if (cfg.vault.backend === "openbao") {
    if (!cfg.vault.addr || !cfg.vault.token) throw new Error("MELLA_VAULT=openbao demande MELLA_VAULT_ADDR et MELLA_VAULT_TOKEN");
    return new VaultService(new OpenBaoVault({ addr: cfg.vault.addr, token: cfg.vault.token }));
  }
  return new VaultService(new MemoryVault());
}

/**
 * Ce dont les outils de l'agent ont besoin et que `runTool` ne reçoit pas en paramètre
 * (sa signature est partagée avec agent.ts). Posé une fois par createApp.
 */
export interface VaultRuntime {
  vault: VaultService;
  publicUrl: string;
  /** Navigateur de la tâche ; tant qu'il n'est pas branché, rien n'est tapé nulle part. */
  browser: BrowserProvider;
}

let runtime: VaultRuntime | undefined;

export function installVaultRuntime(r: VaultRuntime): void {
  runtime = r;
}

export function vaultRuntime(): VaultRuntime {
  if (!runtime) throw new Error("coffre non initialisé");
  return runtime;
}

export const noBrowser: BrowserProvider = async () => undefined;
