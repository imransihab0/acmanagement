import { mutation, query, type MutationCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireSession, verifyPasscode } from "./auth";
import { adjustInvestment } from "./investment";
import { syncProduct } from "./stock";

/*
  Profit allocation.

  A stock lot's profit is (unitPrice - unitCost) * quantity. That profit is
  treated as 100% and divided across the allocation buckets. Percentages are
  forced to total 100 on write, so a split can never lose or invent money.

  Profit is derived, never stored: a lot cannot end up disagreeing with its
  own arithmetic the way a hand-kept sheet can.
*/

export const DEFAULT_BUCKETS = [
  { name: "Re-investment (production expansion)", nameBn: "রি-ইনভেস্টমেন্ট (উৎপাদন সম্প্রসারণ)", percent: 30 },
  { name: "Marketing & distribution", nameBn: "মার্কেটিং ও ডিস্ট্রিবিউশন", percent: 20 },
  { name: "Management & operations", nameBn: "ম্যানেজমেন্ট ও পরিচালন ব্যয়", percent: 15 },
  { name: "Emergency fund / cash reserve", nameBn: "জরুরি তহবিল / লিকুইড ক্যাশ রিজার্ভ", percent: 15 },
  { name: "Tax & VAT provision", nameBn: "ট্যাক্স ও ভ্যাট প্রভিশন", percent: 10 },
  { name: "Owner / shareholder dividend", nameBn: "মালিক/শেয়ারহোল্ডার লভ্যাংশ", percent: 7 },
  { name: "Social responsibility (charity)", nameBn: "সামাজিক দায়বদ্ধতা (চ্যারিটি)", percent: 3 },
];

/** Creates the default split the first time it is needed. */
export async function ensureBuckets(ctx: MutationCtx) {
  const existing = await ctx.db.query("allocationBuckets").collect();
  if (existing.length > 0) return existing;
  for (const [index, b] of DEFAULT_BUCKETS.entries()) {
    await ctx.db.insert("allocationBuckets", { ...b, order: index });
  }
  return await ctx.db.query("allocationBuckets").withIndex("by_order").collect();
}

/* ---------------------------------------------------------------- buckets */

export const buckets = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const rows = await ctx.db.query("allocationBuckets").withIndex("by_order").collect();
    // Fall back to the defaults for display until something is written.
    if (rows.length === 0) {
      return DEFAULT_BUCKETS.map((b, i) => ({ ...b, _id: null, order: i }));
    }
    return rows.map((r) => ({
      _id: r._id as string | null,
      name: r.name,
      nameBn: r.nameBn,
      percent: r.percent,
      order: r.order,
    }));
  },
});

export const setBuckets = mutation({
  args: {
    token: v.string(),
    buckets: v.array(v.object({ name: v.string(), nameBn: v.string(), percent: v.number() })),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    if (args.buckets.length === 0) throw new ConvexError("Keep at least one category.");
    for (const b of args.buckets) {
      if (!b.name.trim()) throw new ConvexError("Every category needs a name.");
      if (!Number.isFinite(b.percent) || b.percent < 0) {
        throw new ConvexError("Percentages cannot be negative.");
      }
    }
    const total = args.buckets.reduce((sum, b) => sum + b.percent, 0);
    // Tolerate float dust, reject anything a person would call wrong.
    if (Math.abs(total - 100) > 0.001) {
      throw new ConvexError(`Percentages must total 100%. They currently total ${total}%.`);
    }

    for (const old of await ctx.db.query("allocationBuckets").collect()) {
      await ctx.db.delete(old._id);
    }
    for (const [index, b] of args.buckets.entries()) {
      await ctx.db.insert("allocationBuckets", {
        name: b.name.trim(),
        nameBn: b.nameBn.trim(),
        percent: b.percent,
        order: index,
      });
    }
  },
});

/* ---------------------------------------------------------------- batches */

function validateBatch(quantity: number, unitCost: number, unitPrice: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ConvexError("Quantity must be more than zero.");
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new ConvexError("Buy price cannot be negative.");
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new ConvexError("Sell price cannot be negative.");
}

const batchArgs = {
  productId: v.id("products"),
  label: v.string(),
  purchasedAt: v.number(),
  quantity: v.number(),
  unitCost: v.number(),
  /** What one unit of this lot sells for — a product has no price of its own. */
  unitPrice: v.number(),
  note: v.optional(v.string()),
  vendorId: v.optional(v.id("vendors")),
  /** How much of the lot's cost was paid to the vendor; left out means all of it. */
  vendorPaid: v.optional(v.number()),
};

async function insertBatch(
  ctx: MutationCtx,
  args: {
    productId: Id<"products">;
    label: string;
    purchasedAt: number;
    quantity: number;
    unitCost: number;
    unitPrice: number;
    note?: string;
    vendorId?: Id<"vendors">;
    vendorPaid?: number;
  },
  investment: boolean,
) {
  const product = await ctx.db.get(args.productId);
  if (!product) throw new ConvexError("That product no longer exists.");
  validateBatch(args.quantity, args.unitCost, args.unitPrice);
  if (args.vendorId && !(await ctx.db.get(args.vendorId))) {
    throw new ConvexError("That vendor no longer exists.");
  }
  const total = args.quantity * args.unitCost;
  if (args.vendorPaid !== undefined && (!Number.isFinite(args.vendorPaid) || args.vendorPaid < 0)) {
    throw new ConvexError("Amount paid can't be negative.");
  }

  const note = (args.note ?? "").trim();
  const id = await ctx.db.insert("stockBatches", {
    productId: args.productId,
    productName: product.name,
    label: args.label.trim() || "Stock",
    purchasedAt: args.purchasedAt,
    quantity: args.quantity,
    // A lot starts with everything it was bought with still in it.
    remaining: args.quantity,
    unitCost: args.unitCost,
    unitPrice: args.unitPrice,
    note: note ? note : undefined,
    vendorId: args.vendorId,
    // Only a lot with a vendor can owe one; a full payment is the default.
    vendorPaid:
      args.vendorId && args.vendorPaid !== undefined && args.vendorPaid < total
        ? args.vendorPaid
        : undefined,
    investment: investment || undefined,
  });
  // A lot is stock arriving: the product's stock and prices follow from it.
  await syncProduct(ctx, args.productId);
  // Every lot ties up money in stock, whether it was logged from Products
  // or from Investment's own "Add product purchase" — `investment` only
  // decides which ledger lists it (see `purchaseCostBatches`), not whether
  // it counts here. A sale already comes off Investment no matter which lot
  // it drew from (orders.ts / sales.ts), so a purchase that never added to
  // it in the first place only ever pushed the balance negative.
  await adjustInvestment(ctx, args.quantity * args.unitCost);
  return id;
}

export const addBatch = mutation({
  args: { token: v.string(), ...batchArgs },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await insertBatch(ctx, args, false);
  },
});

/*
  Same write as `addBatch` — a lot still arrives and stock still moves — but
  triggered from the Costs page's "Product purchase cost" tab instead of
  Products. The difference is what else moves: this is money the shopkeeper
  thinks of as a cost, so it adds to Investment instead of to `costs` (which
  would double it against Total cost, since a lot's price is recovered
  through margin, not booked as an expense).
*/
export const addPurchaseCostBatch = mutation({
  args: { token: v.string(), ...batchArgs },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await insertBatch(ctx, args, true);
  },
});

/** Lots logged through the Investment flow, newest first. */
export const purchaseCostBatches = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const rows = await ctx.db.query("stockBatches").withIndex("by_purchasedAt").order("desc").collect();
    return rows.filter((r) => r.investment);
  },
});

export const updateBatch = mutation({
  args: {
    token: v.string(),
    id: v.id("stockBatches"),
    label: v.string(),
    purchasedAt: v.number(),
    quantity: v.number(),
    unitCost: v.number(),
    unitPrice: v.number(),
    note: v.optional(v.string()),
    /** Omit the field to leave the vendor as-is; pass null to clear it. */
    vendorId: v.optional(v.union(v.id("vendors"), v.null())),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const batch = await ctx.db.get(args.id);
    if (!batch) throw new ConvexError("That stock lot no longer exists.");
    validateBatch(args.quantity, args.unitCost, args.unitPrice);
    if (args.vendorId && !(await ctx.db.get(args.vendorId))) {
      throw new ConvexError("That vendor no longer exists.");
    }

    const soldFrom = batch.quantity - (batch.remaining ?? batch.quantity);
    if (args.quantity < soldFrom) {
      throw new ConvexError(
        `${soldFrom} unit(s) of this lot have already been sold, so it can't be less than that.`,
      );
    }

    // Keep Investment in step with whatever this edit changes — a lot
    // resized or re-priced moves the same money Investment was already
    // counting it as.
    const investedBefore = batch.quantity * batch.unitCost;
    const investedAfter = args.quantity * args.unitCost;
    if (investedAfter !== investedBefore) {
      await adjustInvestment(ctx, investedAfter - investedBefore);
    }

    /*
      Resizing a lot moves what is left by the same amount, so the units
      already sold out of it are not forgotten — buying ten more of a lot that
      has three left leaves thirteen, not ten.
    */
    const note = (args.note ?? "").trim();
    await ctx.db.patch(args.id, {
      label: args.label.trim() || "Stock",
      purchasedAt: args.purchasedAt,
      quantity: args.quantity,
      // A lot taken off its product stays empty whatever its size says.
      remaining: batch.removedAt ? 0 : args.quantity - soldFrom,
      unitCost: args.unitCost,
      unitPrice: args.unitPrice,
      // A resized lot never claims more was paid than it now costs.
      vendorPaid:
        batch.vendorPaid !== undefined && batch.vendorPaid < investedAfter ? batch.vendorPaid : undefined,
      note: note ? note : undefined,
      // undefined (field omitted) leaves it alone; null clears it.
      ...(args.vendorId !== undefined ? { vendorId: args.vendorId ?? undefined } : {}),
    });
    await syncProduct(ctx, batch.productId);
  },
});

export async function removeLot(ctx: MutationCtx, id: Id<"stockBatches">, mode: "remove" | "delete") {
  const batch = await ctx.db.get(id);
  if (!batch) return;

  if (mode === "remove") {
    if (batch.removedAt) return;
    const left = batch.remaining ?? batch.quantity;
    const now = Date.now();
    if (left > 0) {
      const loss = left * batch.unitCost;
      await ctx.db.insert("costs", {
        name: `Stock write-off: ${batch.productName}`,
        amount: loss,
        spentAt: now,
        note: `${batch.label} · ${left} unit(s) at ${batch.unitCost}`,
        createdAt: now,
      });
      // The stock is gone, so the money tied up in it is too.
      await adjustInvestment(ctx, -loss);
    }
    await ctx.db.patch(id, { removedAt: now, writtenOff: left, remaining: 0 });
    await syncProduct(ctx, batch.productId);
    return;
  }

  // The full amount it added, not just what is left — the rest already
  // came back out of Investment when it sold (see orders.ts).
  await adjustInvestment(ctx, -(batch.quantity * batch.unitCost));
  await ctx.db.delete(id);
  // What was left in it leaves stock with it; units already sold from it
  // left when they sold.
  await syncProduct(ctx, batch.productId);
}

/**
 * Takes a lot away, one of two ways:
 *
 * - "remove": off its product, but kept everywhere else. It was a real
 *   purchase, so it stays in the vendor's history; whatever was still in it
 *   (spoiled, lost) is booked as a cost today, so Net profit carries the loss.
 * - "delete": gone everywhere, for a lot that was entered by mistake.
 */
export const removeBatch = mutation({
  args: {
    token: v.string(),
    id: v.id("stockBatches"),
    passcode: v.string(),
    mode: v.optional(v.union(v.literal("remove"), v.literal("delete"))),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    await removeLot(ctx, args.id, args.mode ?? "delete");
  },
});

/** Records a payment to the vendor against one lot, capped at what the lot cost. */
export const payVendor = mutation({
  args: { token: v.string(), id: v.id("stockBatches"), amount: v.number() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const lot = await ctx.db.get(args.id);
    if (!lot) throw new ConvexError("That stock lot no longer exists.");
    if (!Number.isFinite(args.amount) || args.amount <= 0) {
      throw new ConvexError("Enter how much was paid.");
    }
    const total = lot.quantity * lot.unitCost;
    const paid = Math.min(total, (lot.vendorPaid ?? total) + args.amount);
    await ctx.db.patch(args.id, { vendorPaid: paid >= total ? undefined : paid });
    return { due: total - paid };
  },
});

/**
 * One lot in full: its own numbers, the vendor it was bought from (if any),
 * and the receipts/photos/videos attached to this specific purchase.
 */
export const lotDetail = query({
  args: { token: v.string(), id: v.id("stockBatches") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const lot = await ctx.db.get(args.id);
    if (!lot) return null;

    const vendor = lot.vendorId ? await ctx.db.get(lot.vendorId) : null;
    const mediaRows = lot.mediaIds?.length
      ? await Promise.all(lot.mediaIds.map((id) => ctx.db.get(id)))
      : [];
    const media = await Promise.all(
      mediaRows
        .filter((m): m is NonNullable<typeof m> => m !== null)
        .map(async (m) => ({
          _id: m._id,
          kind: m.kind,
          fileName: m.fileName,
          url: m.url ?? (m.storageId ? await ctx.storage.getUrl(m.storageId) : null),
        })),
    );

    return { lot, vendor, media };
  },
});

/**
 * Links a file already in the vendor's gallery to this lot — attaching a
 * receipt that was uploaded for a different purchase, say. Never uploads
 * anything; that's `vendors.attachMedia`, called first when the file is new.
 */
export const attachLotMedia = mutation({
  args: { token: v.string(), lotId: v.id("stockBatches"), mediaId: v.id("vendorMedia") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const lot = await ctx.db.get(args.lotId);
    if (!lot) throw new ConvexError("That stock lot no longer exists.");
    const media = await ctx.db.get(args.mediaId);
    if (!media) throw new ConvexError("That file no longer exists.");
    if (lot.vendorId && media.vendorId !== lot.vendorId) {
      throw new ConvexError("That file belongs to a different vendor.");
    }
    const existing = lot.mediaIds ?? [];
    if (existing.includes(args.mediaId)) return;
    await ctx.db.patch(args.lotId, { mediaIds: [...existing, args.mediaId] });
  },
});

/**
 * Unlinks a file from this lot. The file itself — and its place in the
 * vendor's gallery — is untouched; delete it from there if it should be gone
 * for good.
 */
export const removeLotMedia = mutation({
  args: { token: v.string(), lotId: v.id("stockBatches"), mediaId: v.id("vendorMedia") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const lot = await ctx.db.get(args.lotId);
    if (!lot?.mediaIds) return;
    await ctx.db.patch(args.lotId, {
      mediaIds: lot.mediaIds.filter((m) => m !== args.mediaId),
    });
  },
});

/**
 * Lots with stock still in them, newest purchase last so the oldest is the
 * natural first pick. What a shop wants at the counter is "which price am I
 * selling out of", and that is a different question from the ledger below.
 */
export const openLots = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const rows = await ctx.db.query("stockBatches").withIndex("by_purchasedAt").collect();
    return rows
      .map((b) => ({
        id: b._id,
        productId: b.productId,
        label: b.label,
        purchasedAt: b.purchasedAt,
        unitCost: b.unitCost,
        unitPrice: b.unitPrice,
        remaining: b.remaining ?? b.quantity,
        quantity: b.quantity,
      }))
      .filter((b) => b.remaining > 0);
  },
});

/* ---------------------------------------------------------------- summary */

/**
 * Every stock lot, its derived profit, and the profit grouped by product.
 * The percentage split itself is applied on the client so the same numbers
 * drive the totals, each product and each individual lot without three
 * separate round trips.
 */
export const summary = query({
  args: {
    token: v.string(),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    const hasFrom = args.from !== undefined && args.from > 0;
    const hasTo = args.to !== undefined && args.to < Number.MAX_SAFE_INTEGER;

    // Use indexed bounds for stock lots if a date range is given
    const rows = hasFrom || hasTo
      ? await ctx.db
          .query("stockBatches")
          .withIndex("by_purchasedAt", (q) => {
            if (hasFrom && hasTo) {
              return q.gte("purchasedAt", args.from!).lte("purchasedAt", args.to!);
            }
            if (hasFrom) {
              return q.gte("purchasedAt", args.from!);
            }
            return q.lte("purchasedAt", args.to!);
          })
          .order("desc")
          .collect()
      : await ctx.db.query("stockBatches").withIndex("by_purchasedAt").order("desc").collect();
    /*
      Profit is projected at the lot's own sell price, and at cost for an old
      lot that has none, which shows no margin rather than inventing one.
      Counting it as zero revenue would report the whole purchase as a loss,
      which is worse than saying nothing.
    */
    const priceOf = (b: (typeof rows)[number]) => b.unitPrice ?? b.unitCost;
    const bucketRows = await ctx.db.query("allocationBuckets").withIndex("by_order").collect();
    const buckets =
      bucketRows.length > 0
        ? bucketRows.map((b) => ({ name: b.name, nameBn: b.nameBn, percent: b.percent }))
        : DEFAULT_BUCKETS;

    const batches = rows.map((b) => {
      const unitPrice = priceOf(b);
      const unitProfit = unitPrice - b.unitCost;
      return {
        id: b._id as string,
        productId: b.productId as string,
        productName: b.productName,
        label: b.label,
        purchasedAt: b.purchasedAt,
        quantity: b.quantity,
        remaining: b.remaining ?? b.quantity,
        unitCost: b.unitCost,
        unitPrice: b.unitPrice,
        projectedPrice: unitPrice,
        note: b.note,
        vendorId: b.vendorId,
        unitProfit,
        totalCost: b.unitCost * b.quantity,
        totalRevenue: unitPrice * b.quantity,
        totalProfit: unitProfit * b.quantity,
      };
    });

    let totalProfit = 0;
    let totalCost = 0;
    let totalRevenue = 0;
    for (const b of batches) {
      totalProfit += b.totalProfit;
      totalCost += b.totalCost;
      totalRevenue += b.totalRevenue;
    }

    /*
      Realised profit — money actually taken, from recorded sales — alongside
      the projected figure above. Keeping both apart matters: budgeting a
      percentage of profit that has not been earned yet is how a split like
      this quietly overspends.

      Indexed by soldAt to prevent unbounded table reads when scoped by date.
    */
    const sales = hasFrom || hasTo
      ? await ctx.db
          .query("sales")
          .withIndex("by_soldAt", (q) => {
            if (hasFrom && hasTo) {
              return q.gte("soldAt", args.from!).lte("soldAt", args.to!);
            }
            if (hasFrom) {
              return q.gte("soldAt", args.from!);
            }
            return q.lte("soldAt", args.to!);
          })
          .order("desc")
          .collect()
      : await ctx.db.query("sales").withIndex("by_soldAt").order("desc").collect();

    return {
      buckets,
      batches,
      /*
        One dated row per sale rather than a pre-aggregated total. The page
        filters by date, and a figure summed here could not be re-scoped
        client-side without a second round trip.
      */
      sales: sales.map((s) => ({
        productId: s.productId as string,
        soldAt: s.soldAt,
        units: s.quantity,
        revenue: s.unitPrice * s.quantity,
        profit: (s.unitPrice - s.unitCost) * s.quantity,
      })),
      totals: {
        profit: totalProfit,
        cost: totalCost,
        revenue: totalRevenue,
        lots: batches.length,
        margin: totalRevenue > 0 ? totalProfit / totalRevenue : 0,
      },
    };
  },
});
