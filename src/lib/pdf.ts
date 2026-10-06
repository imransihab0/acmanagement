import { drawReceipt, type ReceiptOrder, type ShopInfo } from "./receipt";
import { drawCertificate, type CertificateTrainee } from "./certificate";

/*
  Receipt PDF generation, in the browser.

  PDFKit and the two Bengali fonts together are around 1.5MB, which has no
  business being in the initial bundle for a feature used a few times a day.
  Everything here is imported on first use and then cached.

  The fonts are Hind Siliguri rather than the interface font: Noto Sans
  Bengali declares its Bengali features only under the 'bng2' script tag,
  which fontkit never looks for, so conjuncts come out decomposed. Hind
  Siliguri declares both tags and shapes correctly.
*/

export const SHOP: ShopInfo = {
  name: "BD Mushroom",
  tagline: "মাশরুম ও চাষের সরঞ্জাম",
  website: "bdmushroom.com",
  logoAspect: 357 / 476,
  sealAspect: 292 / 476,
};

let fontCache: { regular: ArrayBuffer; bold: ArrayBuffer } | null = null;
let brandCache: { logo?: Uint8Array; seal?: Uint8Array } | null = null;

/*
  A receipt needs ~1.5MB of font and code fetched on first use — the exact
  moment a shaky mobile connection is most likely to drop one request. Most
  of what shows up as "something went wrong" here is that, not a real bug,
  so a failed fetch gets a few seconds to recover before it is allowed to
  fail the whole receipt.
*/
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

/** A fetch that gives up after a while instead of hanging on a dead connection. */
function fetchWithTimeout(url: string, ms = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function loadFonts() {
  if (fontCache) return fontCache;
  const [regular, bold] = await Promise.all([
    withRetry(() =>
      fetchWithTimeout("/fonts/HindSiliguri-Regular.ttf").then((r) => {
        if (!r.ok) throw new Error("Could not load the receipt font.");
        return r.arrayBuffer();
      }),
    ),
    withRetry(() =>
      fetchWithTimeout("/fonts/HindSiliguri-Bold.ttf").then((r) => {
        if (!r.ok) throw new Error("Could not load the receipt font.");
        return r.arrayBuffer();
      }),
    ),
  ]);
  fontCache = { regular, bold };
  return fontCache;
}

/*
  The artwork is a nicety, not a requirement: if it cannot be fetched —
  offline, or a file moved — the receipt loses its letterhead and seal rather
  than failing the download the shopkeeper actually asked for. The result is
  cached either way, so a missing file is not re-fetched on every receipt.
*/
async function loadArtwork(path: string) {
  try {
    return await withRetry(async () => {
      const res = await fetchWithTimeout(path);
      if (!res.ok) throw new Error(String(res.status));
      return new Uint8Array(await res.arrayBuffer());
    });
  } catch {
    return undefined;
  }
}

async function loadBrand() {
  if (brandCache) return brandCache;
  const [logo, seal] = await Promise.all([
    loadArtwork("/brand/bdmushroom.png"),
    loadArtwork("/brand/bdmushroom-seal.png"),
  ]);
  brandCache = { logo, seal };
  return brandCache;
}

async function buildDoc(orders: ReceiptOrder[], shop: ShopInfo, bengali: boolean) {
  const [pdfkit, fonts, brand] = await Promise.all([
    withRetry(() => import("pdfkit")),
    loadFonts(),
    loadBrand(),
  ]);
  const PDFDocument = pdfkit.default;

  /*
    `font: null` stops the constructor reaching for Helvetica. The browser
    build ships no standard fonts, so the default would throw before a single
    line was drawn. Null rather than undefined matters: PDFKit's default
    parameter only applies to undefined.
  */
  const doc = new PDFDocument({
    size: "A4",
    margin: 44,
    autoFirstPage: false,
    font: null,
  } as never);

  // PDFKit wants a Buffer-like value; a Uint8Array over the same bytes works
  // in the browser build and avoids pulling in a Buffer polyfill.
  doc.registerFont("bn", new Uint8Array(fonts.regular) as never);
  doc.registerFont("bnb", new Uint8Array(fonts.bold) as never);

  /*
    Collect the document's own chunks rather than piping into blob-stream:
    that package is a Node stream shim and throws "util.inherits is not a
    function" in the browser. PDFKit's document is already a readable stream,
    so there is nothing to shim.
  */
  const chunks: BlobPart[] = [];
  const stream = doc as unknown as {
    on(event: "data" | "end" | "error", handler: (chunk?: unknown) => void): void;
  };

  const done = new Promise<Blob>((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk as BlobPart));
    stream.on("end", () => resolve(new Blob(chunks, { type: "application/pdf" })));
    stream.on("error", (err) => reject(err));
  });

  const branded: ShopInfo = { ...shop, logo: shop.logo ?? brand.logo, seal: shop.seal ?? brand.seal };
  orders.forEach((order) => {
    doc.addPage();
    drawReceipt(doc as never, order, branded, { bengali });
  });
  doc.end();

  return done;
}

async function buildCertificateDoc(trainee: CertificateTrainee, shop: ShopInfo) {
  const [pdfkit, fonts, brand] = await Promise.all([
    withRetry(() => import("pdfkit")),
    loadFonts(),
    loadBrand(),
  ]);
  const PDFDocument = pdfkit.default;

  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 0,
    font: null,
  } as never);

  doc.registerFont("bn", new Uint8Array(fonts.regular) as never);
  doc.registerFont("bnb", new Uint8Array(fonts.bold) as never);

  const chunks: BlobPart[] = [];
  const stream = doc as unknown as {
    on(event: "data" | "end" | "error", handler: (chunk?: unknown) => void): void;
  };
  const done = new Promise<Blob>((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk as BlobPart));
    stream.on("end", () => resolve(new Blob(chunks, { type: "application/pdf" })));
    stream.on("error", (err) => reject(err));
  });

  const branded: ShopInfo = { ...shop, logo: shop.logo ?? brand.logo, seal: shop.seal ?? brand.seal };
  drawCertificate(doc as never, trainee, branded);
  doc.end();

  return done;
}

/** A completion certificate for one trainee — opens in a new tab to view or print. */
export async function previewCertificate(trainee: CertificateTrainee, options: { shop?: ShopInfo } = {}) {
  const blob = await buildCertificateDoc(trainee, options.shop ?? SHOP);
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Saves the certificate as a file instead of opening it. */
export async function downloadCertificate(trainee: CertificateTrainee, options: { shop?: ShopInfo } = {}) {
  const blob = await buildCertificateDoc(trainee, options.shop ?? SHOP);
  save(blob, `${trainee.name.replace(/\s+/g, "-")}-certificate.pdf`);
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One receipt, one file. */
export async function downloadReceipt(
  order: ReceiptOrder,
  options: { shop?: ShopInfo; bengali?: boolean } = {},
) {
  const blob = await buildDoc([order], options.shop ?? SHOP, options.bengali ?? true);
  save(blob, `${order.orderNo}.pdf`);
}

/**
 * Many receipts in one file, one page each.
 *
 * The spec asks for a separate PDF per order from a bulk upload. Browsers
 * throttle or block a burst of individual downloads, so this returns a single
 * file of one-page receipts by default; `separate` forces true one-file-per-
 * order for smaller batches.
 */
export async function downloadReceipts(
  orders: ReceiptOrder[],
  options: { shop?: ShopInfo; bengali?: boolean; separate?: boolean } = {},
) {
  const shop = options.shop ?? SHOP;
  const bengali = options.bengali ?? true;
  if (orders.length === 0) return;

  if (options.separate) {
    for (const order of orders) {
      const blob = await buildDoc([order], shop, bengali);
      save(blob, `${order.orderNo}.pdf`);
      // Space the saves out so the browser does not treat them as a burst.
      await new Promise((r) => setTimeout(r, 350));
    }
    return;
  }

  const blob = await buildDoc(orders, shop, bengali);
  const stamp = new Date().toISOString().slice(0, 10);
  save(blob, `receipts-${stamp}.pdf`);
}

/** Opens the receipt in a new tab instead of saving it, for a quick look. */
export async function previewReceipt(
  order: ReceiptOrder,
  options: { shop?: ShopInfo; bengali?: boolean } = {},
) {
  const blob = await buildDoc([order], options.shop ?? SHOP, options.bengali ?? true);
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/*
  Warms the font/code cache in the background once the app is idle, so the
  first real "Receipt PDF" tap of the day finds everything already in memory
  instead of racing a fetch against whatever the connection is doing right
  then. Best-effort: a failure here is silent and changes nothing — the
  retry logic above still runs for real when the shopkeeper actually asks.
*/
export function prefetchReceiptAssets() {
  const run = () => {
    void Promise.all([import("pdfkit"), loadFonts(), loadBrand()]).catch(() => {});
  };
  if ("requestIdleCallback" in window) {
    (window as typeof window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(run);
  } else {
    setTimeout(run, 2000);
  }
}
