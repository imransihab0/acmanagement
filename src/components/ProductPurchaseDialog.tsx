import { useEffect, useState } from "react";
import { Check, Landmark } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AmountInput, Button, Field, Input, Modal, ModalFooter, Select, SectionLabel, Textarea } from "./ui";
import { LotMediaManager } from "./LotMediaManager";
import { useSettings } from "../lib/settings";
import { useT } from "../lib/i18n";
import { CURRENCY_SYMBOL, toLocalInputValue } from "../lib/format";
import { errorMessage, useToast } from "../lib/toast";
import { useAuthedMutation, useAuthedQuery } from "../lib/session";

/**
 * Logs buying stock as an "investment" rather than an operating cost.
 *
 * Writes the exact same stock lot `BatchDialog` would (a product's shelf
 * count moves, same as buying it from Products), but tags the lot so it adds
 * to the Investment balance instead of to the Costs ledger — the price of
 * stock is recovered through margin, not booked as an expense.
 */
export function ProductPurchaseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { fmt } = useSettings();
  const t = useT();
  const toast = useToast();
  const products = useAuthedQuery(api.products.list, {});
  const vendors = useAuthedQuery(api.vendors.list, {});
  const add = useAuthedMutation(api.profit.addPurchaseCostBatch);

  const [productId, setProductId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [purchasedAt, setPurchasedAt] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  /*
    A lot needs an id before anything can be attached to it, so the receipt
    step only opens once the purchase above is actually saved — this is the
    same reason `BatchDialog` only shows `LotMediaManager` in edit mode, not
    while a lot is still being created.
  */
  const [savedLotId, setSavedLotId] = useState<Id<"stockBatches"> | null>(null);

  useEffect(() => {
    if (!open) return;
    setProductId("");
    setVendorId("");
    setPurchasedAt(toLocalInputValue(Date.now()));
    setQuantity("");
    setUnitCost("");
    setNote("");
    setSavedLotId(null);
  }, [open]);

  const qty = Number(quantity);
  const cost = Number(unitCost);
  const qtyOk = quantity.trim() !== "" && Number.isFinite(qty) && qty > 0;
  const costOk = unitCost.trim() !== "" && Number.isFinite(cost) && cost >= 0;
  const valid = Boolean(productId) && qtyOk && costOk && !saving;
  const total = qtyOk && costOk ? qty * cost : 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      const when = purchasedAt ? new Date(purchasedAt).getTime() : Date.now();
      const id = await add({
        productId: productId as Id<"products">,
        label: "Product purchase",
        purchasedAt: when,
        quantity: qty,
        unitCost: cost,
        note,
        vendorId: vendorId ? (vendorId as Id<"vendors">) : undefined,
      });
      toast.ok(`Logged ${fmt(total)} as investment.`);
      // One more optional step — attach the receipt — rather than closing
      // straight away, so it doesn't need a second trip through Products.
      setSavedLotId(id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (savedLotId) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        icon={<Landmark size={19} />}
        title={t("investment.receiptTitle")}
        subtitle={t("investment.receiptSubtitle")}
      >
        <div className="flex flex-col gap-6 px-6 py-6">
          <LotMediaManager lotId={savedLotId} />
        </div>
        <ModalFooter>
          <Button type="button" variant="primary" onClick={onClose}>
            <Check size={16} />
            {t("common.done")}
          </Button>
        </ModalFooter>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<Landmark size={19} />}
      title={t("investment.addTitle")}
      subtitle={t("investment.addSubtitle")}
    >
      <form onSubmit={submit}>
        <div className="flex flex-col gap-6 px-6 py-6">
          <div className="flex flex-col gap-2.5">
            <SectionLabel>Product</SectionLabel>
            <Select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              aria-label="Product"
              required
            >
              <option value="" disabled>
                Choose a product…
              </option>
              {(products ?? []).map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel>{t("lot.vendor")}</SectionLabel>
              <span className="text-[11.5px] text-ink-3">{t("common.optional")}</span>
            </div>
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} aria-label={t("lot.vendor")}>
              <option value="">{t("lot.noVendor")}</option>
              {(vendors ?? []).map((v) => (
                <option key={v._id} value={v._id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Purchase date">
              {(id) => (
                <Input
                  id={id}
                  type="datetime-local"
                  value={purchasedAt}
                  onChange={(e) => setPurchasedAt(e.target.value)}
                />
              )}
            </Field>
            <Field label="Quantity">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="20"
                  className="tabular-nums"
                  required
                />
              )}
            </Field>
          </div>

          <div className="flex flex-col gap-2.5">
            <SectionLabel>Buy price (per unit)</SectionLabel>
            <AmountInput
              symbol={CURRENCY_SYMBOL}
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              placeholder="0"
              required
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-page p-5">
            <span className="text-[13px] text-ink-2">{t("investment.totalToInvest")}</span>
            <span className="text-[22px] leading-7 font-bold tracking-tight tabular-nums text-ink">
              {fmt(total)}
            </span>
          </div>

          <Field label={t("common.note")} hint={t("common.optional")}>
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Supplier, invoice number, anything."
              />
            )}
          </Field>
        </div>

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            {saving ? t("common.saving") : t("investment.addConfirm")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
