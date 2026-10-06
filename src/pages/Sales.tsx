import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  Eye,
  FileText,
  Pencil,
  PiggyBank,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  CircleDollarSign,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge, Button, Card, EmptyState, Input, Select, cx } from "../components/ui";
import { Pagination, usePagination } from "../components/Pagination";
import { StatTile } from "../components/StatTile";
import { RangePills } from "../components/RangePills";
import { SaleDialog } from "../components/SaleDialog";
import { PaymentDialog } from "../components/PaymentDialog";
import { CustomerDetailDialog } from "../components/CustomerDetailDialog";
import { PasscodeConfirmDialog } from "../components/PasscodeConfirmDialog";
import { useSettings } from "../lib/settings";
import { useT } from "../lib/i18n";
import { useRangeFilter } from "../lib/dateRange";
import { gradientFor, initialOf } from "../lib/avatar";
import { errorMessage, useToast } from "../lib/toast";
import { useAuthedMutation, useAuthedQuery } from "../lib/session";
import { CURRENCY_CODE, plural } from "../lib/format";
import { downloadReceipt, downloadReceipts, previewReceipt } from "../lib/pdf";
import type { ReceiptOrder } from "../lib/receipt";
import { customerKey } from "../../convex/shared";

/** The order shape the receipt module wants, from a stored order. */
function toReceipt(order: Doc<"orders">): ReceiptOrder {
  return {
    orderNo: order.orderNo,
    orderedAt: order.orderedAt,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerAddress: order.customerAddress,
    items: order.items.map((i) => ({
      productName: i.productName,
      quantity: i.quantity,
      unit: i.unit,
      unitPrice: i.unitPrice,
    })),
    subtotal: order.subtotal,
    discount: order.discount,
    deliveryCharge: order.deliveryCharge,
    total: order.total,
    paymentStatus: order.paymentStatus,
    paidAmount: order.paidAmount,
    orderStatus: order.orderStatus,
    note: order.note,
  };
}

const STATUS_TONE: Record<string, "neutral" | "good" | "warning" | "critical" | "accent"> = {
  pending: "warning",
  confirmed: "accent",
  delivered: "good",
  cancelled: "critical",
};
const PAYMENT_TONE: Record<string, "neutral" | "good" | "warning" | "critical"> = {
  paid: "good",
  partial: "warning",
  due: "critical",
};

/*
  What a sale was actually worth.

  Delivery is excluded because it is a pass-through rather than product
  revenue — folding it in inflates the margin. The discount comes off the
  revenue, which is how confirming a sale books it: spread across the lines in
  proportion to their value. So this agrees with the Profit page by
  construction rather than by coincidence.
*/
function moneyOf(order: Doc<"orders">) {
  const cost = order.items.reduce((sum, i) => sum + i.unitCost * i.quantity, 0);
  const revenue = order.subtotal - order.discount;
  return { revenue, cost, profit: revenue - cost };
}

/** Only a sale that has actually happened counts toward the totals. */
const isBooked = (o: Doc<"orders">) =>
  o.orderStatus === "confirmed" || o.orderStatus === "delivered";

export function SalesPage() {
  const { fmt, fmtNum, fmtPercent, fmtDateFull, lang } = useSettings();
  const t = useT();
  const toast = useToast();
  const orders = useAuthedQuery(api.orders.list, {});
  const customers = useAuthedQuery(api.customers.list) ?? [];
  /*
    Only `windowCosts` is used from here — the per-range operating costs that
    turn gross profit into net, scoped the same way `range` scopes the sales
    below.
  */
  const dashboardData = useAuthedQuery(api.dashboard.overview);
  const confirmOrder = useAuthedMutation(api.orders.confirm);
  const cancelOrder = useAuthedMutation(api.orders.cancel);
  const removeOrder = useAuthedMutation(api.orders.remove);
  const restoreOrder = useAuthedMutation(api.orders.restore);

  /*
    An order keeps its own snapshot of the name and phone rather than a link
    to the customer row — the same reason a sale snapshots its product name:
    the receipt has to keep saying what it said. Matching back to a saved
    customer is done the same way the server itself decides "is this the
    same person" (see `customerKey`), not by a second, looser guess.
  */
  const customerIdByKey = useMemo(() => {
    const map = new Map<string, Id<"customers">>();
    for (const c of customers) map.set(customerKey(c.name, c.phone), c._id);
    return map;
  }, [customers]);
  const [viewingCustomer, setViewingCustomer] = useState<Id<"customers"> | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const range = useRangeFilter("ac.range.sales");
  const [addOpen, setAddOpen] = useState(false);
  /*
    One piece of state for every passcode-gated action on a sale, so the four
    of them cannot drift into four slightly different dialogs.
  */
  const [pending, setPending] = useState<{
    kind: "confirm" | "cancel" | "restore" | "delete";
    order: Doc<"orders">;
  } | null>(null);
  const [paying, setPaying] = useState<Doc<"orders"> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (orders ?? []).filter((o) => {
      if (o.orderedAt < range.since || o.orderedAt >= range.untilExclusive) return false;
      if (status && o.orderStatus !== status) return false;
      if (!term) return true;
      return (
        o.orderNo.toLowerCase().includes(term) ||
        o.customerName.toLowerCase().includes(term) ||
        (o.customerPhone ?? "").includes(term) ||
        o.items.some((i) => i.productName.toLowerCase().includes(term))
      );
    });
  }, [orders, search, status, range.since, range.untilExclusive]);

  /*
    Totals cover every sale the filters leave on screen, not the page being
    shown — a figure that changes when you turn the page is not a total.
  */
  const totals = useMemo(() => {
    let revenue = 0;
    let cost = 0;
    let booked = 0;
    let pending = 0;
    for (const o of rows) {
      if (!isBooked(o)) {
        if (o.orderStatus === "pending") pending++;
        continue;
      }
      const m = moneyOf(o);
      revenue += m.revenue;
      cost += m.cost;
      booked++;
    }
    return { revenue, cost, profit: revenue - cost, booked, pending };
  }, [rows]);

  /*
    Net profit takes the same operating costs the Dashboard takes off gross
    profit — bounded to this same range, so the figure agrees with the
    Dashboard by construction rather than by coincidence.
  */
  const operatingCost = useMemo(() => {
    if (!dashboardData) return 0;
    let sum = 0;
    for (const c of dashboardData.windowCosts) {
      if (c.spentAt >= range.since && c.spentAt < range.untilExclusive) sum += c.amount;
    }
    return sum;
  }, [dashboardData, range.since, range.untilExclusive]);
  const netProfit = totals.profit - operatingCost;

  const pager = usePagination(rows, `${search}|${status}|${range.since}|${range.until}`, 25);
  const bengali = lang === "bn";

  function exportCsv() {
    const header = [
      "Date",
      "No",
      "Customer",
      "Phone",
      "Status",
      "Payment",
      "Items",
      `Subtotal (${CURRENCY_CODE})`,
      `Discount (${CURRENCY_CODE})`,
      `Delivery (${CURRENCY_CODE})`,
      `Total (${CURRENCY_CODE})`,
      `Profit (${CURRENCY_CODE})`,
    ];
    const body = rows.map((o) => [
      new Date(o.orderedAt).toISOString(),
      o.orderNo,
      o.customerName,
      o.customerPhone ?? "",
      o.orderStatus,
      o.paymentStatus,
      o.items.map((i) => `${i.productName} x${i.quantity}`).join("; "),
      o.subtotal,
      o.discount,
      o.deliveryCharge,
      o.total,
      isBooked(o) ? moneyOf(o).profit : "",
    ]);
    const csv = [header, ...body]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `sales-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.ok(`Exported ${plural(rows.length, "sale")}.`);
  }

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.ok(ok);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  /*
    The passcode replaces the one-click Undo that used to live in the toast:
    a toast cannot ask for one. Cancelling is still reversible — the way back
    is the Undo cancel button on the sale, which asks in the same way.
  */
  const ACTIONS = {
    confirm: {
      title: t("orders.confirmTitle"),
      body: t("orders.confirmBody"),
      label: t("orders.confirm"),
      done: t("orders.confirmedToast"),
      tone: "neutral" as const,
      run: (id: Doc<"orders">["_id"], passcode: string) => confirmOrder({ id, passcode }),
    },
    cancel: {
      title: t("orders.cancelTitle"),
      body: t("orders.cancelBody"),
      label: t("orders.cancel"),
      done: t("orders.cancelledToast"),
      tone: "critical" as const,
      run: (id: Doc<"orders">["_id"], passcode: string) => cancelOrder({ id, passcode }),
    },
    restore: {
      title: t("orders.restoreTitle"),
      body: t("orders.restoreBody"),
      label: t("orders.restore"),
      done: t("orders.restoredToast"),
      tone: "neutral" as const,
      run: (id: Doc<"orders">["_id"], passcode: string) => restoreOrder({ id, passcode }),
    },
    delete: {
      title: t("orders.deleteTitle"),
      body: t("orders.deleteBody"),
      label: t("common.delete"),
      done: t("orders.deleted"),
      tone: "critical" as const,
      run: (id: Doc<"orders">["_id"], passcode: string) => removeOrder({ id, passcode }),
    },
  };

  const action = pending ? ACTIONS[pending.kind] : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] leading-8 font-bold tracking-tight text-ink sm:text-[28px] sm:leading-9">
            {t("sales.title")}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3 sm:text-[14px]">{t("sales.subtitle")}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">
          <Button
            variant="secondary"
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="flex-1 sm:flex-none"
          >
            <Download size={17} />
            {t("sales.export")}
          </Button>
          <Button
            variant="secondary"
            disabled={rows.length === 0 || busy === "bulk"}
            className="flex-1 sm:flex-none"
            onClick={() =>
              run(
                "bulk",
                () => downloadReceipts(rows.map(toReceipt), { bengali }),
                t("orders.receiptsDownloaded"),
              )
            }
          >
            <FileText size={17} />
            {t("orders.allReceipts")}
          </Button>
          <Button variant="primary" onClick={() => setAddOpen(true)} className="flex-1 sm:flex-none">
            <Plus size={17} />
            {t("sales.newSale")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full min-w-0 sm:min-w-60 sm:max-w-md sm:flex-1">
          <Search
            size={17}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("orders.searchPlaceholder")}
            className="pl-10.5"
            aria-label={t("common.search")}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("orders.status")}>
            <option value="">{t("orders.allStatuses")}</option>
            <option value="pending">{t("orders.pending")}</option>
            <option value="confirmed">{t("orders.confirmed")}</option>
            <option value="delivered">{t("orders.delivered")}</option>
            <option value="cancelled">{t("orders.cancelled")}</option>
          </Select>
        </div>
      </div>

      {/* One filter row, above everything it scopes — same pattern as the Dashboard. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-ink-3">
          {t("dash.showing")} <span className="font-semibold text-ink-2">{range.activeLabel.full}</span>
        </p>
        <RangePills range={range} />
      </div>

      <div className="ac-stagger grid gap-4 sm:grid-cols-3">
        <StatTile
          hero
          accent="emerald"
          label={t("dash.netProfit")}
          value={netProfit < 0 ? `−${fmt(Math.abs(netProfit))}` : fmt(netProfit)}
          icon={<PiggyBank size={17} />}
          sub={
            totals.revenue > 0
              ? `${fmtPercent(netProfit / totals.revenue)} ${t("dash.margin")}`
              : undefined
          }
        />
        <StatTile
          accent="sky"
          label={t("sales.revenue")}
          value={fmt(totals.revenue)}
          icon={<CircleDollarSign size={17} />}
          sub={`${t("sales.cost")} ${fmt(totals.cost)}`}
        />
        <StatTile
          accent="amber"
          label={t("sales.title")}
          value={fmtNum(totals.booked)}
          icon={<Receipt size={17} />}
          sub={totals.pending > 0 ? `${fmtNum(totals.pending)} ${t("orders.pending")}` : undefined}
        />
      </div>

      {orders === undefined ? (
        <div className="ac-skeleton h-72 rounded-card border border-line bg-surface" aria-hidden />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Receipt size={24} />}
            title={(orders ?? []).length > 0 ? t("orders.noMatches") : t("sales.none")}
            body={t("sales.noneBody")}
            action={
              (orders ?? []).length === 0 ? (
                <Button variant="primary" onClick={() => setAddOpen(true)}>
                  <Plus size={17} />
                  {t("sales.newSale")}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="ac-stagger flex flex-col gap-4">
            {pager.pageRows.map((order) => (
              <Card key={order._id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {(() => {
                    const customerId = customerIdByKey.get(
                      customerKey(order.customerName, order.customerPhone),
                    );
                    const Wrapper = customerId ? "button" : "div";
                    return (
                      <Wrapper
                        type={customerId ? "button" : undefined}
                        onClick={customerId ? () => setViewingCustomer(customerId) : undefined}
                        className={cx(
                          "flex min-w-0 items-start gap-3 rounded-xl text-left",
                          customerId && "-m-1 p-1 transition-colors hover:bg-surface-2",
                        )}
                      >
                        <span
                          className="flex size-10 shrink-0 items-center justify-center rounded-2xl text-[14px] font-bold text-white"
                          style={{ background: gradientFor(order.customerName) }}
                          aria-hidden
                        >
                          {initialOf(order.customerName)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-[15px] font-bold tracking-tight text-ink">
                            {order.customerName}
                          </p>
                          <p className="mt-0.5 text-[12px] text-ink-3">
                            {order.orderNo} · {fmtDateFull(order.orderedAt)}
                            {order.customerPhone ? ` · ${order.customerPhone}` : ""}
                          </p>
                        </div>
                      </Wrapper>
                    );
                  })()}
                  <div className="text-right">
                    <p className="text-[18px] font-bold tabular-nums text-ink">{fmt(order.total)}</p>
                    {isBooked(order) && (
                      <p
                        className={cx(
                          "mt-0.5 text-[11.5px] font-bold tabular-nums",
                          moneyOf(order).profit < 0 ? "text-critical-ink" : "text-good-ink",
                        )}
                      >
                        {moneyOf(order).profit < 0
                          ? `−${fmt(Math.abs(moneyOf(order).profit))}`
                          : `+${fmt(moneyOf(order).profit)}`}{" "}
                        {t("sales.profit").toLowerCase()}
                      </p>
                    )}
                    {order.paymentStatus !== "paid" && (
                      <p className="mt-0.5 text-[11.5px] font-semibold tabular-nums text-critical-ink">
                        {t("orders.remainingDue")}: {fmt(order.total - (order.paidAmount ?? 0))}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap justify-end gap-1.5">
                      <Badge tone={PAYMENT_TONE[order.paymentStatus] ?? "neutral"}>
                        {t(`orders.${order.paymentStatus}` as never)}
                      </Badge>
                      <Badge tone={STATUS_TONE[order.orderStatus] ?? "neutral"}>
                        {t(`orders.${order.orderStatus}` as never)}
                      </Badge>
                    </div>
                  </div>
                </div>

                <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
                  {order.items.map((i, idx) => (
                    <li key={idx} className="flex items-center justify-between gap-3 text-[12.5px]">
                      <span className="min-w-0 truncate text-ink-2">{i.productName}</span>
                      <span className="shrink-0 tabular-nums text-ink-3">
                        {fmtNum(i.quantity)} {i.unit} × {fmt(i.unitPrice)}
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy === order._id}
                    onClick={() =>
                      run(order._id, () => downloadReceipt(toReceipt(order), { bengali }), t("orders.receiptDownloaded"))
                    }
                  >
                    <FileText size={15} />
                    {t("orders.receipt")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void previewReceipt(toReceipt(order), { bengali })}
                  >
                    <Eye size={15} />
                    {t("orders.preview")}
                  </Button>

                  {/*
                    Labelled for the job rather than the noun: this is where
                    you come to change what a customer has paid, and "Payment"
                    alone did not read as something you could press to edit.
                  */}
                  <Button size="sm" variant="secondary" onClick={() => setPaying(order)}>
                    <Pencil size={15} />
                    {t("orders.payment")}
                  </Button>

                  {order.orderStatus === "pending" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === order._id}
                      onClick={() => setPending({ kind: "confirm", order })}
                    >
                      <CheckCircle2 size={15} />
                      {t("orders.confirm")}
                    </Button>
                  )}
                  {/*
                    A cancelled sale used to offer nothing at all, so the only
                    way back was the Undo in a toast that had already gone.
                    The way back belongs on the sale itself, where it is still
                    there tomorrow.
                  */}
                  {order.orderStatus === "cancelled" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === order._id}
                      onClick={() => setPending({ kind: "restore", order })}
                    >
                      <RotateCcw size={15} />
                      {t("orders.restore")}
                    </Button>
                  )}
                  {(order.orderStatus === "confirmed" || order.orderStatus === "delivered") && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === order._id}
                      onClick={() => setPending({ kind: "cancel", order })}
                    >
                      <XCircle size={15} />
                      {t("orders.cancel")}
                    </Button>
                  )}

                  <button
                    onClick={() => setPending({ kind: "delete", order })}
                    aria-label={t("common.delete")}
                    className={cx(
                      "ml-auto rounded-lg p-2 text-ink-3 transition-colors",
                      "hover:bg-surface-2 hover:text-critical",
                    )}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </Card>
            ))}
          </div>

          {pager.pageCount > 1 && (
            <Card>
              <Pagination
                page={pager.page}
                pageCount={pager.pageCount}
                pageSize={pager.pageSize}
                total={pager.total}
                onPage={pager.setPage}
                onPageSize={pager.setPageSize}
                itemLabel="sales"
              />
            </Card>
          )}
        </>
      )}

      <SaleDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <PaymentDialog open={paying !== null} onClose={() => setPaying(null)} order={paying} />
      <CustomerDetailDialog
        open={viewingCustomer !== null}
        onClose={() => setViewingCustomer(null)}
        customerId={viewingCustomer}
      />
      <PasscodeConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={action?.title ?? ""}
        body={
          pending && action
            ? `${pending.order.orderNo} · ${pending.order.customerName} · ${fmt(pending.order.total)}\n${action.body}`
            : ""
        }
        confirmLabel={action?.label}
        tone={action?.tone}
        onConfirm={async (passcode) => {
          if (!pending || !action) return;
          await action.run(pending.order._id, passcode);
          toast.ok(action.done);
        }}
      />
    </div>
  );
}
