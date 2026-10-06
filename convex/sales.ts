import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireSession, verifyPasscode } from "./auth";
import { adjustInvestment } from "./investment";

export const list = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const q = ctx.db.query("sales").withIndex("by_soldAt").order("desc");
    return args.limit ? await q.take(args.limit) : await q.collect();
  },
});

function validate(unitPrice: number, quantity: number) {
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw new ConvexError("Sale price must be zero or more.");
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ConvexError("Quantity must be a whole number, one or more.");
  }
}

/**
 * Records a sale and takes the units out of stock. The product's name and
 * cost at this moment are copied onto the sale so later edits to the product
 * never rewrite past profit.
 */
export const create = mutation({
  args: {
    token: v.string(),
    productId: v.id("products"),
    unitPrice: v.number(),
    quantity: v.number(),
    buyer: v.optional(v.string()),
    note: v.optional(v.string()),
    soldAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const product = await ctx.db.get(args.productId);
    if (!product) throw new ConvexError("That product no longer exists.");
    validate(args.unitPrice, args.quantity);
    if (product.quantity < args.quantity) {
      throw new ConvexError(
        `Only ${product.quantity} unit${product.quantity === 1 ? "" : "s"} of ${product.name} in stock.`,
      );
    }

    await ctx.db.patch(args.productId, { quantity: product.quantity - args.quantity });

    const buyer = (args.buyer ?? "").trim();
    const note = (args.note ?? "").trim();
    const id = await ctx.db.insert("sales", {
      productId: args.productId,
      productName: product.name,
      unitCost: product.costPrice,
      unitPrice: args.unitPrice,
      quantity: args.quantity,
      buyer: buyer ? buyer : undefined,
      note: note ? note : undefined,
      soldAt: args.soldAt ?? Date.now(),
    });
    // A sale recovers money that was sitting in stock, so it comes off
    // Investment the same way buying stock added to it.
    await adjustInvestment(ctx, -(product.costPrice * args.quantity));
    return id;
  },
});

/**
 * Edits a recorded sale. A change in quantity is reconciled against the
 * product's stock so inventory stays consistent with history.
 */
export const update = mutation({
  args: {
    token: v.string(),
    id: v.id("sales"),
    unitPrice: v.number(),
    quantity: v.number(),
    buyer: v.optional(v.string()),
    note: v.optional(v.string()),
    soldAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const sale = await ctx.db.get(args.id);
    if (!sale) throw new ConvexError("That sale no longer exists.");
    validate(args.unitPrice, args.quantity);

    const delta = args.quantity - sale.quantity;
    if (delta !== 0) {
      const product = await ctx.db.get(sale.productId);
      // A deleted product has no stock left to reconcile; the sale still edits.
      if (product) {
        if (product.quantity - delta < 0) {
          throw new ConvexError(
            `Only ${product.quantity} more unit${product.quantity === 1 ? "" : "s"} available.`,
          );
        }
        await ctx.db.patch(sale.productId, { quantity: product.quantity - delta });
      }
    }

    const buyer = (args.buyer ?? "").trim();
    const note = (args.note ?? "").trim();
    await ctx.db.patch(args.id, {
      unitPrice: args.unitPrice,
      quantity: args.quantity,
      buyer: buyer ? buyer : undefined,
      note: note ? note : undefined,
      soldAt: args.soldAt ?? sale.soldAt,
    });
    // More units sold takes more back out of Investment; fewer gives some back.
    if (delta !== 0) await adjustInvestment(ctx, -(delta * sale.unitCost));
  },
});

/** Deletes a sale and returns its units to stock. */
export const remove = mutation({
  args: { token: v.string(), id: v.id("sales"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const sale = await ctx.db.get(args.id);
    if (!sale) return;
    const product = await ctx.db.get(sale.productId);
    if (product) {
      await ctx.db.patch(sale.productId, { quantity: product.quantity + sale.quantity });
    }
    // The sale no longer happened, so what it took out of Investment comes back.
    await adjustInvestment(ctx, sale.unitCost * sale.quantity);
    await ctx.db.delete(args.id);
  },
});
