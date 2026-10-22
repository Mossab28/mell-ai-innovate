import type { AppsService } from "./service.ts";

/** Comme Google : les outils n'ont pas le service en paramètre. Posé par createApp, absent sans clé Composio. */
let runtime: AppsService | undefined;

export function installAppsRuntime(a: AppsService | undefined): void {
  runtime = a;
}

export function appsRuntime(): AppsService | undefined {
  return runtime;
}
