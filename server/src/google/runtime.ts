import type { GoogleService } from "./service.ts";

/** Comme le coffre : `runTool` et `userContext` n'ont pas la config en paramètre. Posé par createApp. */
let runtime: GoogleService | undefined;

export function installGoogleRuntime(g: GoogleService | undefined): void {
  runtime = g;
}

export function googleRuntime(): GoogleService | undefined {
  return runtime;
}
