// Mangatek : fonction Supabase qui interroge la BnF (et Open Library en secours) pour l'application.
// Couvertures : AbeBooks (par ISBN-13, y compris les ISBN en 979), Amazon, puis Open Library.
// Aucune clé nécessaire : le catalogue de la BnF est en accès libre.
import { createClient } from "jsr:@supabase/supabase-js@2";

const UA = "Mangatek/0.1 (catalogue de mangas personnel)";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const COVER_HOSTS = ["abebooks.com", "amazon.com", "openlibrary.org"];
// Clé d'administration : ancienne variable (SUPABASE_SERVICE_ROLE_KEY) ou nouvelles clés (SUPABASE_SECRET_KEYS).
function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return keys.default || Object.values(keys)[0] as string || "";
  } catch {
    return "";
  }
}
const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey() || "absente");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class UserError extends Error {}

async function getText(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new UserError(`Catalogue indisponible (erreur ${r.status}).`);
  return r.text();
}

// ---------- ISBN ----------
const digits = (s: string) => (s || "").replace(/[^\dX]/gi, "").toUpperCase();
function isbn13(raw: string) {
  const d = digits(raw);
  if (d.length === 13) return d;
  if (d.length !== 10) return d;
  const core = "978" + d.slice(0, 9);
  const sum = [...core].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return core + ((10 - sum % 10) % 10);
}
function isbn10(i13: string) {
  if (!i13.startsWith("978") || i13.length !== 13) return "";
  const core = i13.slice(3, 12);
  const c = (11 - [...core].reduce((s, d, i) => s + (10 - i) * Number(d), 0) % 11) % 11;
  return core + (c === 10 ? "X" : String(c));
}

// ---------- Notices BnF (format Unimarc) ----------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const clean = (s: string) => s.replace(/&(\w+);/g, (m, e) => ENT[e] ?? m)
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/[\u0088\u0089\u0098\u009c]/g, "").replace(/^["«\s]+|["»\s]+$/g, "").replace(/\s+/g, " ").trim();

type Field = Record<string, string[]>;
function fields(rec: string, tag: string): Field[] {
  const re = new RegExp(`<mxc:datafield tag="${tag}"[^>]*>([\\s\\S]*?)</mxc:datafield>`, "g");
  return [...rec.matchAll(re)].map((m) => {
    const f: Field = {};
    for (const s of m[1].matchAll(/<mxc:subfield code="(.)">([\s\S]*?)<\/mxc:subfield>/g)) (f[s[1]] ??= []).push(clean(s[2]));
    return f;
  });
}
const first = (rec: string, tag: string, code: string) => fields(rec, tag).map((f) => f[code]?.[0]).find(Boolean) || "";
const tomeNumber = (s: string) => { const m = (s || "").match(/\d+/); return m ? Number(m[0]) : null; };
const capitalize = (s: string) => s && s[0].toUpperCase() + s.slice(1);

function parseRecord(rec: string) {
  const isbnField = fields(rec, "010").find((f) => f.a?.[0]);
  const isbn = isbnField ? isbn13(isbnField.a[0]) : "";
  const priceRaw = isbnField?.d?.[0] || first(rec, "010", "d");
  const pm = priceRaw.match(/(\d+(?:[.,]\d+)?)\s*(EUR|€)/i);
  const t200 = fields(rec, "200")[0] || {};
  const t461 = fields(rec, "461")[0] || {};
  // Série et tome : « One Piece » + 56 (champ 200), sinon la série parente (champ 461).
  const h = t200.h?.[0] || "";
  const hasTome = /\d/.test(h) && !/^FRBNF/.test(h) && h.length < 12;
  let series = hasTome ? t200.a?.[0] : (t461.t?.[0] || t200.a?.[0]);
  let tome = hasTome ? tomeNumber(h) : tomeNumber(t461.v?.[0] || "");
  let title = hasTome ? (t200.i?.[0] || "") : (t461.t ? t200.a?.[0] || "" : "");
  if (!tome) {   // « Naruto - Tome 12 » écrit dans le titre
    const m = (series || "").match(/^(.*?)[\s,.:-]+(?:t(?:ome)?\.?|vol(?:ume)?\.?)\s*(\d+)\s*$/i);
    if (m) { series = m[1]; tome = Number(m[2]); }
  }
  if (title && series && title.toLowerCase() === series.toLowerCase()) title = "";
  // Auteurs : on écarte les traducteurs (code de rôle 730).
  const people = ["700", "701", "702"].flatMap((t) => fields(rec, t))
    .filter((f) => !(f["4"] || []).includes("730") && f.a)
    .map((f) => [f.b?.[0], f.a[0]].filter(Boolean).join(" "));
  const authors = [...new Set(people)].join(", ") || (t200.f?.[0] || "");
  const publisher = first(rec, "214", "c") || first(rec, "210", "c");
  const year = ((first(rec, "214", "d") || first(rec, "210", "d")).match(/\d{4}/) || [""])[0];
  return {
    isbn, series: capitalize(series || ""), tome, title, authors, publisher, year,
    priceNew: pm ? Number(pm[1].replace(",", ".")) : null, source: "bnf",
  };
}

async function bnf(query: string, max = 20) {
  const url = "https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&recordSchema=unimarcXchange" +
    `&maximumRecords=${max}&query=${encodeURIComponent(query)}`;
  const xml = await getText(url);
  return [...xml.matchAll(/<mxc:record[\s\S]*?<\/mxc:record>/g)].map((m) => parseRecord(m[0]));
}

// Couverture : AbeBooks (tous les ISBN), Amazon (ISBN-10 seulement), Open Library en secours.
async function findCover(i13: string) {
  const urls = [
    `https://pictures.abebooks.com/isbn/${i13}-us-300.jpg`,
    isbn10(i13) && `https://images-na.ssl-images-amazon.com/images/P/${isbn10(i13)}.01.LZZZZZZZ.jpg`,
    `https://covers.openlibrary.org/b/isbn/${i13}-L.jpg?default=false`,
  ].filter(Boolean) as string[];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      const buf = await r.arrayBuffer();
      if (r.ok && buf.byteLength > 2000) return url;   // Amazon renvoie une image vide de 43 octets si rien
    } catch { /* source suivante */ }
  }
  return null;
}

async function byIsbn(raw: string) {
  const i13 = isbn13(raw);
  if (i13.length !== 13) throw new UserError("Ce code ne ressemble pas à un ISBN.");
  const recs = await bnf(`bib.isbn adj "${i13}"`, 5);
  let found = recs.find((r) => r.isbn === i13) || recs[0] || null;
  if (!found) {   // Secours : Open Library
    try {
      const ol = await (await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${i13}&format=json&jscmd=data`,
        { headers: { "User-Agent": UA } })).json();
      const b = ol[`ISBN:${i13}`];
      if (b) found = { isbn: i13, series: b.title || "", tome: tomeNumber(b.subtitle || ""), title: b.subtitle || "",
        authors: (b.authors || []).map((a: any) => a.name).join(", "), publisher: b.publishers?.[0]?.name || "",
        year: ((b.publish_date || "").match(/\d{4}/) || [""])[0], priceNew: null, source: "openlibrary" };
    } catch { /* rien */ }
  }
  const cover = await findCover(i13);
  return found ? { ...found, isbn: i13, cover } : { isbn: i13, notFound: true, cover };
}

const plain = (s: string) => (s || "").normalize("NFKD").replace(/[^\w\s]/g, " ").toLowerCase();

// Recherche par titre : toute la série (jusqu'à 200 notices), sans les disques ni les livres d'un autre titre.
async function search(q: string) {
  q = q.replace(/["\\]/g, " ").trim();
  if (!q) return [];
  const m = q.match(/^(.*?)\s*(?:t(?:ome)?\.?\s*)?(\d+)$/i);
  const words = plain(m ? m[1] : q).split(/\s+/).filter(Boolean);
  const keep = (r: any) => r.isbn.length === 13 && r.series && words.every((w) => plain(`${r.series} ${r.title}`).includes(w));
  let res = (await bnf(`bib.title all "${q}"`, 50)).filter(keep);
  if (m && !res.some((r) => r.tome === Number(m[2]))) res = (await bnf(`bib.title all "${m[1]}"`, 200)).filter(keep);
  // Doublons (même ISBN) écartés, puis tri par série et tome.
  res = res.filter((r, i) => res.findIndex((x) => x.isbn === r.isbn) === i);
  if (m && res.some((r) => r.tome === Number(m[2]))) res = res.filter((r) => r.tome === Number(m[2]));
  res.sort((a, b) => a.series.localeCompare(b.series, "fr", { sensitivity: "base" }) || (a.tome ?? 0) - (b.tome ?? 0));
  return res.slice(0, 150);
}

async function setCover(userId: string, mangaId: string, url: string) {
  const host = new URL(url).hostname;
  if (!url.startsWith("https://") || !COVER_HOSTS.some((h) => host.endsWith(h))) throw new UserError("Adresse de couverture non autorisée.");
  const { data: row } = await admin.from("mangas").select("owner,data").eq("id", mangaId).single();
  if (!row || row.owner !== userId) throw new UserError("Ce manga n’est pas le tien.");
  const img = await fetch(url, { headers: { "User-Agent": UA } });
  if (!img.ok) throw new UserError("Couverture impossible à télécharger.");
  const path = `${userId}/manga-${mangaId}-${Date.now()}.jpg`;
  const up = await admin.storage.from("covers").upload(path, await img.arrayBuffer(), { contentType: "image/jpeg", upsert: true });
  if (up.error) throw new Error(up.error.message);
  const cover = admin.storage.from("covers").getPublicUrl(path).data.publicUrl;
  const data = { ...row.data, cover, coverSource: host.split(".").slice(-2)[0] };
  await admin.from("mangas").update({ data }).eq("id", mangaId);
  return data;
}

// ---------- Point d'entrée ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "Connexion requise." }, 401);
    const b = await req.json();
    switch (b.action) {
      case "isbn": return json(await byIsbn(String(b.isbn || "")));
      case "search": return json(await search(String(b.q || "")));
      case "cover": return json({ cover: await findCover(isbn13(String(b.isbn || ""))) });
      case "setCover": return json(await setCover(user.id, b.mangaId, b.url));
      default: return json({ error: "Action inconnue." }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof UserError ? e.message : "Erreur : " + (e as Error).message }, e instanceof UserError ? 400 : 500);
  }
});
