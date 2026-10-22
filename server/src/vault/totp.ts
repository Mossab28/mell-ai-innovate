import * as OTPAuth from "otpauth";
import { VaultError } from "./types.ts";

export interface TotpParams {
  secret: string; // base32, majuscules, sans espaces
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: 6 | 8;
  period: number;
  issuer?: string;
}

/**
 * Lit ce que l'utilisateur colle : la clé base32 affichée sous le QR code (« JBSW Y3DP EHPK 3PXP »)
 * ou l'URI complète `otpauth://totp/...`. Validation par otpauth (MIT), pas de parseur maison.
 */
export function parseTotpSeed(seed: string): TotpParams {
  const s = seed.trim();
  if (/^otpauth:\/\//i.test(s)) {
    let otp: OTPAuth.HOTP | OTPAuth.TOTP;
    try {
      otp = OTPAuth.URI.parse(s);
    } catch {
      throw new VaultError("lien otpauth illisible");
    }
    if (!(otp instanceof OTPAuth.TOTP)) throw new VaultError("seuls les codes TOTP (à durée) sont gérés");
    return {
      secret: otp.secret.base32,
      algorithm: otp.algorithm.toUpperCase() as TotpParams["algorithm"],
      digits: otp.digits === 8 ? 8 : 6,
      period: otp.period,
      issuer: otp.issuer || undefined,
    };
  }
  const b32 = s.replace(/[\s-]/g, "").toUpperCase().replace(/=+$/, "");
  if (!/^[A-Z2-7]{16,128}$/.test(b32)) throw new VaultError("clé 2FA invalide : il faut la clé en base32 affichée sous le QR code");
  return { secret: b32, algorithm: "SHA1", digits: 6, period: 30 };
}

export function generateTotp(p: TotpParams, at = Date.now()): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(p.secret), algorithm: p.algorithm, digits: p.digits, period: p.period }).generate({
    timestamp: at,
  });
}
