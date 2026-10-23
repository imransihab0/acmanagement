import { Camera, Layers, Package, Pencil, Receipt, Trash2, TrendingUp, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge, Modal, cx } from "./ui";
import { BatchDialog, type BatchInput } from "./BatchDialog";
import { LotRemoveDialog } from "./LotRemoveDialog";
import { LotDetailDialog } from "./LotDetailDialog";
import { VendorDetailDialog } from "./VendorDetailDialog";
import { CategoryBreadcrumb } from "./CategoryBreadcrumb";
import { useSettings } from "../lib/settings";
import { useT } from "../lib/i18n";
import { gradientFor } from "../lib/avatar";
import { errorMessage, useToast } from "../lib/toast";
import { useAuthedAction, useAuthedMutation, useAuthedQuery } from "../lib/session";
import { uploadFileToR2, useFileDrop, useUploadProgress } from "../lib/upload";

type ProductWithPhoto = Doc<"products"> & { photoUrl?: string | null };

/**
 * The product's photo, shown where the dialog header would otherwise put a
 * plain icon — click or drop a file directly on it to set one. Living here
 * instead of only in the edit form means a photo can be added the moment you
 * notice it is missing, without a detour through "Edit product".
 */
function ProductPhotoAvatar({ product }: { product: ProductWithPhoto }) {
  const t = useT();
  const toast = useToast();
  const generateR2UploadUrl = useAuthedAction(api.r2.generateUploadUrl);
  const setPhoto = useAuthedMutation(api.products.setPhoto);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(product.photoUrl ?? null);
  const [busy, setBusy] = useState(false);
  const uploadStatus = useUploadProgress();

  useEffect(() => {
    setPreview(product.photoUrl ?? null);
  }, [product._id, product.photoUrl]);

  async function pickPhoto(file: File) {
    setPreview(URL.createObjectURL(file));
    setBusy(true);
    try {
      const { publicUrl } = await uploadFileToR2(generateR2UploadUrl, file, "products");
      await setPhoto({ id: product._id, photoUrl: publicUrl });
      setPreview(publicUrl);
      toast.ok(t("products.photoUpdated"));
    } catch (err) {
      toast.error(errorMessage(err));
      setPreview(product.photoUrl ?? null);
    } finally {
      setBusy(false);
    }
  }

  const { dragOver, dropProps } = useFileDrop((file) => void pickPhoto(file));

  return (
    <div
      {...dropProps}
      role="button"
      tabIndex={0}
      aria-label={product.photoUrl ? t("products.changePhoto") : t("products.uploadPhoto")}
      onClick={() => fileInputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fileInputRef.current?.click();
        }
      }}
      className={cx(
        "relative flex size-11 cursor-pointer items-center justify-center",
        dragOver && "ring-2 ring-white/70",
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void pickPhoto(file);
        }}
      />
      {preview ? (
        <img src={preview} alt="" className="size-11 object-cover" />
      ) : (
        <Camera size={19} aria-hidden />
      )}
      {busy && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink/70 rounded-full text-white text-[10px] font-bold">
          {uploadStatus ? `${uploadStatus.progress}%` : <div className="ac-skeleton size-4 rounded-full" aria-hidden />}
        </div>
      )}
    </div>
  );
}

/*
  A stored lot, as the form wants it. The detail query hands back the raw
  rows; the dialog asks for its own shape so it cannot be handed a product or
  a sale by mistake.
*/
function toBatchInput(lot: Doc<"stockBatches">): BatchInput {
  return {
    id: lot._id,
    productId: lot.productId,
    productName: lot.productName,
    label: lot.label,
    purchasedAt: lot.purchasedAt,
    quantity: lot.quantity,
    unitCost: lot.unitCost,
    unitPrice: lot.unitPrice,
    remaining: lot.remaining,
    note: lot.note,
    vendorId: lot.vendorId,
  };
}

/**
 * Everything about one product in one place: stock, its lots, and the sales
 * it has actually produced. Without this, answering "how has this done" meant
 * scanning the whole ledger by eye for one name.
 */
export function ProductDetailDialog({
  open,
  onClose,
  productId,
}: {
  open: boolean;
  onClose: () => void;
  productId: Id<"products"> | null;
}) {
  const { fmt, fmtNum, fmtPercent, fmtDateFull, fmtDateTime } = useSettings();
  const t = useT();
  const data = useAuthedQuery(api.products.detail, productId ? { id: productId } : "skip");
  // Lots with nothing left — sold out or taken off — stay out of the way.
  const [showFinished, setShowFinished] = useState(false);
  const [editingLot, setEditingLot] = useState<BatchInput | null>(null);
  const [deletingLot, setDeletingLot] = useState<BatchInput | null>(null);
  const [viewingLot, setViewingLot] = useState<Id<"stockBatches"> | null>(null);
  const [viewingVendor, setViewingVendor] = useState<Id<"vendors"> | null>(null);

  const name = data?.product.name ?? "";

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={data?.product ? <ProductPhotoAvatar product={data.product} /> : <Package size={19} />}
      iconInteractive={Boolean(data?.product)}
      gradient={name ? gradientFor(name) : undefined}
      title={name || t("detail.title")}
      subtitle={
        data?.product.category ? (
          <CategoryBreadcrumb
            category={data.product.category}
            subCategory={data.product.subCategory}
          />
        ) : undefined
      }
      width="sm:max-w-2xl"
    >
      {!data ? (
        <div className="ac-skeleton h-64 bg-surface" aria-hidden />
      ) : (
        <div className="flex flex-col gap-6 px-6 py-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={t("sales.profit")}
              value={fmt(data.totals.profit)}
              hint={
                data.totals.revenue > 0 ? `${fmtPercent(data.totals.margin)} ${t("dash.margin")}` : undefined
              }
              icon={<TrendingUp size={14} />}
              tone="good"
            />
            <Stat
              label={t("sales.revenue")}
              value={fmt(data.totals.revenue)}
              hint={`${fmtNum(data.totals.salesCount)} · ${t("nav.sales").toLowerCase()}`}
              icon={<Receipt size={14} />}
            />
            <Stat
              label={t("dash.availableStock")}
              value={`${fmtNum(data.product.quantity)}`}
              hint={`${fmtNum(data.totals.unitsSold)} ${t("detail.unitsSold").toLowerCase()}`}
              icon={<Layers size={14} />}
            />
            <Stat
              label={t("detail.lastPrice")}
              value={data.totals.lastPrice === null ? "—" : fmt(data.totals.lastPrice)}
              hint={
                data.totals.lastSoldAt === null
                  ? t("detail.never")
                  : fmtDateFull(data.totals.lastSoldAt)
              }
              icon={<Wallet size={14} />}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface-2/40 px-4 py-3 text-[13px]">
            <span className="text-ink-3">
              Buy price: <strong className="text-ink font-semibold">{fmt(data.product.costPrice)}</strong>
            </span>
            <span className="text-line-strong">•</span>
            <span className="text-ink-3">
              {t("products.sellPrice")}: <strong className="text-ink font-semibold">{data.product.sellPrice !== undefined ? fmt(data.product.sellPrice) : "—"}</strong>
            </span>
          </div>

          {data.product.details && (
            <div className="rounded-2xl border border-line bg-page p-4">
              <p className="text-[13px] leading-6 whitespace-pre-wrap text-ink-2">
                {data.product.details}
              </p>
            </div>
          )}

          {/*
            Lots are bought against a product, so the place to keep them is
            the product — adding, correcting and dropping one alike. Sending
            the shopkeeper to the Profit page to fix a lot they just recorded
            here makes the connection something to remember rather than see.
          */}
          <div>
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <p className="text-[10.5px] font-bold tracking-[0.09em] text-ink-3 uppercase">
                {t("detail.stockLots")}
              </p>
            </div>
            {data.lots.length === 0 ? (
              <p className="text-[13px] text-ink-3">{t("detail.noLots")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.lots
                  .filter((l) => showFinished || (l.remaining ?? l.quantity) > 0)
                  .map((l) => {
                  // Nothing to show a margin from until a price is decided.
                  const unitProfit = l.unitPrice !== undefined ? l.unitPrice - l.unitCost : null;
                  // A lot taken off was never sold out, so it has no margin to show.
                  const showProfit = !l.removedAt;
                  const lot = toBatchInput(l);
                  return (
                    <li
                      key={l._id}
                      onClick={() => setViewingLot(l._id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") setViewingLot(l._id);
                      }}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-page px-3.5 py-2.5 transition-colors hover:bg-surface-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge tone="accent">{l.label}</Badge>
                          {l.removedAt ? (
                            <Badge tone="critical">Removed</Badge>
                          ) : (
                            (l.remaining ?? l.quantity) === 0 && <Badge tone="neutral">Sold out</Badge>
                          )}
                          <span className="text-[12px] text-ink-3">{fmtDateFull(l.purchasedAt)}</span>
                        </div>
                        {/* What is left matters more than what was bought: it
                            is the number you sell against. */}
                        <p className="mt-1 text-[12.5px] text-ink-3">
                          {fmtNum(l.remaining ?? l.quantity)} {t("detail.leftOf")}{" "}
                          {fmtNum(l.quantity)} · {fmt(l.unitCost)} →{" "}
                          {l.unitPrice !== undefined ? fmt(l.unitPrice) : t("detail.priceOpen")}
                        </p>
                        {l.note && <p className="mt-1 text-[12px] text-ink-3">{l.note}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!showProfit ? null : unitProfit === null ? (
                          <span className="px-1 text-[12.5px] text-ink-3">
                            {t("detail.priceOpen")}
                          </span>
                        ) : (
                          <span
                            className={cx(
                              "px-1 text-[14px] font-bold tabular-nums",
                              unitProfit < 0 ? "text-critical-ink" : "text-good-ink",
                            )}
                          >
                            {fmt(unitProfit * l.quantity)}
                          </span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingLot(lot);
                          }}
                          aria-label={`${t("detail.editLot")} — ${l.label}`}
                          title={t("detail.editLot")}
                          className="rounded-lg p-2 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                        >
                          <Pencil size={14} />
                        </button>
                        {!l.removedAt && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeletingLot(lot);
                          }}
                          aria-label={`${t("detail.deleteLot")} — ${l.label}`}
                          title={t("detail.deleteLot")}
                          className="rounded-lg p-2 text-ink-3 transition-colors hover:bg-surface-2 hover:text-critical"
                        >
                          <Trash2 size={14} />
                        </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {data.lots.some((l) => (l.remaining ?? l.quantity) === 0) && (
              <button
                onClick={() => setShowFinished((v) => !v)}
                className="mt-2 text-[12px] font-semibold text-accent hover:underline"
              >
                {showFinished
                  ? "Hide finished lots"
                  : `Show finished lots (${data.lots.filter((l) => (l.remaining ?? l.quantity) === 0).length})`}
              </button>
            )}
          </div>

          <Section
            title={t("detail.salesHistory")}
            empty={data.sales.length === 0}
            emptyText={t("detail.noSales")}
          >
            <ul className="flex flex-col divide-y divide-line">
              {data.sales.map((s) => {
                const profit = (s.unitPrice - s.unitCost) * s.quantity;
                return (
                  <li key={s._id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[13px] text-ink">{fmtDateTime(s.soldAt)}</p>
                      <p className="mt-0.5 text-[12px] text-ink-3">
                        {fmtNum(s.quantity)} × {fmt(s.unitPrice)}
                        {s.variantLabel ? ` · ${s.variantLabel}` : ""}
                        {s.buyer ? ` · ${s.buyer}` : ""}
                      </p>
                    </div>
                    <span
                      className={cx(
                        "shrink-0 text-[13.5px] font-bold tabular-nums",
                        profit < 0 ? "text-critical-ink" : "text-good-ink",
                      )}
                    >
                      {profit < 0 ? `−${fmt(Math.abs(profit))}` : `+${fmt(profit)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Section>
        </div>
      )}
      <BatchDialog
        open={editingLot !== null}
        onClose={() => setEditingLot(null)}
        batch={editingLot}
      />
      <LotDetailDialog
        open={viewingLot !== null}
        onClose={() => setViewingLot(null)}
        lotId={viewingLot}
        onViewVendor={(id) => setViewingVendor(id)}
      />
      <VendorDetailDialog
        open={viewingVendor !== null}
        onClose={() => setViewingVendor(null)}
        vendorId={viewingVendor}
      />
      <LotRemoveDialog lot={deletingLot} onClose={() => setDeletingLot(null)} />
    </Modal>
  );
}

function Stat({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: "good";
}) {
  return (
    <div className="rounded-xl border border-line bg-page px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-3">
        <span aria-hidden>{icon}</span>
        {label}
      </p>
      <p
        className={cx(
          "mt-1 truncate text-[17px] font-bold tabular-nums",
          tone === "good" ? "text-good-ink" : "text-ink",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-ink-3">{hint}</p>}
    </div>
  );
}

function Section({
  title,
  empty,
  emptyText,
  children,
}: {
  title: string;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2.5 text-[10.5px] font-bold tracking-[0.09em] text-ink-3 uppercase">
        {title}
      </p>
      {empty ? <p className="text-[13px] text-ink-3">{emptyText}</p> : children}
    </div>
  );
}
