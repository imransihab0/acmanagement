import { mutation, query, type MutationCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireSession, verifyPasscode } from "./auth";
import { rememberCustomer } from "./customers";
import { adjustStock } from "./products";
import { variantAvailable } from "./shared";
import { adjustInvestment } from "./investment";

/*
  Orders.

  An order is what arrives over WhatsApp: a customer, several products,
  quantities and a total. Confirming one writes a sale per line item, so the
  Dashboard, Profit page and Sales ledger keep working exactly as before and
  include order revenue. Without that, orders would be a second set of books
  the profit figures quietly ignore.

  Money is recomputed from the items on every write. A client that sent a
  total disagreeing with its own line items would otherwise be believed.
*/

export const DEFAULT_UNIT = "পিস";

const itemInput = v.object({
  productId: v.id("products"),
  quantity: v.number(),
  unitPrice: v.number(),
  /*
    Which purchase lot to sell out of. Optional: a product with no lots, or a
    sale nobody wants to attribute, still works and falls back to the
    product's own cost price.
  */
  batchId: v.optional(v.id("stockBatches")),
  /** Which size, for a product sold in variants. */
  variantId: v.optional(v.string()),
});

type Totals = { subtotal: number; total: number };

function computeTotals(
  items: { quantity: number; unitPrice: number }[],
  discount: number,
  deliveryCharge: number,
): Totals {
  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  return { subtotal, total: subtotal - discount + deliveryCharge };
}

/** Sequential, gap-free order numbers: ORD-000001. */
async function nextOrderNo(ctx: MutationCtx) {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", "order"))
    .unique();
  const next = (row?.value ?? 0) + 1;
  if (row) await ctx.db.patch(row._id, { value: next });
  else await ctx.db.insert("counters", { name: "order", value: next });
  return `ORD-${String(next).padStart(6, "0")}`;
}

function validate(
  items: { quantity: number; unitPrice: number }[],
  discount: number,
  deliveryCharge: number,
) {
  if (items.length === 0) throw new ConvexError("An order needs at least one product.");
  for (const i of items) {
    if (!Number.isFinite(i.quantity) || i.quantity <= 0) {
      throw new ConvexError("Every line needs a quantity above zero.");
    }
    if (!Number.isFinite(i.unitPrice) || i.unitPrice < 0) {
      throw new ConvexError("Unit price cannot be negative.");
    }
  }
  if (!Number.isFinite(discount) || discount < 0) throw new ConvexError("Discount cannot be negative.");
  if (!Number.isFinite(deliveryCharge) || deliveryCharge < 0) {
    throw new ConvexError("Delivery charge cannot be negative.");
  }
  const { subtotal } = computeTotals(items, discount, deliveryCharge);
  if (discount > subtotal) throw new ConvexError("Discount is larger than the order subtotal.");
}

/**
 * Resolves each line against its product, snapshotting the name, unit and
 * cost. Returns which lines exceed available stock so the caller can decide
 * whether that needs an override.
 */
async function resolveItems(
  ctx: MutationCtx,
  items: {
    productId: Id<"products">;
    quantity: number;
    unitPrice: number;
    batchId?: Id<"stockBatches">;
    variantId?: string;
  }[],
) {
  const resolved = [];
  const short: string[] = [];
  for (const line of items) {
    const product = await ctx.db.get(line.productId);
    if (!product) throw new ConvexError("A product on this sale no longer exists.");

    const variant = line.variantId ? product.variants?.find((v) => v.id === line.variantId) : undefined;
    if (line.variantId && !variant) {
      throw new ConvexError(`That size of ${product.name} no longer exists.`);
    }

    if (variant) {
      const available = variantAvailable(product, variant.id);
      if (line.quantity > available) {
        short.push(
          `${product.name} (${variant.label}): ${line.quantity} requested, ${available} available`,
        );
      }
    } else if (line.quantity > product.quantity) {
      short.push(
        `${product.name}: ${line.quantity} requested, ${product.quantity} ${product.unit ?? DEFAULT_UNIT} available`,
      );
    }

    /*
      Cost comes from the chosen lot when there is one, else the chosen size,
      else the product's own cost. The same product bought twice at different
      prices makes two different profits, and averaging them into a single
      cost price is how a shop convinces itself a bad buy was fine. The figure
      is snapshotted here, so editing the lot or the size later cannot
      rewrite what this sale earned.
    */
    let unitCost = variant ? variant.costPrice : product.costPrice;
    if (line.batchId) {
      const batch = await ctx.db.get(line.batchId);
      if (!batch) throw new ConvexError("That stock lot no longer exists.");
      if (batch.productId !== line.productId) {
        throw new ConvexError(`${batch.label} is not a lot of ${product.name}.`);
      }
      const left = batch.remaining ?? batch.quantity;
      if (line.quantity > left) {
        short.push(
          `${product.name} (${batch.label}): ${line.quantity} requested, ${left} left in that lot`,
        );
      }
      unitCost = batch.unitCost;
    }

    resolved.push({
      productId: line.productId,
      productName: product.name,
      quantity: line.quantity,
      unit: variant ? variant.label : (product.unit ?? DEFAULT_UNIT),
      unitPrice: line.unitPrice,
      unitCost,
      batchId: line.batchId,
      variantId: variant?.id,
      variantLabel: variant?.label,
    });
  }
  return { resolved, short };
}

/** Which already-recorded lines, if confirmed/restored right now, would oversell. */
async function shortageOf(
  ctx: MutationCtx,
  items: { productId: Id<"products">; productName: string; quantity: number; variantId?: string }[],
) {
  const short: string[] = [];
  for (const line of items) {
    const product = await ctx.db.get(line.productId);
    if (!product) continue;
    const available = line.variantId ? variantAvailable(product, line.variantId) : product.quantity;
    if (line.quantity > available) {
      short.push(`${line.productName}: only ${available} left`);
    }
  }
  return short;
}

/* ------------------------------------------------------------------ read */

export const list = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const q = ctx.db.query("orders").withIndex("by_orderedAt").order("desc");
    return args.limit ? await q.take(args.limit) : await q.collect();
  },
});

export const get = query({
  args: { token: v.string(), id: v.id("orders") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await ctx.db.get(args.id);
  },
});

/* ----------------------------------------------------------------- write */

/*
  Confirming, cancelling, undoing a cancellation and deleting all ask for the
  passcode, not just a live session. Each one moves stock and rewrites the
  ledger, and a browser left unlocked on the counter is not the same thing as
  the owner deciding. The check is in the mutation rather than only the
  dialog, so a caller that never opened the dialog is refused too.
*/

export const create = mutation({
  args: {
    token: v.string(),
    customerName: v.string(),
    customerPhone: v.optional(v.string()),
    customerAddress: v.optional(v.string()),
    orderedAt: v.optional(v.number()),
    items: v.array(itemInput),
    discount: v.optional(v.number()),
    deliveryCharge: v.optional(v.number()),
    paymentStatus: v.optional(v.string()),
    paidAmount: v.optional(v.number()),
    note: v.optional(v.string()),
    /*
      Selling more than is in stock is allowed, but only deliberately: the
      caller must re-enter the passcode. That stops an oversell happening by
      reflex while still permitting it when stock counts have drifted or goods
      are on the way.
    */
    overridePasscode: v.optional(v.string()),
    /** The tick: keep this customer in the address book for next time. */
    saveCustomer: v.optional(v.boolean()),
    /*
      Whether the goods have already gone. A counter sale is complete the
      moment it is written, and making the shopkeeper confirm it afterwards
      would leave stock wrong for as long as they forgot to.
    */
    completed: v.optional(v.boolean()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    if (!args.customerName.trim()) throw new ConvexError("Customer name is required.");

    const discount = args.discount ?? 0;
    const deliveryCharge = args.deliveryCharge ?? 0;
    validate(args.items, discount, deliveryCharge);

    const { resolved, short } = await resolveItems(ctx, args.items);
    if (short.length > 0) {
      if (!args.overridePasscode) {
        throw new ConvexError(
          `Not enough stock — ${short.join("; ")}. Re-enter your passcode to sell anyway.`,
        );
      }
      await verifyPasscode(ctx, args.overridePasscode);
    }

    const { subtotal, total } = computeTotals(resolved, discount, deliveryCharge);
    const paymentStatus = (args.paymentStatus ?? "due") as "paid" | "due" | "partial";
    /*
      Same invariant `setPayment` keeps: "paid" always means the full total,
      "due" always means nothing, and "partial" is the only one of the three
      that needs a figure from the caller — and has to sit strictly between
      the other two, or it is really one of them under the wrong label.
      Trusting the status alone here is how an order used to save as
      "Partial" with no amount recorded at all.
    */
    let paidAmount: number | undefined;
    if (paymentStatus === "partial") {
      const amount = args.paidAmount ?? 0;
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ConvexError("Enter how much has been paid.");
      }
      if (amount >= total) {
        throw new ConvexError("A partial payment has to be less than the total.");
      }
      paidAmount = amount;
    }
    const orderedAt = args.orderedAt ?? Date.now();

    /*
      Remembering the customer rides along with the order rather than being a
      second call from the client: an order that was placed but whose customer
      was not remembered — or the reverse — is a state worth making impossible.
    */
    await rememberCustomer(
      ctx,
      {
        name: args.customerName,
        phone: args.customerPhone,
        address: args.customerAddress,
      },
      args.saveCustomer ?? false,
      orderedAt,
    );

    const id = await ctx.db.insert("orders", {
      orderNo: await nextOrderNo(ctx),
      customerName: args.customerName.trim(),
      customerPhone: args.customerPhone?.trim() || undefined,
      customerAddress: args.customerAddress?.trim() || undefined,
      orderedAt,
      items: resolved,
      subtotal,
      discount,
      deliveryCharge,
      total,
      paymentStatus,
      paidAmount,
      orderStatus: "pending",
      note: args.note?.trim() || undefined,
      source: args.source,
      createdAt: Date.now(),
    });

    // Stock was already checked above, override included, so fulfilment here
    // cannot fail on a shortage the caller was not told about.
    if (args.completed) await fulfil(ctx, id);
    return id;
  },
});

/**
 * Takes the stock and writes one sale per line, then marks the sale confirmed.
 *
 * Shared by confirming later and by recording a sale that is already complete
 * — a walk-in customer paying at the counter should not have to be confirmed
 * as a second step. Stock availability is the caller's business: both callers
 * check it, and only they know whether an override was given.
 */
async function fulfil(ctx: MutationCtx, id: Id<"orders">) {
  const order = await ctx.db.get(id);
  if (!order) throw new ConvexError("That sale no longer exists.");

  const discountRatio = order.subtotal > 0 ? order.discount / order.subtotal : 0;
  const saleIds: Id<"sales">[] = [];

  for (const line of order.items) {
    await adjustStock(ctx, line.productId, line.variantId, -line.quantity);
    // The lot empties along with the shelf it sits on.
    if (line.batchId) {
      const batch = await ctx.db.get(line.batchId);
      if (batch) {
        const left = batch.remaining ?? batch.quantity;
        await ctx.db.patch(line.batchId, { remaining: Math.max(0, left - line.quantity) });
      }
    }
    const effectivePrice = line.unitPrice * (1 - discountRatio);
    // A sale recovers money that was sitting in stock, so it comes off
    // Investment the same way buying stock added to it.
    await adjustInvestment(ctx, -(line.unitCost * line.quantity));
    saleIds.push(
      await ctx.db.insert("sales", {
        productId: line.productId,
        batchId: line.batchId,
        productName: line.productName,
        unitCost: line.unitCost,
        unitPrice: effectivePrice,
        quantity: line.quantity,
        variantId: line.variantId,
        variantLabel: line.variantLabel,
        buyer: order.customerName,
        note: `${order.orderNo}${order.note ? ` · ${order.note}` : ""}`,
        soldAt: order.orderedAt,
      }),
    );
  }

  await ctx.db.patch(id, { orderStatus: "confirmed", saleIds });
  return saleIds;
}

/**
 * Confirms an order: takes the stock and writes one sale per line.
 *
 * The discount is spread across lines in proportion to their value, so the
 * profit recorded against each product reflects what was actually charged.
 * The delivery charge is deliberately excluded — it is a pass-through, not
 * product revenue, and folding it in would inflate margins.
 */
export const confirm = mutation({
  args: {
    token: v.string(),
    id: v.id("orders"),
    passcode: v.string(),
    overridePasscode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const order = await ctx.db.get(args.id);
    if (!order) throw new ConvexError("That order no longer exists.");
    if (order.orderStatus === "confirmed" || order.orderStatus === "delivered") {
      throw new ConvexError("This order is already confirmed.");
    }
    if (order.orderStatus === "cancelled") throw new ConvexError("This order was cancelled.");

    const short: string[] = await shortageOf(ctx, order.items);
    if (short.length > 0) {
      if (!args.overridePasscode) {
        throw new ConvexError(
          `Not enough stock — ${short.join("; ")}. Re-enter your passcode to confirm anyway.`,
        );
      }
      await verifyPasscode(ctx, args.overridePasscode);
    }

    const saleIds = await fulfil(ctx, args.id);
    return { saleIds: saleIds.length };
  },
});

/** Cancels a confirmed order: removes its sales and returns the stock. */
export const cancel = mutation({
  args: { token: v.string(), id: v.id("orders"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const order = await ctx.db.get(args.id);
    if (!order) throw new ConvexError("That order no longer exists.");
    if (order.orderStatus === "cancelled") return;

    for (const saleId of order.saleIds ?? []) {
      const sale = await ctx.db.get(saleId);
      if (!sale) continue;
      await adjustStock(ctx, sale.productId, sale.variantId, sale.quantity);
      // Back to the lot it was drawn from, not just to the shelf total.
      if (sale.batchId) {
        const batch = await ctx.db.get(sale.batchId);
        if (batch) {
          const left = batch.remaining ?? batch.quantity;
          await ctx.db.patch(sale.batchId, {
            remaining: Math.min(batch.quantity, left + sale.quantity),
          });
        }
      }
      // The sale no longer happened, so what it took out of Investment comes back.
      await adjustInvestment(ctx, sale.unitCost * sale.quantity);
      await ctx.db.delete(saleId);
    }
    await ctx.db.patch(args.id, {
      orderStatus: "cancelled",
      saleIds: [],
      cancelledFrom: order.orderStatus,
    });
  },
});

/**
 * Undoes a cancellation, putting the sale back the way it was.
 *
 * A cancelled sale that had been confirmed takes its stock again and writes
 * its ledger lines again; one that was only pending simply goes back to
 * pending, because it never moved anything in the first place. Without the
 * remembered status both would have to be treated alike, and one of the two
 * answers is always wrong.
 *
 * The new ledger lines get new ids. Nothing points at them but the sale
 * itself, which is repointed here, so the figures come back identical even
 * though the rows are not the same rows.
 */
export const restore = mutation({
  args: {
    token: v.string(),
    id: v.id("orders"),
    passcode: v.string(),
    overridePasscode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const order = await ctx.db.get(args.id);
    if (!order) throw new ConvexError("That sale no longer exists.");
    if (order.orderStatus !== "cancelled") return { status: order.orderStatus };

    const target = order.cancelledFrom ?? "pending";
    if (target === "pending") {
      await ctx.db.patch(args.id, { orderStatus: "pending", cancelledFrom: undefined });
      return { status: "pending" as const };
    }

    /*
      Stock can have moved on while the sale sat cancelled, so restoring one
      is checked exactly as confirming one is — and can be overridden the same
      way, since the goods may well have gone out regardless.
    */
    const short: string[] = await shortageOf(ctx, order.items);
    if (short.length > 0) {
      if (!args.overridePasscode) {
        throw new ConvexError(
          `Not enough stock to restore this sale — ${short.join("; ")}. Re-enter your passcode to restore anyway.`,
        );
      }
      await verifyPasscode(ctx, args.overridePasscode);
    }

    await fulfil(ctx, args.id);
    // `fulfil` marks it confirmed; one that had been delivered goes back to
    // delivered rather than quietly losing a step.
    await ctx.db.patch(args.id, { orderStatus: target, cancelledFrom: undefined });
    return { status: target };
  },
});

/**
 * Records what the customer has actually paid.
 *
 * Status and amount are kept consistent with each other rather than being two
 * independent fields: "paid" always means the full total, "due" always means
 * nothing, and "partial" must be strictly between the two. Letting them drift
 * apart is how an order ends up marked paid with ৳0 against it.
 */
export const setPayment = mutation({
  args: {
    token: v.string(),
    id: v.id("orders"),
    paymentStatus: v.optional(v.union(v.literal("paid"), v.literal("due"), v.literal("partial"))),
    paidAmount: v.optional(v.number()),
    /*
      What the customer has just handed over, as opposed to what they have
      paid in total. A second instalment is the common case and the shopkeeper
      should not have to add it up — and doing the sum here rather than in the
      browser means a stale figure on screen cannot double-count it.
    */
    addAmount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const order = await ctx.db.get(args.id);
    if (!order) throw new ConvexError("That sale no longer exists.");

    const alreadyPaid =
      order.paidAmount ?? (order.paymentStatus === "paid" ? order.total : 0);

    let paidAmount: number;
    if (args.addAmount !== undefined) {
      if (!Number.isFinite(args.addAmount) || args.addAmount <= 0) {
        throw new ConvexError("Enter how much was received.");
      }
      /*
        Capped at the total. Paying more than the bill is not a credit the
        shop owes — it is change handed back at the counter — and recording
        it would put a negative due on the receipt.
      */
      paidAmount = Math.min(alreadyPaid + args.addAmount, order.total);
    } else if (args.paymentStatus === "paid") {
      paidAmount = order.total;
    } else if (args.paymentStatus === "due") {
      paidAmount = 0;
    } else if (args.paymentStatus === "partial") {
      const amount = args.paidAmount ?? 0;
      if (!Number.isFinite(amount) || amount < 0) {
        throw new ConvexError("Enter how much has been paid.");
      }
      paidAmount = Math.min(amount, order.total);
    } else {
      throw new ConvexError("Say what was paid.");
    }

    // The status follows the figure rather than being set beside it, so the
    // two can never disagree about whether a sale is settled.
    const paymentStatus =
      paidAmount >= order.total ? "paid" : paidAmount <= 0 ? "due" : "partial";

    await ctx.db.patch(args.id, {
      paymentStatus,
      paidAmount: paymentStatus === "partial" ? paidAmount : undefined,
    });
    return { paymentStatus, paidAmount, due: order.total - paidAmount };
  },
});

export const setStatus = mutation({
  args: {
    token: v.string(),
    id: v.id("orders"),
    paymentStatus: v.optional(v.string()),
    orderStatus: v.optional(v.string()),
    paidAmount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const patch: Record<string, unknown> = {};
    if (args.paymentStatus) patch.paymentStatus = args.paymentStatus;
    if (args.paidAmount !== undefined) patch.paidAmount = args.paidAmount;
    // Confirming and cancelling move stock, so they go through their own
    // mutations rather than being settable here.
    if (args.orderStatus === "delivered" || args.orderStatus === "pending") {
      patch.orderStatus = args.orderStatus;
    }
    await ctx.db.patch(args.id, patch);
  },
});

export const remove = mutation({
  args: { token: v.string(), id: v.id("orders"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const order = await ctx.db.get(args.id);
    if (!order) return;
    // Deleting a confirmed order must not leave its sales behind.
    for (const saleId of order.saleIds ?? []) {
      const sale = await ctx.db.get(saleId);
      if (!sale) continue;
      await adjustStock(ctx, sale.productId, sale.variantId, sale.quantity);
      // Back to the lot it was drawn from, not just to the shelf total.
      if (sale.batchId) {
        const batch = await ctx.db.get(sale.batchId);
        if (batch) {
          const left = batch.remaining ?? batch.quantity;
          await ctx.db.patch(sale.batchId, {
            remaining: Math.min(batch.quantity, left + sale.quantity),
          });
        }
      }
      // The sale no longer happened, so what it took out of Investment comes back.
      await adjustInvestment(ctx, sale.unitCost * sale.quantity);
      await ctx.db.delete(saleId);
    }
    await ctx.db.delete(args.id);
  },
});
