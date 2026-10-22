import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signature des échanges relais <-> serveur. Chaque ligne a son secret.
 * En-tête : `x-mella-signature: t=<secondes>,v1=<hex>` sur `${t}.${corps}`.
 * Pour un GET, le corps signé est le chemin + la query.
 */
export const SIGNATURE_HEADER = "x-mella-signature";
export const LINE_HEADER = "x-mella-line";
const MAX_SKEW_SECONDS = 300;

export function sign(secret: string, payload: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function verify(secret: string, payload: string, header: string | undefined, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > MAX_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
