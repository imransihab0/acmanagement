import type { ShopInfo } from "./receipt";

/*
  Certificate layout — landscape, one page, handed out once a trainee has
  finished every lesson allocated to them. Deliberately plain: a border, the
  shop's own mark, the trainee's name large in the middle, the lessons they
  completed, and a date. Nothing here depends on React, Convex or the DOM, the
  same reason receipt.ts doesn't — a layout only ever clicked through the app
  is a layout nobody actually checks.
*/

export type CertificateTrainee = {
  name: string;
  lessonNames: string[];
  issuedAt: number;
};

/** Minimal shape of the PDFKit document this module needs — mirrors receipt.ts's. */
type Doc = {
  page: { width: number; height: number; margins: { top: number; bottom: number; left: number; right: number } };
  y: number;
  font(name: string): Doc;
  fontSize(size: number): Doc;
  fillColor(color: string): Doc;
  strokeColor(color: string): Doc;
  lineWidth(w: number): Doc;
  text(text: string, x?: number, y?: number, options?: Record<string, unknown>): Doc;
  moveTo(x: number, y: number): Doc;
  lineTo(x: number, y: number): Doc;
  stroke(color?: string): Doc;
  rect(x: number, y: number, w: number, h: number): Doc;
  fill(color?: string): Doc;
  heightOfString(text: string, options?: Record<string, unknown>): number;
  widthOfString(text: string, options?: Record<string, unknown>): number;
  image(src: unknown, x?: number, y?: number, options?: Record<string, unknown>): Doc;
};

const REGULAR = "bn";
const BOLD = "bnb";

const GREEN_DEEP = "#2e6b38";
const GREEN = "#3e8548";
const GREEN_LEAF = "#8dc07a";
const CORAL = "#ee6c60";
const INK = "#1f2a24";
const MUTED = "#6b7b70";
const PAPER = "#ffffff";

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}

export function drawCertificate(doc: Doc, trainee: CertificateTrainee, shop: ShopInfo) {
  const { width, height } = doc.page;
  const margin = 36;

  doc.rect(0, 0, width, height).fill(PAPER);

  // Outer and inner borders, the leaf green between them.
  doc
    .lineWidth(2)
    .strokeColor(GREEN_DEEP)
    .rect(margin, margin, width - margin * 2, height - margin * 2)
    .stroke();
  doc
    .lineWidth(0.75)
    .strokeColor(GREEN_LEAF)
    .rect(margin + 8, margin + 8, width - (margin + 8) * 2, height - (margin + 8) * 2)
    .stroke();

  let y = margin + 42;

  if (shop.logo) {
    const logoW = 96;
    const logoH = logoW * (shop.logoAspect ?? 1);
    doc.image(shop.logo, (width - logoW) / 2, y, { width: logoW });
    y += logoH + 18;
  }

  doc
    .font(BOLD)
    .fontSize(26)
    .fillColor(GREEN_DEEP)
    .text("Certificate of Completion", margin, y, { width: width - margin * 2, align: "center" });
  y += 38;

  doc
    .font(REGULAR)
    .fontSize(12)
    .fillColor(MUTED)
    .text("This is to certify that", margin, y, { width: width - margin * 2, align: "center" });
  y += 30;

  doc
    .font(BOLD)
    .fontSize(30)
    .fillColor(INK)
    .text(trainee.name, margin, y, { width: width - margin * 2, align: "center" });
  y += 42;

  // A short rule under the name, centred, the same width whatever the name's length.
  const ruleWidth = 220;
  doc
    .moveTo((width - ruleWidth) / 2, y)
    .lineTo((width + ruleWidth) / 2, y)
    .lineWidth(1)
    .strokeColor(CORAL)
    .stroke();
  y += 22;

  doc
    .font(REGULAR)
    .fontSize(12)
    .fillColor(MUTED)
    .text("has successfully completed training at BD Mushroom, covering:", margin, y, {
      width: width - margin * 2,
      align: "center",
    });
  y += 26;

  const lessonsText = trainee.lessonNames.join("  •  ");
  doc
    .font(BOLD)
    .fontSize(13)
    .fillColor(GREEN)
    .text(lessonsText, margin + 60, y, { width: width - (margin + 60) * 2, align: "center" });
  y += doc.heightOfString(lessonsText, { width: width - (margin + 60) * 2, align: "center" }) + 34;

  const footerY = height - margin - 70;
  doc
    .font(REGULAR)
    .fontSize(11)
    .fillColor(MUTED)
    .text(`Issued ${fmtDate(trainee.issuedAt)}`, margin + 50, footerY, { width: 220, align: "left" });

  if (shop.seal) {
    const sealW = 60;
    const sealH = sealW * (shop.sealAspect ?? 1);
    doc.image(shop.seal, width - margin - 50 - sealW, footerY - (sealH - 20) / 2, { width: sealW });
  }
  doc
    .font(BOLD)
    .fontSize(12)
    .fillColor(INK)
    .text(shop.name, width - margin - 50 - 140, footerY + 36, { width: 140, align: "center" });
  doc
    .moveTo(width - margin - 50 - 140, footerY + 32)
    .lineTo(width - margin - 50, footerY + 32)
    .lineWidth(0.75)
    .strokeColor(MUTED)
    .stroke();
}
