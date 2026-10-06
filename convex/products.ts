import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireSession, verifyPasscode } from "./auth";

/** Attaches a signed, short-lived photo URL to a product row — the stored `photoId` is never useful to the browser on its own. */
async function withPhoto<T extends { photoId?: Id<"_storage"> }>(ctx: QueryCtx, p: T) {
  const photoUrl = p.photoId ? await ctx.storage.getUrl(p.photoId) : null;
  return { ...p, photoUrl };
}

export const list = query({
  args: {
    token: v.string(),
    search: v.optional(v.string()),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const all = await ctx.db.query("products").withIndex("by_createdAt").order("desc").collect();
    const term = (args.search ?? "").trim().toLowerCase();
    const filtered = all.filter((p) => {
      if (!args.includeArchived && p.archived) return false;
      if (!term) return true;
      return (
        p.name.toLowerCase().includes(term) ||
        p.details.toLowerCase().includes(term) ||
        (p.category ?? "").toLowerCase().includes(term)
      );
    });
    return await Promise.all(filtered.map((p) => withPhoto(ctx, p)));
  },
});

export const get = query({
  args: { token: v.string(), id: v.id("products") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const product = await ctx.db.get(args.id);
    return product ? await withPhoto(ctx, product) : null;
  },
});

/**
 * One row per sale in the last year, with nothing but what a per-product
 * profit-by-range card needs. Same shape as the Dashboard's own window
 * query, and for the same reason: bucketing by a date range picked in the
 * browser has to happen in the browser, not in a query that does not know
 * the browser's timezone.
 */
export const salesWindow = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const since = Date.now() - 366 * 24 * 60 * 60 * 1000;
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_soldAt", (q) => q.gte("soldAt", since))
      .collect();
    return sales.map((s) => ({
      productId: s.productId as string,
      profit: (s.unitPrice - s.unitCost) * s.quantity,
      soldAt: s.soldAt,
    }));
  },
});

/** A one-time URL the browser can POST a photo to directly. */
export const generateUploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Points a product at a newly uploaded photo, replacing whichever one it had.
 * The old file is deleted rather than left behind — nothing else can ever
 * reference it, since the product row was its only pointer.
 */
export const setPhoto = mutation({
  args: { token: v.string(), id: v.id("products"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const product = await ctx.db.get(args.id);
    if (!product) throw new ConvexError("That product no longer exists.");
    await ctx.db.patch(args.id, { photoId: args.storageId });
    if (product.photoId) await ctx.storage.delete(product.photoId);
  },
});

export const removePhoto = mutation({
  args: { token: v.string(), id: v.id("products") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const product = await ctx.db.get(args.id);
    if (!product) throw new ConvexError("That product no longer exists.");
    if (product.photoId) {
      await ctx.db.patch(args.id, { photoId: undefined });
      await ctx.storage.delete(product.photoId);
    }
  },
});

/** Distinct categories, for the filter dropdown and the category input's datalist. */
export const categories = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const all = await ctx.db.query("products").collect();
    const set = new Set<string>();
    for (const p of all) {
      const c = (p.category ?? "").trim();
      if (c) set.add(c);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  },
});

function validate(name: string, costPrice: number, quantity: number, sellPrice?: number) {
  if (!name.trim()) throw new ConvexError("Product name is required.");
  if (!Number.isFinite(costPrice) || costPrice < 0) {
    throw new ConvexError("Cost price must be zero or more.");
  }
  if (sellPrice !== undefined && (!Number.isFinite(sellPrice) || sellPrice < 0)) {
    throw new ConvexError("Sell price must be zero or more.");
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new ConvexError("Quantity must be a whole number, zero or more.");
  }
}

const variantInput = v.object({
  id: v.string(),
  label: v.string(),
  costPrice: v.number(),
  sellPrice: v.optional(v.number()),
  quantity: v.optional(v.number()),
  baseQuantity: v.optional(v.number()),
});
type VariantInput = {
  id: string;
  label: string;
  costPrice: number;
  sellPrice?: number;
  quantity?: number;
  baseQuantity?: number;
};
type StockMode = "separate" | "shared";

/**
 * A product with no variants keeps its three plain fields, exactly as
 * before. One with variants gets them computed instead — the admin edits
 * sizes, never these — so every screen that only knows about a flat
 * cost/sell/quantity (the Dashboard, the sort by profit, the CSV import)
 * keeps working without having to learn what a variant is.
 */
function validateVariants(variants: VariantInput[] | undefined, stockMode: StockMode | undefined) {
  if (!variants || variants.length === 0) return;
  if (stockMode !== "separate" && stockMode !== "shared") {
    throw new ConvexError("Choose how stock is tracked for these sizes.");
  }
  for (const variant of variants) {
    const label = variant.label.trim() || "A size";
    if (!variant.label.trim()) throw new ConvexError("Every size needs a name.");
    if (!Number.isFinite(variant.costPrice) || variant.costPrice < 0) {
      throw new ConvexError(`${label}: cost price must be zero or more.`);
    }
    if (variant.sellPrice !== undefined && (!Number.isFinite(variant.sellPrice) || variant.sellPrice < 0)) {
      throw new ConvexError(`${label}: sell price must be zero or more.`);
    }
    if (stockMode === "separate") {
      const qty = variant.quantity ?? 0;
      if (!Number.isInteger(qty) || qty < 0) {
        throw new ConvexError(`${label}: stock must be a whole number, zero or more.`);
      }
    } else {
      if (!Number.isFinite(variant.baseQuantity) || (variant.baseQuantity ?? 0) <= 0) {
        throw new ConvexError(`${label}: needs how much of the base stock one of these is.`);
      }
    }
  }
}

/**
 * Cost price is the lowest size's — the figure every other screen treats as
 * "what this costs" has to mean something real, and the cheapest size is the
 * only one true of all of them. Sell price the same, when any size has one.
 * Quantity is the sum of the sizes in "separate" mode; in "shared" mode the
 * admin's own total stands, since the sizes do not have stock of their own.
 */
function effectiveFromVariants(
  variants: VariantInput[],
  stockMode: StockMode,
  fallbackQuantity: number,
) {
  const costPrice = Math.min(...variants.map((v) => v.costPrice));
  const sellCandidates = variants
    .map((v) => v.sellPrice)
    .filter((p): p is number => p !== undefined);
  const sellPrice = sellCandidates.length > 0 ? Math.min(...sellCandidates) : undefined;
  const quantity =
    stockMode === "separate"
      ? variants.reduce((sum, v) => sum + (v.quantity ?? 0), 0)
      : fallbackQuantity;
  return { costPrice, sellPrice, quantity };
}

function cleanVariants(variants: VariantInput[] | undefined) {
  return variants && variants.length > 0
    ? variants.map((v) => ({
        id: v.id,
        label: v.label.trim(),
        costPrice: v.costPrice,
        sellPrice: v.sellPrice,
        quantity: v.quantity,
        baseQuantity: v.baseQuantity,
      }))
    : undefined;
}

export const create = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    costPrice: v.number(),
    /*
      The price an order fills in for this product. Optional because it was
      added after the first products were, and because a product you only ever
      quote by hand does not need one.
    */
    sellPrice: v.optional(v.number()),
    details: v.string(),
    category: v.optional(v.string()),
    quantity: v.number(),
    variants: v.optional(v.array(variantInput)),
    stockMode: v.optional(v.union(v.literal("separate"), v.literal("shared"))),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const variants = cleanVariants(args.variants);
    validateVariants(variants, args.stockMode);
    const effective = variants
      ? effectiveFromVariants(variants, args.stockMode as StockMode, args.quantity)
      : { costPrice: args.costPrice, sellPrice: args.sellPrice, quantity: args.quantity };
    validate(args.name, effective.costPrice, effective.quantity, effective.sellPrice);
    const category = (args.category ?? "").trim();
    return await ctx.db.insert("products", {
      name: args.name.trim(),
      costPrice: effective.costPrice,
      sellPrice: effective.sellPrice,
      details: args.details.trim(),
      category: category ? category : undefined,
      quantity: effective.quantity,
      variants,
      stockMode: variants ? (args.stockMode as StockMode) : undefined,
      archived: false,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    id: v.id("products"),
    name: v.string(),
    costPrice: v.number(),
    sellPrice: v.optional(v.number()),
    details: v.string(),
    category: v.optional(v.string()),
    quantity: v.number(),
    variants: v.optional(v.array(variantInput)),
    stockMode: v.optional(v.union(v.literal("separate"), v.literal("shared"))),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("That product no longer exists.");
    const variants = cleanVariants(args.variants);
    validateVariants(variants, args.stockMode);
    const effective = variants
      ? effectiveFromVariants(variants, args.stockMode as StockMode, args.quantity)
      : { costPrice: args.costPrice, sellPrice: args.sellPrice, quantity: args.quantity };
    validate(args.name, effective.costPrice, effective.quantity, effective.sellPrice);
    const category = (args.category ?? "").trim();
    await ctx.db.patch(args.id, {
      name: args.name.trim(),
      costPrice: effective.costPrice,
      // Undefined clears it, which is what emptying the field means.
      sellPrice: effective.sellPrice,
      details: args.details.trim(),
      category: category ? category : undefined,
      quantity: effective.quantity,
      variants,
      stockMode: variants ? (args.stockMode as StockMode) : undefined,
    });
  },
});

/**
 * Sets stock to an exact count, rather than nudging it by one — so it needs
 * the passcode the way other destructive-ish corrections do (nothing stops
 * the new count from quietly erasing units a +/- stepper would have caught
 * one click at a time).
 */
export const setStock = mutation({
  args: { token: v.string(), id: v.id("products"), quantity: v.number(), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const product = await ctx.db.get(args.id);
    if (!product) throw new ConvexError("That product no longer exists.");
    if (!Number.isInteger(args.quantity) || args.quantity < 0) {
      throw new ConvexError("Stock must be a whole number, zero or more.");
    }
    /*
      A product with sizes has no stock of its own to set — `quantity` is
      computed from the sizes (their sum in "separate" mode, the admin's own
      pool in "shared" mode), and overwriting it directly here would disagree
      with that the moment the page next recomputed it. The UI never offers
      this for such a product; this is the same rule enforced server-side,
      since the mutation itself has no other way to know which size this was.
    */
    if (product.variants?.length) {
      throw new ConvexError("This product sells in sizes — edit the size's own stock instead.");
    }
    await ctx.db.patch(args.id, { quantity: args.quantity });
  },
});

export const setArchived = mutation({
  args: { token: v.string(), id: v.id("products"), archived: v.boolean() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await ctx.db.patch(args.id, { archived: args.archived });
  },
});

/**
 * Deletes the product and its stock lots.
 *
 * Sales are deliberately kept: they snapshot the name and cost they were sold
 * at, so revenue and profit history stay true. Stock lots are the opposite —
 * they describe inventory you hold, so leaving them behind would keep counting
 * a product you no longer stock toward your projected profit.
 */
export const remove = mutation({
  args: { token: v.string(), id: v.id("products"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const lots = await ctx.db
      .query("stockBatches")
      .withIndex("by_product", (q) => q.eq("productId", args.id))
      .collect();
    for (const lot of lots) await ctx.db.delete(lot._id);
    await ctx.db.delete(args.id);
    return { removedLots: lots.length };
  },
});

/**
 * Everything about one product: its stock lots, its sales, and the totals
 * that follow. Backs the product detail view, so "how has this actually
 * done" is answerable without scanning the whole ledger by eye.
 */
export const detail = query({
  args: { token: v.string(), id: v.id("products") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const product = await ctx.db.get(args.id);
    if (!product) return null;

    const [lots, sales] = await Promise.all([
      ctx.db
        .query("stockBatches")
        .withIndex("by_product", (q) => q.eq("productId", args.id))
        .collect(),
      ctx.db
        .query("sales")
        .withIndex("by_product", (q) => q.eq("productId", args.id))
        .collect(),
    ]);

    let revenue = 0;
    let profit = 0;
    let unitsSold = 0;
    for (const s of sales) {
      revenue += s.unitPrice * s.quantity;
      profit += (s.unitPrice - s.unitCost) * s.quantity;
      unitsSold += s.quantity;
    }

    let projected = 0;
    let purchased = 0;
    for (const l of lots) {
      // A lot with no price of its own is projected at the product's asking
      // price, and at cost when there is none — no margin rather than a made
      // up one, and never a loss invented out of a missing figure.
      const price = l.unitPrice ?? product.sellPrice ?? l.unitCost;
      projected += (price - l.unitCost) * l.quantity;
      purchased += l.quantity;
    }

    return {
      product: await withPhoto(ctx, product),
      lots: [...lots].sort((a, b) => b.purchasedAt - a.purchasedAt),
      sales: [...sales].sort((a, b) => b.soldAt - a.soldAt).slice(0, 50),
      totals: {
        revenue,
        profit,
        unitsSold,
        salesCount: sales.length,
        projected,
        purchased,
        margin: revenue > 0 ? profit / revenue : 0,
        lastSoldAt: sales.length > 0 ? Math.max(...sales.map((s) => s.soldAt)) : null,
        lastPrice:
          sales.length > 0
            ? sales.reduce((a, b) => (a.soldAt > b.soldAt ? a : b)).unitPrice
            : null,
      },
    };
  },
});

/**
 * Bulk product import, backing the CSV upload.
 *
 * Rows are validated here as well as in the browser: the client parses the
 * file for immediate feedback, but nothing stops a malformed payload arriving
 * anyway, and a half-imported catalogue is worse than a rejected one.
 *
 * `mode` decides what happens when a name already exists — skip it, or update
 * the existing product in place. Nothing is ever silently duplicated.
 */
export const bulkImport = mutation({
  args: {
    token: v.string(),
    mode: v.union(v.literal("skip"), v.literal("update")),
    rows: v.array(
      v.object({
        name: v.string(),
        details: v.optional(v.string()),
        category: v.optional(v.string()),
        tags: v.optional(v.array(v.string())),
        costPrice: v.number(),
        sellPrice: v.optional(v.number()),
        quantity: v.number(),
        unit: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    if (args.rows.length === 0) throw new ConvexError("The file contained no rows.");
    if (args.rows.length > 1000) {
      throw new ConvexError("Import at most 1000 rows at a time.");
    }

    const existing = await ctx.db.query("products").collect();
    const byName = new Map(existing.map((p) => [p.name.trim().toLowerCase(), p]));

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [index, row] of args.rows.entries()) {
      const line = index + 2; // +1 for zero-index, +1 for the header row
      const name = row.name.trim();
      try {
        validate(name, row.costPrice, row.quantity);
      } catch (err) {
        errors.push(`Row ${line}: ${err instanceof ConvexError ? String(err.data) : "invalid"}`);
        continue;
      }
      if (row.sellPrice !== undefined && (!Number.isFinite(row.sellPrice) || row.sellPrice < 0)) {
        errors.push(`Row ${line}: sell price cannot be negative.`);
        continue;
      }

      const match = byName.get(name.toLowerCase());
      const fields = {
        name,
        costPrice: row.costPrice,
        sellPrice: row.sellPrice,
        unit: row.unit?.trim() || undefined,
        tags: row.tags && row.tags.length > 0 ? row.tags : undefined,
        details: (row.details ?? "").trim(),
        category: row.category?.trim() || undefined,
        quantity: row.quantity,
      };

      if (match) {
        if (args.mode === "skip") {
          skipped++;
          continue;
        }
        /*
          A product with sizes has no single cost, sell price or quantity of
          its own any more — those three are computed from the sizes (see
          `effectiveFromVariants`). Overwriting them from a CSV row would
          silently disagree with the sizes until the product was next saved
          by hand, so a matched row leaves them alone and only touches what
          a CSV import is actually for: the name, category, details.
        */
        const { costPrice, sellPrice, quantity, ...rest } = fields;
        await ctx.db.patch(match._id, match.variants?.length ? rest : fields);
        updated++;
      } else {
        const id = await ctx.db.insert("products", {
          ...fields,
          archived: false,
          createdAt: Date.now(),
        });
        const inserted = await ctx.db.get(id);
        if (inserted) byName.set(name.toLowerCase(), inserted);
        created++;
      }
    }

    return { created, updated, skipped, errors };
  },
});

/**
 * Moves one product's stock by `delta` units, variant-aware. A sale going
 * out passes a negative delta; a cancellation or restore passes a positive
 * one — same convention both callers already used before variants existed.
 *
 * With no variant (or a product that has none), this is exactly the old
 * `quantity + delta` patch. With one, "separate" stock moves that variant's
 * own count and keeps `quantity` as their sum; "shared" stock moves the
 * pooled total by `delta` sizes' worth of the base unit.
 */
export async function adjustStock(
  ctx: MutationCtx,
  productId: Id<"products">,
  variantId: string | undefined,
  delta: number,
) {
  const product = await ctx.db.get(productId);
  if (!product) return;
  const variant = variantId ? product.variants?.find((v) => v.id === variantId) : undefined;
  if (!variant) {
    await ctx.db.patch(productId, { quantity: product.quantity + delta });
    return;
  }
  if (product.stockMode === "separate") {
    const nextVariants = product.variants!.map((v) =>
      v.id === variant.id ? { ...v, quantity: (v.quantity ?? 0) + delta } : v,
    );
    const quantity = nextVariants.reduce((sum, v) => sum + (v.quantity ?? 0), 0);
    await ctx.db.patch(productId, { variants: nextVariants, quantity });
  } else {
    const baseQuantity = variant.baseQuantity ?? 1;
    await ctx.db.patch(productId, { quantity: product.quantity + delta * baseQuantity });
  }
}
