/**
 * Depuis macOS Ventura, Messages laisse souvent la colonne `text` vide et range le texte dans
 * `attributedBody`, un NSAttributedString archivé au format typedstream. On n'a pas besoin de
 * tout décoder : la chaîne suit le marqueur « NSString », précédée de sa longueur.
 *
 * Après « NSString » viennent 5 octets de structure (01 94 84 01 2B), puis la longueur :
 * un octet si < 0x80 ; 0x81 puis 2 octets little-endian ; 0x82 puis 4 octets little-endian.
 */
export function decodeAttributedBody(buf: Uint8Array | Buffer | null | undefined): string | undefined {
  if (!buf || !buf.length) return undefined;
  const b = Buffer.from(buf);
  const marker = b.indexOf("NSString");
  if (marker < 0) return undefined;
  let p = marker + "NSString".length + 5;
  if (p >= b.length) return undefined;
  let len = b[p++];
  if (len === 0x81) {
    len = b.readUInt16LE(p);
    p += 2;
  } else if (len === 0x82) {
    len = b.readUInt32LE(p);
    p += 4;
  }
  if (len <= 0 || p + len > b.length) return undefined;
  return b.subarray(p, p + len).toString("utf8");
}
