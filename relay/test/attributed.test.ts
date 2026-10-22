import { describe, expect, it } from "vitest";
import { decodeAttributedBody } from "../src/attributed.ts";
import { appleDateToIso } from "../src/chatdb.ts";

/** Fabrique un faux typedstream avec la structure que Messages produit autour du texte. */
function blob(text: string): Buffer {
  const t = Buffer.from(text, "utf8");
  const len = t.length < 0x80 ? Buffer.from([t.length]) : Buffer.concat([Buffer.from([0x81]), Buffer.from([t.length & 0xff, t.length >> 8])]);
  return Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08", "latin1"), Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), len, t, Buffer.from([0x86, 0x84])]);
}

describe("attributedBody", () => {
  it("lit un texte court, accentué, avec emoji", () => {
    expect(decodeAttributedBody(blob("Salut Mella ! 🎉 ça va ?"))).toBe("Salut Mella ! 🎉 ça va ?");
  });
  it("lit un texte long (longueur sur deux octets)", () => {
    const long = "a".repeat(300);
    expect(decodeAttributedBody(blob(long))).toBe(long);
  });
  it("rend undefined sur un blob vide ou sans texte", () => {
    expect(decodeAttributedBody(null)).toBeUndefined();
    expect(decodeAttributedBody(Buffer.from("rien"))).toBeUndefined();
  });
  it("convertit les dates Apple en nanosecondes", () => {
    expect(appleDateToIso(781_000_000 * 1e9)).toBe(new Date((781_000_000 + 978_307_200) * 1000).toISOString());
  });
});
