import cronParser from "cron-parser";

/** Décalage (ms) du fuseau `tz` à l'instant `at` : heure locale moins UTC. */
function offsetMs(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Convertit une heure locale sans fuseau (`2026-10-14T18:30`) lue dans `tz` en instant UTC.
 * Une chaîne qui porte déjà un fuseau (`Z`, `+02:00`) est prise telle quelle.
 */
export function zonedToUtc(local: string, tz: string): Date {
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(local)) return new Date(local);
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`heure locale illisible : ${local}`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  // Deux passes pour tomber juste autour des changements d'heure.
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

/** Affichage local lisible pour le modèle et pour l'utilisateur. */
export function formatLocal(at: Date, tz: string, lang = "fr"): string {
  return new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-US", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Prochaine occurrence strictement après `after` d'une expression cron lue dans `tz`. */
export function nextCron(expr: string, tz: string, after: Date): Date {
  const it = cronParser.parseExpression(expr, { currentDate: after, tz });
  return it.next().toDate();
}
