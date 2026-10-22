import type { Db } from "../db.ts";
import type { Config } from "../config.ts";
import type { EmailClient } from "@azure/communication-email";

/** Comme Google : `runTool` et `userContext` n'ont pas la config en paramètre. Posé par createApp, absent sans domaine. */
export interface MailRuntime { db: Db; cfg: Config; emailClient?: EmailClient }
let runtime: MailRuntime | undefined;

export function installMailRuntime(r: MailRuntime | undefined): void {
  runtime = r;
}

export function mailRuntime(): MailRuntime | undefined {
  return runtime;
}
