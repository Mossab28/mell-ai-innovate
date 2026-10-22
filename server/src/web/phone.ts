import { esc } from "./da.ts";

/** Indicatifs proposés dans les formulaires : drapeau, indicatif, nom. La France d'abord. */
export const COUNTRIES: Array<[string, string, string]> = [
  ["33", "🇫🇷", "France"],
  ["32", "🇧🇪", "Belgique"],
  ["41", "🇨🇭", "Suisse"],
  ["352", "🇱🇺", "Luxembourg"],
  ["49", "🇩🇪", "Deutschland"],
  ["34", "🇪🇸", "España"],
  ["39", "🇮🇹", "Italia"],
  ["351", "🇵🇹", "Portugal"],
  ["31", "🇳🇱", "Nederland"],
  ["44", "🇬🇧", "United Kingdom"],
  ["353", "🇮🇪", "Ireland"],
  ["1", "🇺🇸", "United States / Canada"],
  ["43", "🇦🇹", "Österreich"],
  ["45", "🇩🇰", "Danmark"],
  ["46", "🇸🇪", "Sverige"],
  ["47", "🇳🇴", "Norge"],
  ["358", "🇫🇮", "Suomi"],
  ["48", "🇵🇱", "Polska"],
  ["420", "🇨🇿", "Česko"],
  ["30", "🇬🇷", "Ελλάδα"],
  ["90", "🇹🇷", "Türkiye"],
  ["212", "🇲🇦", "Maroc"],
  ["213", "🇩🇿", "Algérie"],
  ["216", "🇹🇳", "Tunisie"],
  ["221", "🇸🇳", "Sénégal"],
  ["225", "🇨🇮", "Côte d'Ivoire"],
  ["971", "🇦🇪", "United Arab Emirates"],
  ["972", "🇮🇱", "Israel"],
  ["91", "🇮🇳", "India"],
  ["81", "🇯🇵", "Japan"],
  ["82", "🇰🇷", "Korea"],
  ["65", "🇸🇬", "Singapore"],
  ["61", "🇦🇺", "Australia"],
  ["64", "🇳🇿", "New Zealand"],
  ["55", "🇧🇷", "Brasil"],
  ["52", "🇲🇽", "México"],
];

/** Indicatif + numéro national tapé librement -> E.164, ou undefined. */
export function composePhone(cc: string, national: string): string | undefined {
  if (!COUNTRIES.some(([c]) => c === cc)) return undefined;
  let n = national.replace(/\D/g, "");
  if (n.startsWith(cc) && n.length > 10) n = n.slice(cc.length);
  if (cc !== "39" && n.startsWith("0")) n = n.replace(/^0+/, "");
  const full = `${cc}${n}`;
  return n.length >= 6 && full.length <= 15 ? `+${full}` : undefined;
}

/** Le sélecteur de pays, drapeau et indicatif, puis le numéro. */
export function phoneRow(cc: string, label: string, placeholder: string, value = ""): string {
  const opts = COUNTRIES.map(([c, flag, name]) => `<option value="${c}" title="${esc(name)}"${c === cc ? " selected" : ""}>${flag} +${c}</option>`).join("");
  return `<label for="phone">${esc(label)}</label><div class="phone"><select name="cc" aria-label="Country">${opts}</select><input id="phone" name="phone" type="tel" value="${esc(value)}" inputmode="tel" autocomplete="tel-national" placeholder="${esc(placeholder)}" required></div>`;
}

