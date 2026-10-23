import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./auth";
import { allRowsForDashboard } from "./fixedCosts";

const LOW_STOCK_AT = 3;

/**
 * Everything the dashboard renders, scoped to the active time range.
 *
 * Range-scoped numbers are deliberately not aggregated on all-time history:
 * bucketing by calendar day and applying the date filter happens in the browser's
 * timezone. This query returns only the window needed by the active range filter,
 * eliminating full-table scans on every page reload and drastically reducing I/O.
 */
export const overview = query({
  args: { token: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    // Products table stores cached quantity and costPrice maintained by syncProduct (stock.ts).
    // Avoiding withBatchLotStock eliminates full-table scans of stockBatches on every dashboard load.
    const products = await ctx.db.query("products").collect();

    // Default to 60 days of window if not provided, or client range's since (plus buffer for deltas)
    const now = Date.now();
    const defaultSince = now - 60 * 24 * 60 * 60 * 1000;
    const since = args.since ?? defaultSince;

    // Query sales and costs inside the active window using index ranges
    const windowSalesRaw = await ctx.db
      .query("sales")
      .withIndex("by_soldAt", (q) => q.gte("soldAt", since))
      .order("desc")
      .collect();

    const windowCostsRaw = await ctx.db
      .query("costs")
      .withIndex("by_spentAt", (q) => q.gte("spentAt", since))
      .order("desc")
      .collect();

    /*
      Fixed costs — rent, wifi, salary — booked once a month rather than logged
      as they happen. Filtered to the active window.
    */
    const fixedCostRows = await allRowsForDashboard(ctx);
    const windowFixedCosts = fixedCostRows.filter((c) => c.spentAt >= since);

    let revenue = 0;
    let cost = 0;
    let unitsSold = 0;
    for (const s of windowSalesRaw) {
      revenue += s.unitPrice * s.quantity;
      cost += s.unitCost * s.quantity;
      unitsSold += s.quantity;
    }

    const windowCosts = windowCostsRaw.map((c) => ({
      id: c._id as string,
      name: c.name,
      spentAt: c.spentAt,
      amount: c.amount,
    }));
    const allCosts = [
      ...windowCosts,
      ...windowFixedCosts,
    ].sort((a, b) => b.spentAt - a.spentAt);

    let operatingCost = 0;
    for (const c of allCosts) operatingCost += c.amount;

    const active = products.filter((p) => !p.archived);
    let unitsInStock = 0;
    let inventoryCost = 0;
    for (const p of active) {
      unitsInStock += p.quantity;
      inventoryCost += p.quantity * p.costPrice;
    }

    const totalSalesCount = windowSalesRaw.length;

    return {
      allTime: {
        revenue,
        cost,
        profit: revenue - cost,
        operatingCost,
        net: revenue - cost - operatingCost,
        margin: revenue > 0 ? (revenue - cost) / revenue : 0,
        netMargin: revenue > 0 ? (revenue - cost - operatingCost) / revenue : 0,
        salesCount: totalSalesCount,
        unitsSold,
        costsCount: allCosts.length,
      },
      inventory: {
        productCount: active.length,
        archivedCount: products.length - active.length,
        unitsInStock,
        inventoryCost,
        inStockCount: active.filter((p) => p.quantity > 0).length,
        outOfStockCount: active.filter((p) => p.quantity === 0).length,
        lowStock: active
          .filter((p) => p.quantity > 0 && p.quantity <= LOW_STOCK_AT)
          .sort((a, b) => a.quantity - b.quantity)
          .slice(0, 6),
      },
      recentSales: windowSalesRaw.slice(0, 8),
      windowSales: windowSalesRaw.map((s) => ({
        id: s._id as string,
        productId: s.productId as string,
        productName: s.productName,
        soldAt: s.soldAt,
        units: s.quantity,
        revenue: s.unitPrice * s.quantity,
        profit: (s.unitPrice - s.unitCost) * s.quantity,
      })),
      windowCosts: allCosts,
      windowDays: Math.ceil((now - since) / (24 * 60 * 60 * 1000)),
    };
  },
});
