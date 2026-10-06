import { useMemo, useState } from "react";
import {
  Boxes,
  CircleDollarSign,
  Landmark,
  Package,
  PackagePlus,
  Plus,
  PiggyBank,
  Receipt,
  TrendingUp,
  Wallet,
  AlertTriangle,
} from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge, Button, Card, CardAction, CardHeader, EmptyState, cx } from "../components/ui";
import { StatTile, type Delta } from "../components/StatTile";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { TrendChart, type TrendPoint } from "../components/charts/TrendChart";
import { TopProductsChart, type TopProduct } from "../components/charts/TopProductsChart";
import { ProductDialog } from "../components/ProductDialog";
import { SaleDialog } from "../components/SaleDialog";
import { ProductDetailDialog } from "../components/ProductDetailDialog";
import { RangePills } from "../components/RangePills";
import { useSettings } from "../lib/settings";
import { useT } from "../lib/i18n";
import { useRangeFilter, DAY } from "../lib/dateRange";
import { gradientFor, initialOf } from "../lib/avatar";
import { plural, relativeTime, startOfLocalDay } from "../lib/format";
import { useAuthedQuery } from "../lib/session";

/** Change as a fraction. Null when the baseline is zero — there is no "% of nothing". */
function change(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export function DashboardPage({ onNavigate }: { onNavigate: (r: "products" | "sales") => void }) {
  const { fmt, fmtNum, fmtPercent } = useSettings();
  const t = useT();
  const data = useAuthedQuery(api.dashboard.overview);
  const investment = useAuthedQuery(api.investment.current);
  const range = useRangeFilter("ac.range.dashboard");
  const [sellOpen, setSellOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [viewing, setViewing] = useState<Id<"products"> | null>(null);

  const scoped = useMemo(() => {
    if (!data) return null;

    const { since, until, untilExclusive, prevSince } = range;

    const rows = data.windowSales.filter((s) => s.soldAt >= since && s.soldAt < untilExclusive);
    // The immediately preceding window of the same length, for the deltas.
    const prevRows = data.windowSales.filter((s) => s.soldAt >= prevSince && s.soldAt < since);
    /*
      Costs answer to the same bounds as the sales. A net figure that took its
      revenue from one range and its costs from another would be wrong in a
      way nothing on the page could reveal.
    */
    const costRows = data.windowCosts.filter(
      (c) => c.spentAt >= since && c.spentAt < untilExclusive,
    );
    const prevCostRows = data.windowCosts.filter(
      (c) => c.spentAt >= prevSince && c.spentAt < since,
    );

    let revenue = 0;
    let profit = 0;
    let units = 0;
    const byDay = new Map<number, { revenue: number; profit: number }>();
    const byProduct = new Map<string, TopProduct>();

    for (const s of rows) {
      revenue += s.revenue;
      profit += s.profit;
      units += s.units;

      const day = startOfLocalDay(s.soldAt);
      const bucket = byDay.get(day) ?? { revenue: 0, profit: 0 };
      bucket.revenue += s.revenue;
      bucket.profit += s.profit;
      byDay.set(day, bucket);

      const agg =
        byProduct.get(s.productId) ??
        ({ productId: s.productId, name: s.productName, revenue: 0, profit: 0, units: 0 } satisfies TopProduct);
      agg.revenue += s.revenue;
      agg.profit += s.profit;
      agg.units += s.units;
      byProduct.set(s.productId, agg);
    }

    let operatingCost = 0;
    for (const c of costRows) operatingCost += c.amount;

    let prevRevenue = 0;
    let prevProfit = 0;
    for (const s of prevRows) {
      prevRevenue += s.revenue;
      prevProfit += s.profit;
    }
    let prevOperatingCost = 0;
    for (const c of prevCostRows) prevOperatingCost += c.amount;

    // Fill every day in the range so the line stays continuous through days
    // with no sales instead of skipping over them.
    const points: TrendPoint[] = [];
    for (let ts = since; ts <= until; ts += DAY) {
      const bucket = byDay.get(ts);
      points.push({ ts, revenue: bucket?.revenue ?? 0, profit: bucket?.profit ?? 0 });
    }

    // Gross profit less the operating costs carried in the same range.
    const net = profit - operatingCost;
    const prevNet = prevProfit - prevOperatingCost;

    return {
      revenue,
      profit,
      operatingCost,
      net,
      units,
      count: rows.length,
      costCount: costRows.length,
      margin: revenue > 0 ? profit / revenue : 0,
      netMargin: revenue > 0 ? net / revenue : 0,
      averageSale: rows.length > 0 ? revenue / rows.length : 0,
      deltaProfit: change(profit, prevProfit),
      deltaRevenue: change(revenue, prevRevenue),
      deltaCount: change(rows.length, prevRows.length),
      deltaUnits: change(units, prevRows.reduce((n, s) => n + s.units, 0)),
      /*
        Spending less is an improvement, so the sign is flipped for the cost
        tile — a month that spent 20% less should not be shown in red with a
        downward arrow as though something had gone wrong.
      */
      deltaCost: change(prevOperatingCost, operatingCost),
      deltaNet: change(net, prevNet),
      points,
      topProducts: [...byProduct.values()].sort((a, b) => b.profit - a.profit).slice(0, 6),
    };
  }, [data, range]);

  if (!data || !scoped) return <DashboardSkeleton />;

  const { inventory, allTime, recentSales } = data;
  const blank = allTime.salesCount === 0 && inventory.productCount === 0;
  const vs = (fraction: number | null): Delta => ({ fraction, label: `vs ${range.activeLabel.prev}` });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] leading-8 font-bold tracking-tight text-ink sm:text-[28px] sm:leading-9">
            {t("dash.title")}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3 sm:text-[14px]">{t("dash.subtitle")}</p>
        </div>
        <div className="flex w-full items-center gap-2.5 sm:w-auto">
          <Button
            variant="secondary"
            onClick={() => setProductOpen(true)}
            className="flex-1 sm:flex-none"
          >
            <PackagePlus size={17} />
            {t("dash.addProduct")}
          </Button>
          <Button
            variant="primary"
            onClick={() => setSellOpen(true)}
            disabled={inventory.inStockCount === 0}
            title={inventory.inStockCount === 0 ? "Add a product with stock first" : undefined}
            className="flex-1 sm:flex-none"
          >
            <Plus size={17} />
            {t("dash.recordSale")}
          </Button>
        </div>
      </div>

      {blank ? (
        <Card>
          <EmptyState
            icon={<Package size={24} />}
            title="Nothing here yet"
            body="Add your first product with a cost price, then record a sale for it. Profit, revenue and stock all follow from those two things."
            action={
              <Button variant="primary" onClick={() => setProductOpen(true)}>
                <PackagePlus size={17} />
                Add your first product
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {/* One filter row, above everything it scopes. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13.5px] text-ink-3">
              {t("dash.showing")}{" "}
              <span className="font-semibold text-ink-2">{range.activeLabel.full}</span>
            </p>
            <RangePills range={range} />
          </div>

          {/*
            Read left to right, the tiles are the income statement: revenue,
            what the goods cost to buy taken off it, the operating costs taken
            off that, and what is left. Units sold and stock follow, because
            they answer a different question from the money.

            Three across rather than four — five money figures at quarter
            width truncate the moment a total reaches six digits.
          */}
          <div className="ac-stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              hero
              accent="sky"
              label={t("dash.revenue")}
              value={<AnimatedNumber value={scoped.revenue} format={fmt} />}
              icon={<CircleDollarSign size={17} />}
              delta={vs(scoped.deltaRevenue)}
              sub={`${fmt(allTime.revenue)} ${t("dash.allTime")}`}
            />
            <StatTile
              accent="violet"
              label={t("dash.grossProfit")}
              value={
                <AnimatedNumber
                  value={scoped.profit}
                  format={(n) => (n < 0 ? `−${fmt(Math.abs(n))}` : fmt(n))}
                />
              }
              icon={<TrendingUp size={17} />}
              delta={vs(scoped.deltaProfit)}
              sub={
                scoped.revenue > 0
                  ? `${fmtPercent(scoped.margin)} ${t("dash.margin")}`
                  : t("dash.grossProfitHint")
              }
            />
            <StatTile
              accent="amber"
              label={t("dash.operatingCost")}
              value={<AnimatedNumber value={scoped.operatingCost} format={fmt} />}
              icon={<Wallet size={17} />}
              delta={vs(scoped.deltaCost)}
              sub={
                scoped.costCount > 0
                  ? `${plural(scoped.costCount, "cost")} · ${fmt(allTime.operatingCost)} ${t("dash.allTime")}`
                  : t("dash.noCosts")
              }
            />
          </div>

          <div className="ac-stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              accent="emerald"
              label={t("dash.netProfit")}
              value={
                <AnimatedNumber
                  value={scoped.net}
                  format={(n) => (n < 0 ? `−${fmt(Math.abs(n))}` : fmt(n))}
                />
              }
              icon={<PiggyBank size={17} />}
              delta={vs(scoped.deltaNet)}
              sub={
                scoped.revenue > 0
                  ? `${fmtPercent(scoped.netMargin)} ${t("dash.margin")}`
                  : t("dash.netProfitHint")
              }
            />
            <StatTile
              accent="violet"
              label={t("dash.unitsSold")}
              value={
                <AnimatedNumber
                  value={scoped.units}
                  format={(n) => `${fmtNum(n)} ${t("common.units")}`}
                />
              }
              icon={<Receipt size={17} />}
              delta={vs(scoped.deltaUnits)}
              sub={
                scoped.count > 0
                  ? `${plural(scoped.count, "sale")} · ${fmt(scoped.averageSale)} ${t("dash.avg")}`
                  : t("dash.noSales")
              }
            />
            <StatTile
              accent="sky"
              label={t("dash.availableStock")}
              value={
                <AnimatedNumber
                  value={inventory.unitsInStock}
                  format={(n) => `${fmtNum(n)} ${t("common.units")}`}
                />
              }
              icon={<Boxes size={17} />}
              sub={`${fmtNum(inventory.inStockCount)} · ${fmt(inventory.inventoryCost)} ${t("dash.atCost")}`}
            />
            {/*
              Rises when stock is bought through the Costs page's "Product
              purchase cost" tab, falls when anything sells — see
              convex/investment.ts. Not the same figure as "Available stock
              at cost": it only moves on those two triggers, so it starts at
              zero and stays wrong until Siyam sets its true starting balance.
            */}
            <StatTile
              accent="amber"
              label={t("dash.investment")}
              value={
                <AnimatedNumber
                  value={investment ?? 0}
                  format={(n) => (n < 0 ? `−${fmt(Math.abs(n))}` : fmt(n))}
                />
              }
              icon={<Landmark size={17} />}
              sub={t("dash.investmentHint")}
            />
          </div>

          <div className="ac-stagger grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title={t("dash.revenueAndProfit")}
                subtitle={`${t("dash.perDay")}, ${range.activeLabel.full}`}
              />
              <TrendChart points={scoped.points} />
            </Card>

            <Card>
              <CardHeader
                title={t("dash.topProducts")}
                subtitle={`${t("dash.byProfit")}, ${range.activeLabel.full}`}
              />
              {scoped.topProducts.length === 0 ? (
                <EmptyState
                  icon={<Receipt size={22} />}
                  title="No sales yet"
                  body="Record a sale and your best earners rank here."
                />
              ) : (
                <TopProductsChart items={scoped.topProducts} />
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title={t("dash.recentSales")}
                subtitle={t("dash.latestActivity")}
                action={<CardAction onClick={() => onNavigate("sales")}>{t("common.viewAll")}</CardAction>}
              />
              {recentSales.length === 0 ? (
                <EmptyState
                  icon={<Receipt size={22} />}
                  title="No sales recorded"
                  body="When you sell something, it shows up here with its profit."
                />
              ) : (
                <ul className="flex flex-col gap-1 px-4 pb-4">
                  {recentSales.map((s) => {
                    const profit = (s.unitPrice - s.unitCost) * s.quantity;
                    return (
                      <li key={s._id}>
                       <button
                        onClick={() => setViewing(s.productId)}
                        className="flex w-full items-center justify-between gap-4 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-surface-2"
                       >
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            className="flex size-9 shrink-0 items-center justify-center rounded-xl text-[13px] font-bold text-white"
                            style={{ background: gradientFor(s.productName) }}
                            aria-hidden
                          >
                            {initialOf(s.productName)}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-[14px] font-semibold text-ink">
                              {s.productName}
                            </p>
                            <p className="mt-0.5 text-[12px] text-ink-3">
                              {relativeTime(s.soldAt)}
                              {s.quantity > 1 && ` · ${s.quantity} units`}
                              {s.buyer && ` · ${s.buyer}`}
                            </p>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-[14px] font-bold tabular-nums text-ink">
                            {fmt(s.unitPrice * s.quantity)}
                          </p>
                          <p
                            className={cx(
                              "mt-0.5 text-[12px] font-semibold tabular-nums",
                              profit < 0 ? "text-critical-ink" : "text-good-ink",
                            )}
                          >
                            {profit < 0 ? `−${fmt(Math.abs(profit))}` : `+${fmt(profit)}`}
                          </p>
                        </div>
                       </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card className="self-start">
              <CardHeader
                title={t("dash.inventory")}
                subtitle={plural(inventory.productCount, "active product")}
                action={<CardAction onClick={() => onNavigate("products")}>{t("common.manage")}</CardAction>}
              />
              <div className="px-6 pb-6">
                <dl className="grid grid-cols-2 gap-3">
                  <MiniStat label={t("dash.inStock")} value={fmtNum(inventory.inStockCount)} />
                  <MiniStat
                    label={t("dash.outOfStock")}
                    value={fmtNum(inventory.outOfStockCount)}
                    alarm={inventory.outOfStockCount > 0}
                  />
                </dl>

                {inventory.lowStock.length > 0 ? (
                  <div className="mt-5">
                    <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-2">
                      <AlertTriangle size={14} className="text-warning" aria-hidden />
                      {t("dash.runningLow")}
                    </p>
                    <ul className="mt-2.5 flex flex-col gap-2">
                      {/* Clickable: a warning that makes you navigate away and
                          find the product yourself is only half a warning. */}
                      {inventory.lowStock.map((p) => (
                        <li key={p._id}>
                          <button
                            onClick={() => setViewing(p._id)}
                            className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 -mx-2 text-left transition-colors hover:bg-surface-2"
                          >
                            <span className="truncate text-[13.5px] text-ink-2">{p.name}</span>
                            <Badge tone="warning">
                              {fmtNum(p.quantity)} {t("products.left")}
                            </Badge>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  inventory.outOfStockCount === 0 && (
                    <p className="mt-5 text-[13px] leading-6 text-ink-3">
                      {t("dash.allStocked")}
                    </p>
                  )
                )}
              </div>
            </Card>
          </div>
        </>
      )}

      <ProductDetailDialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        productId={viewing}
      />
      <ProductDialog open={productOpen} onClose={() => setProductOpen(false)} />
      <SaleDialog open={sellOpen} onClose={() => setSellOpen(false)} />
    </div>
  );
}

function MiniStat({ label, value, alarm }: { label: string; value: string; alarm?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-page px-3.5 py-3">
      <dt className="text-[12px] font-medium text-ink-3">{label}</dt>
      <dd
        className={cx(
          "mt-0.5 text-[20px] leading-7 font-bold tracking-tight",
          alarm ? "text-critical-ink" : "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <div className="ac-skeleton h-10 w-56 rounded-xl bg-surface-2" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="ac-skeleton h-36 rounded-card border border-line bg-surface" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="ac-skeleton h-80 rounded-card border border-line bg-surface lg:col-span-2" />
        <div className="ac-skeleton h-80 rounded-card border border-line bg-surface" />
      </div>
    </div>
  );
}
