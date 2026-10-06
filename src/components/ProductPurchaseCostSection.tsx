import { useMemo, useState } from "react";
import { Hash, Landmark, Plus, Trash2 } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button, Card, CardHeader, EmptyState } from "./ui";
import { StatTile } from "./StatTile";
import { RangePills } from "./RangePills";
import { ProductPurchaseDialog } from "./ProductPurchaseDialog";
import { PasscodeConfirmDialog } from "./PasscodeConfirmDialog";
import { useSettings } from "../lib/settings";
import { useT } from "../lib/i18n";
import { useRangeFilter } from "../lib/dateRange";
import { useToast } from "../lib/toast";
import { useAuthedMutation, useAuthedQuery } from "../lib/session";

/**
 * Stock bought and logged as an investment rather than an operating cost —
 * same underlying lot `BatchDialog` writes, filtered to the ones tagged
 * `investment`. Deleting one here reverses it out of the Investment balance
 * the same way `removeBatch` already reverses stock; see profit.ts.
 */
export function ProductPurchaseCostSection() {
  const { fmt, fmtNum, fmtDateTime } = useSettings();
  const t = useT();
  const toast = useToast();
  const all = useAuthedQuery(api.profit.purchaseCostBatches, {});
  const remove = useAuthedMutation(api.profit.removeBatch);
  const range = useRangeFilter("ac.range.investment");

  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<Doc<"stockBatches"> | null>(null);

  const rows = useMemo(
    () => (all ?? []).filter((r) => r.purchasedAt >= range.since && r.purchasedAt < range.untilExclusive),
    [all, range.since, range.untilExclusive],
  );

  const total = useMemo(() => rows.reduce((sum, r) => sum + r.quantity * r.unitCost, 0), [rows]);

  /*
    Which product the money went into, the same question "Where it went"
    answers for regular expenses — a flat list of entries doesn't say it, and
    a single total answers only half of it.
  */
  const byProduct = useMemo(() => {
    const groups = new Map<string, { name: string; amount: number; count: number }>();
    for (const r of rows) {
      const entry = groups.get(r.productName) ?? { name: r.productName, amount: 0, count: 0 };
      entry.amount += r.quantity * r.unitCost;
      entry.count += 1;
      groups.set(r.productName, entry);
    }
    return [...groups.values()].sort((a, b) => b.amount - a.amount);
  }, [rows]);

  return (
    <>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setAddOpen(true)}>
          <Plus size={17} />
          {t("investment.add")}
        </Button>
      </div>

      {/* Same row as every other page's date filter: a label on the left, RangePills on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-ink-3">
          {t("investment.totalLogged")}{" "}
          <span className="font-semibold text-ink-2">{range.activeLabel.full}</span>
        </p>
        <RangePills range={range} />
      </div>

      <div className="ac-stagger grid gap-4 sm:grid-cols-2">
        <StatTile
          hero
          accent="amber"
          label={t("investment.totalLogged")}
          value={fmt(total)}
          icon={<Landmark size={17} />}
          sub={range.activeLabel.full}
        />
        <StatTile
          accent="violet"
          label={t("costs.entries")}
          value={fmtNum(rows.length)}
          icon={<Hash size={17} />}
        />
      </div>

      {byProduct.length > 0 && (
        <Card>
          <CardHeader title={t("investment.whereItWent")} subtitle={t("costs.whereItWentSub")} />
          <ul className="flex flex-col gap-3 px-5 pb-5 sm:px-6 sm:pb-6">
            {byProduct.slice(0, 6).map((g) => {
              const share = total > 0 ? g.amount / total : 0;
              return (
                <li key={g.name} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">
                      {g.name}
                    </span>
                    <span className="shrink-0 text-[13.5px] font-bold tabular-nums text-ink">
                      {fmt(g.amount)}
                      <span className="ml-2 text-[11.5px] font-semibold text-ink-3">
                        {fmtNum(g.count)}×
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div
                      className="h-full rounded-full transition-[width] duration-500 ease-[var(--ease-out)]"
                      style={{ width: `${Math.max(share * 100, 1.5)}%`, background: "var(--grad-amber)" }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card>
        {all === undefined ? (
          <div className="ac-skeleton h-72 rounded-card bg-surface" aria-hidden />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Landmark size={24} />}
            title={(all?.length ?? 0) > 0 ? t("costs.noMatches") : t("investment.none")}
            body={
              (all?.length ?? 0) > 0
                ? "Try a wider date range."
                : t("investment.noneBody")
            }
            action={
              (all?.length ?? 0) === 0 ? (
                <Button variant="primary" onClick={() => setAddOpen(true)}>
                  <Plus size={17} />
                  {t("investment.add")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((r) => (
              <li key={r._id} className="flex items-start gap-3 px-4 py-4 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-ink">{r.productName}</p>
                  <p className="mt-0.5 text-[12px] text-ink-3">
                    {fmtDateTime(r.purchasedAt)} · {fmtNum(r.quantity)} × {fmt(r.unitCost)}
                  </p>
                  {r.note && <p className="mt-1 text-[12.5px] text-ink-3">{r.note}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[14px] font-bold tabular-nums text-ink">
                    {fmt(r.quantity * r.unitCost)}
                  </span>
                  <button
                    onClick={() => setDeleting(r)}
                    aria-label={`${t("common.delete")} ${r.productName}`}
                    className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-2 hover:text-critical"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ProductPurchaseDialog open={addOpen} onClose={() => setAddOpen(false)} />

      <PasscodeConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t("investment.deleteTitle")}
        body={
          deleting
            ? `${deleting.productName} — ${fmt(deleting.quantity * deleting.unitCost)} comes off Investment, and its stock comes off the product.`
            : ""
        }
        onConfirm={async (passcode) => {
          if (!deleting) return;
          await remove({ id: deleting._id, passcode });
          toast.ok(t("investment.deleted"));
        }}
      />
    </>
  );
}
