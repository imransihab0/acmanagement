import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { requireSession, verifyPasscode } from "./auth";
import { customerKey } from "./shared";

/** Attaches a signed, short-lived photo URL — the stored `photoId` is never useful to the browser on its own. */
async function withPhoto<T extends { photoId?: Id<"_storage">; photoUrl?: string }>(ctx: QueryCtx, p: T) {
  if (p.photoUrl) return { ...p, photoUrl: p.photoUrl };
  const photoUrl = p.photoId ? await ctx.storage.getUrl(p.photoId) : null;
  return { ...p, photoUrl };
}

/** Trims a list of extra numbers down to the ones actually typed in. */
function cleanPhones(phones: string[] | undefined) {
  return (phones ?? []).map((p) => p.trim()).filter(Boolean);
}

/*
  The shop's address book.

  Same idea as the saved cost names: an order typed from scratch every time
  produces "Rifat", "Md. Rifat" and "রিফাত ভাই" as three customers with one
  order each, and the shop loses the ability to answer "what does this person
  usually buy". Ticking "save this customer" on an order keeps the details;
  from then on the name field searches them and picking one fills the phone
  and address in.

  Unlike cost names there are no examples to offer. Cost names are the same
  in every shop; customers are not, and inventing plausible people would put
  names in the address book that never bought anything.
*/

/**
 * Records that this customer placed an order, saving them if asked.
 *
 * Details are refreshed from the order when it carries them: a customer who
 * has moved is more usefully remembered at the new address than the old one,
 * and the order itself keeps its own snapshot either way, so history is not
 * touched by this.
 *
 * Called from `orders.create` rather than the client, so remembering a
 * customer and recording their order either both happen or neither does.
 */
export async function rememberCustomer(
  ctx: MutationCtx,
  details: { name: string; phone?: string; address?: string },
  save: boolean,
  orderedAt: number,
) {
  const name = details.name.trim();
  if (!name) return;
  const phone = details.phone?.trim() || undefined;
  const address = details.address?.trim() || undefined;
  const key = customerKey(name, phone);

  const existing = await ctx.db
    .query("customers")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  if (existing) {
    // Ordering again ranks a customer up the pick list, tick or no tick.
    // Preserve existing.name so arbitrary input never rewrites the customer's name!
    await ctx.db.patch(existing._id, {
      name: existing.name,
      phone: phone ?? existing.phone,
      address: address ?? existing.address,
      orderCount: existing.orderCount + 1,
      lastOrderedAt: orderedAt,
    });
    return;
  }
  if (!save) return;

  await ctx.db.insert("customers", {
    name,
    phone,
    address,
    key,
    orderCount: 1,
    lastOrderedAt: orderedAt,
    createdAt: Date.now(),
  });
}

/**
 * Every customer's running balance, keyed the same way a sale is matched to
 * them. Positive means the shop owes them (they have paid more than their
 * orders came to); negative means they owe the shop. A cancelled order was
 * never really a sale, so it carries no balance either way.
 */
async function customerBalances(ctx: QueryCtx) {
  // Read only booked orders (confirmed and delivered) in parallel; pending inquiries and cancelled orders carry no debt
  const [confirmed, delivered] = await Promise.all([
    ctx.db.query("orders").withIndex("by_status", (q) => q.eq("orderStatus", "confirmed")).collect(),
    ctx.db.query("orders").withIndex("by_status", (q) => q.eq("orderStatus", "delivered")).collect(),
  ]);
  const orders = [...confirmed, ...delivered];
  const byKey = new Map<string, { spent: number; balance: number }>();
  for (const o of orders) {
    const key = customerKey(o.customerName, o.customerPhone);
    const paid = o.paidAmount ?? (o.paymentStatus === "paid" ? o.total : 0);
    const entry = byKey.get(key) ?? { spent: 0, balance: 0 };
    entry.spent += o.total;
    entry.balance += paid - o.total;
    byKey.set(key, entry);
  }
  return byKey;
}

/** The address book, most frequent first. */
export const list = query({
  args: { token: v.string(), withBalances: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const rows = await ctx.db.query("customers").collect();
    const needBalances = args.withBalances !== false;
    const balances = needBalances ? await customerBalances(ctx) : null;
    const sorted = rows.sort(
      (a, b) => b.orderCount - a.orderCount || a.name.localeCompare(b.name),
    );
    return await Promise.all(
      sorted.map(async (c) => ({
        ...(needBalances ? await withPhoto(ctx, c) : { photoUrl: null }),
        _id: c._id,
        name: c.name,
        phone: c.phone,
        extraPhones: c.extraPhones,
        whatsapp: c.whatsapp,
        facebookUrl: c.facebookUrl,
        address: c.address,
        orderCount: c.orderCount,
        lastOrderedAt: c.lastOrderedAt,
        spent: balances ? (balances.get(c.key)?.spent ?? 0) : 0,
        balance: balances ? (balances.get(c.key)?.balance ?? 0) : 0,
      })),
    );
  },
});

/**
 * One customer and everything they have bought.
 *
 * Indexed by phone and name rather than a full-table scan across all orders in the database.
 */
export const detail = query({
  args: { token: v.string(), id: v.id("customers") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const customer = await ctx.db.get(args.id);
    if (!customer) return null;

    // Use indexed queries for customer's phone(s) and name instead of loading the entire orders table
    const candidateOrders: Doc<"orders">[] = [];
    if (customer.phone) {
      const byPhone = await ctx.db
        .query("orders")
        .withIndex("by_customerPhone", (q) => q.eq("customerPhone", customer.phone))
        .collect();
      candidateOrders.push(...byPhone);
    }
    for (const ep of customer.extraPhones ?? []) {
      if (ep && ep !== customer.phone) {
        const byExtra = await ctx.db
          .query("orders")
          .withIndex("by_customerPhone", (q) => q.eq("customerPhone", ep))
          .collect();
        candidateOrders.push(...byExtra);
      }
    }
    const byName = await ctx.db
      .query("orders")
      .withIndex("by_customerName", (q) => q.eq("customerName", customer.name))
      .collect();
    candidateOrders.push(...byName);

    const seen = new Set<string>();
    const deduplicated = candidateOrders.filter((o) => {
      if (seen.has(o._id)) return false;
      seen.add(o._id);
      return true;
    });

    let mine = deduplicated
      .filter((o) => customerKey(o.customerName, o.customerPhone) === customer.key)
      .sort((a, b) => b.orderedAt - a.orderedAt);

    // If no indexed matches were found but customer is recorded as having orders, fall back to recent orders
    if (mine.length === 0 && customer.orderCount > 0) {
      const recent = await ctx.db.query("orders").withIndex("by_orderedAt").order("desc").take(500);
      mine = recent.filter(
        (o) => customerKey(o.customerName, o.customerPhone) === customer.key,
      );
    }

    let spent = 0;
    let balance = 0;
    let items = 0;
    for (const o of mine) {
      // A cancelled sale is not money the customer spent with you.
      if (o.orderStatus === "cancelled") continue;
      spent += o.total;
      // Positive: the shop owes them. Negative: they owe the shop.
      balance += (o.paidAmount ?? (o.paymentStatus === "paid" ? o.total : 0)) - o.total;
      items += o.items.reduce((sum: number, i: { quantity: number }) => sum + i.quantity, 0);
    }

    return {
      customer: {
        ...(await withPhoto(ctx, customer)),
        _id: customer._id,
        name: customer.name,
        phone: customer.phone,
        extraPhones: customer.extraPhones,
        whatsapp: customer.whatsapp,
        facebookUrl: customer.facebookUrl,
        address: customer.address,
        orderCount: customer.orderCount,
        lastOrderedAt: customer.lastOrderedAt,
      },
      sales: mine,
      totals: { spent, balance, items, count: mine.length },
    };
  },
});

/**
 * Adds a customer by hand, without waiting for them to buy something.
 *
 * The address book is worth filling in before the first sale — a shop knows
 * its regulars before it has recorded an order for each of them, and typing
 * the details once here is the whole point of the list.
 */
export const create = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    phone: v.optional(v.string()),
    extraPhones: v.optional(v.array(v.string())),
    whatsapp: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    address: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const name = args.name.trim();
    if (!name) throw new ConvexError("A customer needs a name.");

    const phone = args.phone?.trim() || undefined;
    const key = customerKey(name, phone);
    const clash = await ctx.db
      .query("customers")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (clash) {
      throw new ConvexError(
        phone
          ? `${clash.name} is already saved with that number.`
          : `${clash.name} is already saved.`,
      );
    }

    return await ctx.db.insert("customers", {
      name,
      phone,
      extraPhones: cleanPhones(args.extraPhones),
      whatsapp: args.whatsapp?.trim() || undefined,
      facebookUrl: args.facebookUrl?.trim() || undefined,
      address: args.address?.trim() || undefined,
      key,
      // Added by hand, so nothing has been bought under this name yet.
      orderCount: 0,
      createdAt: Date.now(),
    });
  },
});

/**
 * Corrects a saved customer's details. Orders already placed keep the name
 * and address they were placed under — a receipt has to keep saying what it
 * said when it was printed.
 */
export const update = mutation({
  args: {
    token: v.string(),
    id: v.id("customers"),
    name: v.string(),
    phone: v.optional(v.string()),
    extraPhones: v.optional(v.array(v.string())),
    whatsapp: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    address: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError("That customer is no longer saved.");
    const name = args.name.trim();
    if (!name) throw new ConvexError("A customer needs a name.");

    const phone = args.phone?.trim() || undefined;
    const key = customerKey(name, phone);
    if (key !== row.key) {
      const clash = await ctx.db
        .query("customers")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      if (clash && clash._id !== args.id) {
        throw new ConvexError(`${clash.name} is already saved with that number.`);
      }
    }

    await ctx.db.patch(args.id, {
      name,
      phone,
      extraPhones: cleanPhones(args.extraPhones),
      // Undefined clears each of these, which is what emptying a box means.
      whatsapp: args.whatsapp?.trim() || undefined,
      facebookUrl: args.facebookUrl?.trim() || undefined,
      address: args.address?.trim() || undefined,
      key,
    });
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

/** Points a customer at a newly uploaded photo, replacing whichever one they had. */
export const setPhoto = mutation({
  args: {
    token: v.string(),
    id: v.id("customers"),
    photoUrl: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const customer = await ctx.db.get(args.id);
    if (!customer) throw new ConvexError("That customer is no longer saved.");
    const oldPhotoId = customer.photoId;
    if (args.photoUrl) {
      await ctx.db.patch(args.id, { photoUrl: args.photoUrl, photoId: undefined });
    } else if (args.storageId) {
      await ctx.db.patch(args.id, { photoId: args.storageId, photoUrl: undefined });
    }
    if (oldPhotoId && oldPhotoId !== args.storageId) {
      try {
        await ctx.storage.delete(oldPhotoId);
      } catch {
        // Safe to ignore if old file was missing
      }
    }
  },
});

export const removePhoto = mutation({
  args: { token: v.string(), id: v.id("customers") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const customer = await ctx.db.get(args.id);
    if (!customer) throw new ConvexError("That customer is no longer saved.");
    const oldPhotoId = customer.photoId;
    await ctx.db.patch(args.id, { photoId: undefined, photoUrl: undefined });
    if (oldPhotoId) {
      try {
        await ctx.storage.delete(oldPhotoId);
      } catch {
        // Safe to ignore if old file was missing
      }
    }
  },
});

/**
 * Removes a customer from the address book. Their orders are untouched — this
 * is a pick list, not the ledger.
 *
 * Passcode-gated like every other delete: a live session means an unlocked
 * browser, not a decision.
 */
export const remove = mutation({
  args: { token: v.string(), id: v.id("customers"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const row = await ctx.db.get(args.id);
    if (!row) return;
    await ctx.db.delete(args.id);
  },
});
