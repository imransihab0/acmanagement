import { mutation, query, internalMutation, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireSession, verifyPasscode } from "./auth";
import { withLotStock, withBatchLotStock, applyLotsToProduct } from "./stock";

/** Attaches a photo URL to a product row — uses direct R2 URL if present, or signed Convex URL fallback. */
async function withPhoto<T extends { photoId?: Id<"_storage">; photoUrl?: string }>(ctx: QueryCtx, p: T) {
  if (p.photoUrl) return { ...p, photoUrl: p.photoUrl };
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
        (p.category ?? "").toLowerCase().includes(term) ||
        (p.subCategory ?? "").toLowerCase().includes(term)
      );
    });
    const withStock = await withBatchLotStock(ctx, filtered);
    return await Promise.all(withStock.map((p) => withPhoto(ctx, p)));
  },
});

export const get = query({
  args: { token: v.string(), id: v.id("products") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const product = await ctx.db.get(args.id);
    return product ? await withPhoto(ctx, await withLotStock(ctx, product)) : null;
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
  args: { token: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const since = args.since ?? Date.now() - 366 * 24 * 60 * 60 * 1000;
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
  args: {
    token: v.string(),
    id: v.id("products"),
    photoUrl: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const product = await ctx.db.get(args.id);
    if (!product) throw new ConvexError("That product no longer exists.");
    const oldPhotoId = product.photoId;
    if (args.photoUrl) {
      await ctx.db.patch(args.id, { photoUrl: args.photoUrl, photoId: undefined });
    } else if (args.storageId) {
      await ctx.db.patch(args.id, { photoId: args.storageId, photoUrl: undefined });
    }
    if (oldPhotoId && oldPhotoId !== args.storageId) {
      try {
        await ctx.storage.delete(oldPhotoId);
      } catch {
        // Safe to ignore if the old storage file was already deleted or missing
      }
    }
  },
});

export const removePhoto = mutation({
  args: { token: v.string(), id: v.id("products") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const product = await ctx.db.get(args.id);
    if (!product) throw new ConvexError("That product no longer exists.");
    const oldPhotoId = product.photoId;
    await ctx.db.patch(args.id, { photoId: undefined, photoUrl: undefined });
    if (oldPhotoId) {
      try {
        await ctx.storage.delete(oldPhotoId);
      } catch {
        // Safe to ignore if the old storage file was already deleted or missing
      }
    }
  },
});

/** Repairs any products pointing to non-existent storage IDs */
export const repairDanglingPhotos = internalMutation({
  args: {},
  handler: async (ctx) => {
    const products = await ctx.db.query("products").collect();
    let cleaned = 0;
    for (const p of products) {
      if (p.photoId) {
        const url = await ctx.storage.getUrl(p.photoId);
        if (!url) {
          await ctx.db.patch(p._id, { photoId: undefined });
          cleaned++;
        }
      }
    }
    return { cleaned };
  },
});

/** Distinct categories, for the filter dropdown and the category input's datalist. */
export const categories = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    // Read from productCategories directly rather than scanning the entire products table
    const cats = await ctx.db.query("productCategories").collect();
    const set = new Set<string>();
    for (const c of cats) {
      if (!c.parentId && c.name) set.add(c.name.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  },
});

function validate(name: string) {
  if (!name.trim()) throw new ConvexError("Product name is required.");
}

/*
  A product is only what it is — name, unit, category, details. What it
  costs, what it sells for and how many there are all live on its lots (see
  stock.ts); `costPrice`, `sellPrice` and `quantity` are kept in step with
  those and never set from here.
*/
const productArgs = {
  name: v.string(),
  details: v.string(),
  costPrice: v.optional(v.number()),
  sellPrice: v.optional(v.number()),
  quantity: v.optional(v.number()),
  category: v.optional(v.string()),
  subCategory: v.optional(v.string()),
  categoryId: v.optional(v.id("productCategories")),
  subCategoryId: v.optional(v.id("productCategories")),
  unit: v.optional(v.string()),
};

export const create = mutation({
  args: { token: v.string(), ...productArgs },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    validate(args.name);
    const category = (args.category ?? "").trim();
    const subCategory = (args.subCategory ?? "").trim();
    return await ctx.db.insert("products", {
      name: args.name.trim(),
      costPrice: args.costPrice ?? 0,
      sellPrice: args.sellPrice,
      details: args.details.trim(),
      category: category ? category : undefined,
      subCategory: subCategory ? subCategory : undefined,
      categoryId: args.categoryId,
      subCategoryId: args.subCategoryId,
      quantity: args.quantity ?? 0,
      unit: args.unit?.trim() || undefined,
      archived: false,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: { token: v.string(), id: v.id("products"), ...productArgs },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new ConvexError("That product no longer exists.");
    validate(args.name);
    const category = (args.category ?? "").trim();
    const subCategory = (args.subCategory ?? "").trim();
    const patch: {
      name: string;
      details: string;
      category?: string;
      subCategory?: string;
      categoryId?: Id<"productCategories">;
      subCategoryId?: Id<"productCategories">;
      unit?: string;
      costPrice?: number;
      sellPrice?: number;
      quantity?: number;
    } = {
      name: args.name.trim(),
      details: args.details.trim(),
      category: category ? category : undefined,
      subCategory: subCategory ? subCategory : undefined,
      categoryId: args.categoryId,
      subCategoryId: args.subCategoryId,
      unit: args.unit?.trim() || undefined,
    };
    if (args.costPrice !== undefined) patch.costPrice = args.costPrice;
    if (args.sellPrice !== undefined) patch.sellPrice = args.sellPrice;
    if (args.quantity !== undefined) patch.quantity = args.quantity;
    await ctx.db.patch(args.id, patch);
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
      // An old lot with no price of its own is projected at cost — no margin
      // rather than a made up one, and never a loss invented out of a
      // missing figure.
      const price = l.unitPrice ?? l.unitCost;
      projected += (price - l.unitCost) * l.quantity;
      purchased += l.quantity;
    }

    return {
      product: await withPhoto(ctx, applyLotsToProduct(product, lots)),
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
