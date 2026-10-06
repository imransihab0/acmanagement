import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookmarkPlus, Check, KeyRound, Receipt, Trash2 } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  AmountInput,
  Button,
  Field,
  Input,
  Modal,
  ModalFooter,
  SectionLabel,
  Select,
  Textarea,
  cx,
} from "./ui";
import { ProductPicker } from "./ProductPicker";
import { CustomerPicker, type SavedCustomer } from "./CustomerPicker";
import { customerKey, variantAvailable } from "../../convex/shared";
import { useSettings } from "../lib/settings";
import { useT } from "../lib/i18n";
import { CURRENCY_SYMBOL } from "../lib/format";
import { errorMessage, useToast } from "../lib/toast";
import { useAuthedMutation, useAuthedQuery } from "../lib/session";

type Line = {
  key: string;
  productId: Id<"products">;
  productName: string;
  unit: string;
  stock: number;
  unitCost: number;
  quantity: string;
  unitPrice: string;
  /** The purchase lot this line sells out of; empty means the product's own cost. */
  batchId: string;
  /** Which size, for a product sold in variants; empty for a plain product. */
  variantId: string;
};

type OpenLot = {
  id: Id<"stockBatches">;
  productId: Id<"products">;
  label: string;
  unitCost: number;
  unitPrice: number;
  remaining: number;
};

let lineSeq = 0;

/**
 * Records a sale: the customer, what they took, what they paid.
 *
 * One dialog for both shapes the shop actually has — a counter sale that is
 * over the moment it is written, and an order to be delivered later. They
 * differ by one field, not by being separate features, which is why there is
 * no separate "quick sell" any more.
 */
export function SaleDialog({
  open,
  onClose,
  presetProduct,
}: {
  open: boolean;
  onClose: () => void;
  /** Pre-loads one line — the Sell button on a product opens straight into this. */
  presetProduct?: Doc<"products"> | null;
}) {
  const { fmt, fmtNum } = useSettings();
  const t = useT();
  const toast = useToast();
  const products = useAuthedQuery(api.products.list, {});
  const customers = useAuthedQuery(api.customers.list) ?? [];
  const openLots = (useAuthedQuery(api.profit.openLots) ?? []) as OpenLot[];
  const create = useAuthedMutation(api.orders.create);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("");
  const [delivery, setDelivery] = useState("");
  const [payment, setPayment] = useState("due");
  /** Only meaningful when `payment` is "partial" — see the field below. */
  const [paidNow, setPaidNow] = useState("");
  const [note, setNote] = useState("");
  const [override, setOverride] = useState("");
  const [saveCustomer, setSaveCustomer] = useState(false);
  /*
    Completed by default: most sales are rung up after the goods have gone,
    and a default that leaves stock untouched is wrong far more often than it
    is right. An order still to be delivered is the deliberate choice.
  */
  const [completed, setCompleted] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPhone("");
    setAddress("");
    setLines([]);
    setDiscount("");
    setDelivery("");
    setPayment("due");
    setPaidNow("");
    setNote("");
    setOverride("");
    setSaveCustomer(false);
    setCompleted(true);
    setLines(presetProduct ? [lineFor(presetProduct)] : []);
  }, [open, presetProduct]);

  /*
    Whether these details are already in the address book — decided by the
    same function the server uses, not a second copy of the rule. A tick
    offered for someone already saved, or withheld from someone who is not,
    is visible to the shopkeeper immediately.
  */
  const known = useMemo(() => {
    if (!name.trim()) return false;
    const key = customerKey(name, phone);
    return customers.some((c) => customerKey(c.name, c.phone) === key);
  }, [customers, name, phone]);

  function fillFrom(c: SavedCustomer) {
    setName(c.name);
    setPhone(c.phone ?? "");
    setAddress(c.address ?? "");
  }

  /** Lots of this product with stock left, oldest purchase first. */
  function lotsOf(productId: Id<"products">) {
    return openLots.filter((l) => l.productId === productId);
  }

  function productOf(productId: Id<"products">) {
    return products?.find((p) => p._id === productId);
  }

  /**
   * One sale line from a product, with its price and cost snapshotted. A
   * product sold in sizes picks the first one by default — same reasoning
   * as the lot below: not a guess to leave unstated, just a default that
   * the row shows and a dropdown can change.
   */
  function lineFor(p: Doc<"products">): Line {
    const variant = p.variants?.[0];
    if (variant) {
      return {
        key: `l${lineSeq++}`,
        productId: p._id,
        productName: p.name,
        unit: variant.label,
        stock: variantAvailable(p, variant.id),
        quantity: "1",
        unitPrice: variant.sellPrice !== undefined ? String(variant.sellPrice) : "",
        unitCost: variant.costPrice,
        batchId: "",
        variantId: variant.id,
      };
    }
    /*
      The oldest open lot is chosen for you. A shop sells what it bought
      first, and making the common case a decision would mean picking a lot
      forty times a day to say the obvious thing — but it is only a default,
      and the row says which one it landed on.
    */
    const lot = openLots.filter((l) => l.productId === p._id)[0];
    return {
      key: `l${lineSeq++}`,
      productId: p._id,
      productName: p.name,
      unit: p.unit ?? "পিস",
      stock: p.quantity,
      quantity: "1",
      /*
        Only a real selling price is prefilled. Falling back to cost was
        silently guaranteeing zero profit on every line; an empty box that
        asks for a number is far better than a wrong one that looks filled.
      */
      unitPrice:
        lot?.unitPrice !== undefined
          ? String(lot.unitPrice)
          : p.sellPrice !== undefined
            ? String(p.sellPrice)
            : "",
      unitCost: lot ? lot.unitCost : p.costPrice,
      batchId: lot ? (lot.id as string) : "",
      variantId: "",
    };
  }

  function addProduct(p: Doc<"products">) {
    setLines((prev) => {
      // Picking the same product twice bumps its quantity rather than
      // creating a duplicate line the customer would have to reconcile.
      const existing = prev.find((l) => l.productId === p._id);
      if (existing) {
        return prev.map((l) =>
          l.key === existing.key
            ? { ...l, quantity: String((Number(l.quantity) || 0) + 1) }
            : l,
        );
      }
      return [...prev, lineFor(p)];
    });
  }

  const parsed = lines.map((l) => ({
    ...l,
    qty: Number(l.quantity),
    price: Number(l.unitPrice),
  }));
  const subtotal = parsed.reduce(
    (sum, l) => sum + (Number.isFinite(l.qty) && Number.isFinite(l.price) ? l.qty * l.price : 0),
    0,
  );
  const discountValue = Number(discount) || 0;
  const deliveryValue = Number(delivery) || 0;
  const total = subtotal - discountValue + deliveryValue;

  const shortLines = parsed.filter((l) => Number.isFinite(l.qty) && l.qty > l.stock);
  // Selling at or below cost is legitimate sometimes, but never by accident.
  const noMarginLines = parsed.filter(
    (l) => Number.isFinite(l.price) && l.unitPrice !== "" && l.price <= l.unitCost,
  );
  const linesValid =
    parsed.length > 0 &&
    parsed.every((l) => Number.isFinite(l.qty) && l.qty > 0 && Number.isFinite(l.price) && l.price >= 0);
  const paidNowValue = Number(paidNow) || 0;
  // A partial payment has to leave something still owed — ৳0 is Due and the
  // full total is Paid, so neither end of the range belongs to this one.
  const partialValid = payment !== "partial" || (paidNow !== "" && paidNowValue > 0 && paidNowValue < total);
  const valid =
    name.trim().length > 0 &&
    linesValid &&
    discountValue <= subtotal &&
    partialValid &&
    !saving &&
    (shortLines.length === 0 || override.length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      await create({
        customerName: name,
        customerPhone: phone,
        customerAddress: address,
        items: parsed.map((l) => ({
          productId: l.productId,
          quantity: l.qty,
          unitPrice: l.price,
          batchId: l.batchId ? (l.batchId as Id<"stockBatches">) : undefined,
          variantId: l.variantId || undefined,
        })),
        discount: discountValue,
        deliveryCharge: deliveryValue,
        paymentStatus: payment,
        paidAmount: payment === "partial" ? paidNowValue : undefined,
        note,
        overridePasscode: shortLines.length > 0 ? override : undefined,
        saveCustomer,
        completed,
        source: "manual",
      });
      toast.ok(completed ? t("sales.recorded") : t("sales.orderPlaced"));
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
      setOverride("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<Receipt size={19} />}
      title={t("sales.newSale")}
      subtitle={t("sales.newSaleHint")}
      width="sm:max-w-3xl"
    >
      <form onSubmit={submit}>
        <div className="flex flex-col gap-6 px-6 py-6">
          <div className="flex flex-col gap-4">
            <SectionLabel>{t("orders.customer")}</SectionLabel>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("orders.customerName")}>
                {() => (
                  <CustomerPicker
                    value={name}
                    onChange={setName}
                    onPick={fillFrom}
                    customers={customers}
                  />
                )}
              </Field>
              <Field label={t("orders.phone")}>
                {(id) => (
                  <Input
                    id={id}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="01712-345678"
                    autoComplete="off"
                    inputMode="tel"
                  />
                )}
              </Field>
            </div>
            <Field label={t("orders.address")}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="১২/ক, মিরপুর রোড, ঢাকা"
                />
              )}
            </Field>

            {/*
              Offered only for someone not already saved. A tick that does
              nothing is one people stop reading, including on the orders
              where it would have mattered.
            */}
            {name.trim() !== "" && !known && (
              <label className="ac-fade-in flex cursor-pointer items-start gap-3 rounded-xl border border-line-strong bg-page px-3.5 py-3">
                <input
                  type="checkbox"
                  checked={saveCustomer}
                  onChange={(e) => setSaveCustomer(e.target.checked)}
                  className="mt-0.5 size-4 accent-[var(--accent)]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                    <BookmarkPlus size={15} className="text-accent" aria-hidden />
                    {t("orders.saveCustomer")}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-4.5 text-ink-3">
                    {t("orders.saveCustomerHint")}
                  </span>
                </span>
              </label>
            )}
            {name.trim() !== "" && known && (
              <p className="ac-fade-in flex items-center gap-1.5 text-[12px] font-semibold text-good-ink">
                <Check size={14} aria-hidden />
                {t("orders.customerSaved")}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-line pt-5">
            <SectionLabel>{t("orders.products")}</SectionLabel>
            {products === undefined ? (
              <div className="ac-skeleton h-11 rounded-xl bg-surface-2" aria-hidden />
            ) : (
              <ProductPicker products={products} onPick={addProduct} />
            )}

            {lines.length === 0 ? (
              <p className="py-2 text-[13px] text-ink-3">{t("orders.noProducts")}</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {parsed.map((line) => {
                  const over = Number.isFinite(line.qty) && line.qty > line.stock;
                  return (
                    <li
                      key={line.key}
                      className={cx(
                        "rounded-xl border bg-page p-3.5",
                        over ? "border-critical/40" : "border-line",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[13.5px] font-semibold text-ink">
                            {line.productName}
                          </p>
                          <p
                            className={cx(
                              "mt-0.5 text-[11.5px]",
                              over ? "font-semibold text-critical-ink" : "text-ink-3",
                            )}
                          >
                            {t("orders.inStock")}: {fmtNum(line.stock)} {line.unit}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setLines((p) => p.filter((l) => l.key !== line.key))}
                          aria-label={t("common.delete")}
                          className="shrink-0 rounded-lg p-1.5 text-ink-3 hover:bg-surface-2 hover:text-critical"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>

                      {/*
                        Which size this line is. Lots are a purchase-side
                        idea and sizes a selling-side one, so a product with
                        sizes picks from these instead of a lot — picking
                        both would leave two different costs claiming the
                        same line.
                      */}
                      {productOf(line.productId)?.variants?.length ? (
                        <label className="mt-2.5 block">
                          <span className="mb-1 block text-[11px] font-semibold text-ink-3">
                            {t("products.variantLabel")}
                          </span>
                          <Select
                            value={line.variantId}
                            onChange={(e) => {
                              const product = productOf(line.productId);
                              const picked = product?.variants?.find((v) => v.id === e.target.value);
                              setLines((p) =>
                                p.map((l) =>
                                  l.key === line.key && picked && product
                                    ? {
                                        ...l,
                                        variantId: picked.id,
                                        unit: picked.label,
                                        stock: variantAvailable(product, picked.id),
                                        unitCost: picked.costPrice,
                                        // The asking price only fills a blank,
                                        // so a price already typed stands.
                                        unitPrice:
                                          l.unitPrice === "" && picked.sellPrice !== undefined
                                            ? String(picked.sellPrice)
                                            : l.unitPrice,
                                      }
                                    : l,
                                ),
                              );
                            }}
                          >
                            {productOf(line.productId)?.variants?.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.label} · {fmt(v.costPrice)}
                              </option>
                            ))}
                          </Select>
                        </label>
                      ) : (
                        lotsOf(line.productId).length > 0 && (
                        <label className="mt-2.5 block">
                          <span className="mb-1 block text-[11px] font-semibold text-ink-3">
                            {t("orders.sellFromLot")}
                          </span>
                          <Select
                            value={line.batchId}
                            onChange={(e) => {
                              const picked = openLots.find((l) => l.id === e.target.value);
                              setLines((p) =>
                                p.map((l) =>
                                  l.key === line.key
                                    ? {
                                        ...l,
                                        batchId: e.target.value,
                                        // The cost always follows the lot; the
                                        // asking price only fills a blank, so a
                                        // price already typed is never overwritten.
                                        unitCost: picked ? picked.unitCost : l.unitCost,
                                        unitPrice:
                                          l.unitPrice === "" && picked
                                            ? String(picked.unitPrice)
                                            : l.unitPrice,
                                      }
                                    : l,
                                ),
                              );
                            }}
                          >
                            {lotsOf(line.productId).map((l) => (
                              <option key={l.id} value={l.id}>
                                {fmt(l.unitCost)} · {fmtNum(l.remaining)} {line.unit} · {l.label}
                              </option>
                            ))}
                            <option value="">{t("orders.noLot")}</option>
                          </Select>
                        </label>
                        )
                      )}

                      <div className="mt-2.5 flex flex-wrap items-end gap-3">
                        <label className="flex-1">
                          <span className="mb-1 block text-[11px] font-semibold text-ink-3">
                            {t("common.quantity")} ({line.unit})
                          </span>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            inputMode="decimal"
                            value={line.quantity}
                            onChange={(e) =>
                              setLines((p) =>
                                p.map((l) =>
                                  l.key === line.key ? { ...l, quantity: e.target.value } : l,
                                ),
                              )
                            }
                            className="tabular-nums"
                          />
                        </label>
                        <label className="flex-1">
                          <span className="mb-1 block text-[11px] font-semibold text-ink-3">
                            {t("sales.unitPrice")}
                          </span>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            inputMode="decimal"
                            value={line.unitPrice}
                            onChange={(e) =>
                              setLines((p) =>
                                p.map((l) =>
                                  l.key === line.key ? { ...l, unitPrice: e.target.value } : l,
                                ),
                              )
                            }
                            className="tabular-nums"
                          />
                        </label>
                        <div className="min-w-24 text-right">
                          <span className="mb-1 block text-[11px] font-semibold text-ink-3">
                            {t("common.total")}
                          </span>
                          <span className="block pt-2.5 text-[15px] font-bold tabular-nums text-ink">
                            {fmt(
                              Number.isFinite(line.qty) && Number.isFinite(line.price)
                                ? line.qty * line.price
                                : 0,
                            )}
                          </span>
                          <span
                            className={cx(
                              "block text-[11px] font-semibold tabular-nums",
                              line.price > line.unitCost ? "text-good-ink" : "text-critical-ink",
                            )}
                          >
                            {Number.isFinite(line.price)
                              ? `${line.price > line.unitCost ? "+" : ""}${fmt(
                                  (line.price - line.unitCost) * (Number.isFinite(line.qty) ? line.qty : 0),
                                )}`
                              : ""}
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-4 border-t border-line pt-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("orders.discount")}>
                {(id) => (
                  <AmountInput
                    id={id}
                    symbol={CURRENCY_SYMBOL}
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                    placeholder="0"
                    className="text-[18px]"
                  />
                )}
              </Field>
              <Field label={t("orders.delivery")}>
                {(id) => (
                  <AmountInput
                    id={id}
                    symbol={CURRENCY_SYMBOL}
                    value={delivery}
                    onChange={(e) => setDelivery(e.target.value)}
                    placeholder="0"
                    className="text-[18px]"
                  />
                )}
              </Field>
              <Field label={t("orders.payment")}>
                {(id) => (
                  <Select
                    id={id}
                    value={payment}
                    onChange={(e) => {
                      setPayment(e.target.value);
                      if (e.target.value !== "partial") setPaidNow("");
                    }}
                  >
                    <option value="due">{t("orders.due")}</option>
                    <option value="partial">{t("orders.partial")}</option>
                    <option value="paid">{t("orders.paid")}</option>
                  </Select>
                )}
              </Field>
            </div>

            {/*
              Without this, a sale rung up as "Partial" had no way to say how
              much — the order saved with no figure at all, so the sales list
              and the printed receipt had nothing to show beside "Partial"
              except the full total, as though nothing had been paid.
            */}
            {payment === "partial" && (
              <Field label={t("orders.amountPaid")} hint={total > 0 ? `${t("orders.partialRange")} ${fmt(total)}.` : undefined}>
                {(id) => (
                  <AmountInput
                    id={id}
                    symbol={CURRENCY_SYMBOL}
                    value={paidNow}
                    onChange={(e) => setPaidNow(e.target.value)}
                    placeholder="0"
                    className="text-[18px]"
                    autoFocus
                  />
                )}
              </Field>
            )}

            {/*
              The one field that separates a counter sale from an order still
              to go out. It decides whether stock moves now, so it says so in
              as many words rather than leaving it to be discovered.
            */}
            <Field label={t("sales.fulfilment")} hint={completed ? t("sales.completedHint") : t("sales.pendingHint")}>
              {(id) => (
                <Select
                  id={id}
                  value={completed ? "completed" : "pending"}
                  onChange={(e) => setCompleted(e.target.value === "completed")}
                >
                  <option value="completed">{t("sales.completed")}</option>
                  <option value="pending">{t("sales.pendingOrder")}</option>
                </Select>
              )}
            </Field>

            <div className="rounded-2xl border border-line bg-page p-5">
              <Row label={t("orders.subtotal")} value={fmt(subtotal)} />
              {discountValue > 0 && (
                <Row label={t("orders.discount")} value={`− ${fmt(discountValue)}`} muted />
              )}
              {deliveryValue > 0 && <Row label={t("orders.delivery")} value={fmt(deliveryValue)} muted />}
              <div className="mt-3 flex items-end justify-between gap-4 border-t border-line pt-3">
                <span className="text-[13px] font-bold text-ink">{t("orders.total")}</span>
                <span className="text-[26px] leading-8 font-bold tabular-nums text-ink">
                  {fmt(total)}
                </span>
              </div>
            </div>

            {noMarginLines.length > 0 && (
              <div className="rounded-2xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-warning-soft p-4">
                <p className="flex items-start gap-2 text-[13px] font-semibold text-ink">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  {t("orders.noMargin")}
                </p>
                <ul className="mt-1.5 ml-6 list-disc text-[12.5px] text-ink-2">
                  {noMarginLines.map((l) => (
                    <li key={l.key}>
                      {l.productName} — {t("orders.cost")} {fmt(l.unitCost)}, {t("orders.selling")}{" "}
                      {fmt(l.price)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {shortLines.length > 0 && (
              <div className="rounded-2xl border border-[color-mix(in_srgb,var(--critical)_30%,transparent)] bg-critical-soft p-4">
                <p className="flex items-start gap-2 text-[13px] font-semibold text-critical-ink">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
                  {t("orders.shortStock")}
                </p>
                <ul className="mt-1.5 ml-6 list-disc text-[12.5px] text-ink-2">
                  {shortLines.map((l) => (
                    <li key={l.key}>
                      {l.productName} — {fmtNum(l.qty)} {t("orders.requested")}, {fmtNum(l.stock)}{" "}
                      {t("orders.available")}
                    </li>
                  ))}
                </ul>
                <label className="mt-3 block">
                  <span className="mb-1.5 block text-[12px] font-semibold text-ink-2">
                    {t("orders.overrideHint")}
                  </span>
                  <div className="relative">
                    <KeyRound
                      size={15}
                      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
                      aria-hidden
                    />
                    <Input
                      type="password"
                      value={override}
                      onChange={(e) => setOverride(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      className="pl-10"
                    />
                  </div>
                </label>
              </div>
            )}

            <Field label={t("common.note")}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("orders.notePlaceholder")}
                />
              )}
            </Field>
          </div>
        </div>

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            {saving ? t("common.saving") : completed ? t("sales.recordSale") : t("sales.placeOrder")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="text-[13px] text-ink-2">{label}</span>
      <span
        className={cx(
          "text-[14px] font-semibold tabular-nums",
          muted ? "text-ink-2" : "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}
