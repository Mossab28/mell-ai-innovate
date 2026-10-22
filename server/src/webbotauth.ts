import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";

/**
 * Web Bot Auth (RFC 9421 + brouillon Cloudflare « http-message-signatures-directory ») : Mell se présente aux
 * sites au lieu de se cacher. Chaque requête de son navigateur (et ses lectures de pages) porte une signature
 * Ed25519 sur l'hôte visé ; la clé publique est publiée sur askmell.com/.well-known/http-message-signatures-directory
 * et le site décide. Clé = graine Ed25519 de 32 octets en base64url dans MELLA_WBA_KEY (mell.env) ; absente, rien n'est signé.
 */

const AGENT = (publicUrl: string) => new URL(publicUrl).origin;

export interface WebBotAuth {
  /** L'annuaire de clés, signé, à servir sur /.well-known/http-message-signatures-directory. */
  directory(host: string): { body: string; headers: Record<string, string> };
  /** Les en-têtes à poser sur une requête vers `authority` (hôte[:port]). Mis en cache 50 s par hôte. */
  headersFor(authority: string): Record<string, string>;
  readonly agent: string;
  readonly keyId: string;
}

const b64u = (b: Buffer) => b.toString("base64url");

export function makeWebBotAuth(seedB64u: string | undefined, publicUrl: string): WebBotAuth | undefined {
  if (!seedB64u) return undefined;
  const seed = Buffer.from(seedB64u, "base64url");
  if (seed.length !== 32) throw new Error("MELLA_WBA_KEY : graine Ed25519 de 32 octets attendue (base64url)");
  // PKCS#8 d'une clé Ed25519 = en-tête fixe + graine.
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  const jwk = { kty: "OKP", crv: "Ed25519", x: pub.x };
  // Empreinte JWK (RFC 7638, membres dans l'ordre lexicographique, sans espace).
  const keyId = b64u(createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest());
  const agent = AGENT(publicUrl);
  const cache = new Map<string, { until: number; headers: Record<string, string> }>();

  const signBase = (components: Array<[string, string]>, params: string) => {
    const lines = components.map(([k, v]) => `"${k}": ${v}`);
    lines.push(`"@signature-params": ${params}`);
    return sign(null, Buffer.from(lines.join("\n"), "utf8"), priv);
  };

  return {
    agent,
    keyId,
    directory(host) {
      const now = Math.floor(Date.now() / 1000);
      const params = `("@authority");created=${now};expires=${now + 3600};keyid="${keyId}";alg="ed25519";tag="http-message-signatures-directory"`;
      const sig = signBase([["@authority", host]], params);
      return {
        body: JSON.stringify({ keys: [jwk] }),
        headers: {
          "content-type": "application/http-message-signatures-directory+json",
          "cache-control": "public, max-age=3600",
          "signature-input": `sig1=${params}`,
          signature: `sig1=:${sig.toString("base64")}:`,
        },
      };
    },
    headersFor(authority) {
      const hit = cache.get(authority);
      if (hit && hit.until > Date.now()) return hit.headers;
      const now = Math.floor(Date.now() / 1000);
      const agentHeader = `"${agent}"`;
      const params = `("@authority" "signature-agent");created=${now};expires=${now + 60};keyid="${keyId}";alg="ed25519";nonce="${b64u(randomBytes(12))}";tag="web-bot-auth"`;
      const sig = signBase([["@authority", authority], ["signature-agent", agentHeader]], params);
      const headers = { "Signature-Agent": agentHeader, "Signature-Input": `sig2=${params}`, Signature: `sig2=:${sig.toString("base64")}:` };
      cache.set(authority, { until: Date.now() + 50_000, headers });
      return headers;
    },
  };
}

// ---- Posé une fois au démarrage, lu par le navigateur et les lectures de pages -------------------
let runtime: WebBotAuth | undefined;
export function installWebBotAuth(w: WebBotAuth | undefined): void {
  runtime = w;
}
export function webBotAuth(): WebBotAuth | undefined {
  return runtime;
}
