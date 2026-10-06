import { mutation, query, type MutationCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireSession, verifyPasscode } from "./auth";
import { adjustInvestment } from "./investment";

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

function validateBatch(quantity: number, unitCost: number, unitPrice?: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ConvexError("Quantity must be more than zero.");
  }
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new ConvexError("Buy price cannot be negative.");
  // Only checked when one was given; leaving it out is allowed.
  if (unitPrice !== undefined && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
    throw new ConvexError("Sell price cannot be negative.");
  }
}

const batchArgs = {
  productId: v.id("products"),
  label: v.string(),
  purchasedAt: v.number(),
  quantity: v.number(),
  unitCost: v.number(),
  unitPrice: v.optional(v.number()),
  note: v.optional(v.string()),
  vendorId: v.optional(v.id("vendors")),
};

async function insertBatch(
  ctx: MutationCtx,
  args: {
    productId: Id<"products">;
    label: string;
    purchasedAt: number;
    quantity: number;
    unitCost: number;
    unitPrice?: number;
    note?: string;
    vendorId?: Id<"vendors">;
  },
  investment: boolean,
) {
  const product = await ctx.db.get(args.productId);
  if (!product) throw new ConvexError("That product no longer exists.");
  validateBatch(args.quantity, args.unitCost, args.unitPrice);
  if (args.vendorId && !(await ctx.db.get(args.vendorId))) {
    throw new ConvexError("That vendor no longer exists.");
  }

  // A lot is stock arriving, so it moves the product's stock with it.
  // Without this the app holds two independent answers to "how many do I
  // have": one the sales decrement, one that only feeds projected profit.
  await ctx.db.patch(args.productId, { quantity: product.quantity + args.quantity });

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
    investment: investment || undefined,
  });
  if (investment) await adjustInvestment(ctx, args.quantity * args.unitCost);
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
    unitPrice: v.optional(v.number()),
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

    // Move stock by the difference only. A deleted product has no stock left
    // to adjust; the lot still edits so history stays intact.
    const delta = args.quantity - batch.quantity;
    if (delta !== 0) {
      const product = await ctx.db.get(batch.productId);
      if (product) {
        if (product.quantity + delta < 0) {
          throw new ConvexError(
            `Reducing this lot would take stock below zero — ${product.quantity} unit(s) remain, and some have already been sold.`,
          );
        }
        await ctx.db.patch(batch.productId, { quantity: product.quantity + delta });
      }
    }

    /*
      Resizing a lot moves what is left by the same amount, so the units
      already sold out of it are not forgotten — buying ten more of a lot that
      has three left leaves thirteen, not ten.
    */
    const soldFrom = batch.quantity - (batch.remaining ?? batch.quantity);
    const note = (args.note ?? "").trim();
    await ctx.db.patch(args.id, {
      label: args.label.trim() || "Stock",
      purchasedAt: args.purchasedAt,
      quantity: args.quantity,
      remaining: Math.max(0, args.quantity - soldFrom),
      unitCost: args.unitCost,
      unitPrice: args.unitPrice,
      note: note ? note : undefined,
      // undefined (field omitted) leaves it alone; null clears it.
      ...(args.vendorId !== undefined ? { vendorId: args.vendorId ?? undefined } : {}),
    });
  },
});

export const removeBatch = mutation({
  args: { token: v.string(), id: v.id("stockBatches"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const batch = await ctx.db.get(args.id);
    if (!batch) return;

    const product = await ctx.db.get(batch.productId);
    if (product) {
      /*
        Only what is still in the lot comes off. Units already sold out of it
        left stock the moment they sold, so subtracting the size it was bought
        at would take them off a second time — which is why this used to
        refuse the delete outright the moment a lot had sold anything, and
        refuse it for an untouched lot whenever a sibling lot of the same
        product had sold enough.

        Clamped at zero because a plain sale does not say which lot it drew
        from, so `remaining` can overstate what is physically there. Stock
        that reads zero is wrong by less than stock that reads below it, and
        far less than a delete the shopkeeper cannot perform at all.
      */
      const left = batch.remaining ?? batch.quantity;
      await ctx.db.patch(batch.productId, {
        quantity: Math.max(0, product.quantity - left),
      });
    }
    // The full amount it added, not just what is left — the rest already
    // came back out of Investment when it sold (see sales.ts / orders.ts).
    if (batch.investment) await adjustInvestment(ctx, -(batch.quantity * batch.unitCost));
    await ctx.db.delete(args.id);
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
          url: await ctx.storage.getUrl(m.storageId),
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
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);

    const rows = await ctx.db.query("stockBatches").withIndex("by_purchasedAt").order("desc").collect();
    /*
      A lot with no sell price of its own is projected at the product's asking
      price, and at cost when there is not one of those either — which shows
      no margin rather than inventing one. Counting it as zero revenue would
      report the whole purchase as a loss, which is worse than saying nothing.
    */
    const askingPrice = new Map<string, number>();
    for (const p of await ctx.db.query("products").collect()) {
      if (p.sellPrice !== undefined) askingPrice.set(p._id as string, p.sellPrice);
    }
    const priceOf = (b: (typeof rows)[number]) =>
      b.unitPrice ?? askingPrice.get(b.productId as string) ?? b.unitCost;
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

      Sales are attributed per product rather than per lot. Deciding which lot
      a given sale drew from would need a FIFO rule this data does not carry,
      and inventing one would make the numbers look more precise than they are.
    */
    const sales = await ctx.db.query("sales").collect();

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
