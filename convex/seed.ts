import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { CATALOGUE } from "./catalogue";
import { ensureBuckets } from "./profit";
import { customerKey, type VendorCategory } from "./shared";

/**
 * Development helpers. These are internal functions — not reachable from the
 * browser, only from the CLI:
 *
 *   npx convex run seed:demo    # load the bdmushroom.com catalogue + sample sales
 *   npx convex run seed:clear   # wipe every product and sale
 *
 * `demo` clears first, so it is safe to re-run and always lands on the same
 * result.
 */

const DAY = 24 * 60 * 60 * 1000;
const SALE_COUNT = 90;
const BUYERS = [
  "Rifat",
  "Nusrat",
  "Tanvir",
  "Sadia",
  "Arif",
  "Mehedi",
  "Priya",
  "Sabbir",
  "Jannat",
  "Hasan",
];
const NOTES = ["Paid via bKash.", "Paid via Nagad.", "Cash on delivery.", "Pickup from farm."];

/** Small deterministic PRNG so repeated seeds produce identical data. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

async function wipe(ctx: MutationCtx) {
  const sales = await ctx.db.query("sales").collect();
  for (const s of sales) await ctx.db.delete(s._id);
  const products = await ctx.db.query("products").collect();
  for (const p of products) await ctx.db.delete(p._id);
  return { products: products.length, sales: sales.length };
}

export const demo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const removed = await wipe(ctx);

    const random = makeRandom(20260906);
    const now = Date.now();

    const created: {
      id: Id<"products">;
      name: string;
      cost: number;
      low: number;
      high: number;
    }[] = [];

    for (const item of CATALOGUE) {
      // Seed extra stock, since the sales below consume some of it.
      const id = await ctx.db.insert("products", {
        name: item.name,
        costPrice: item.cost,
        details: item.details,
        category: item.category,
        quantity: item.stock + 12,
        archived: false,
        createdAt: now - Math.floor(random() * 200) * DAY,
      });
      created.push({
        id,
        name: item.name,
        cost: item.cost,
        low: item.retailLow,
        high: item.retailHigh,
      });
    }

    let sold = 0;
    for (let i = 0; i < SALE_COUNT; i++) {
      const product = created[Math.floor(random() * created.length)];
      // Weight toward recent days so the trend chart has a visible shape.
      const daysAgo = Math.floor(random() ** 1.7 * 90);
      // Sell somewhere in the product's real listed range.
      const unitPrice = Math.round(product.low + random() * (product.high - product.low));
      const quantity = random() < 0.75 ? 1 : 1 + Math.floor(random() * 3);

      const current = await ctx.db.get(product.id);
      if (!current || current.quantity < quantity) continue;
      await ctx.db.patch(product.id, { quantity: current.quantity - quantity });

      await ctx.db.insert("sales", {
        productId: product.id,
        productName: product.name,
        unitCost: product.cost,
        unitPrice,
        quantity,
        buyer: random() < 0.65 ? BUYERS[Math.floor(random() * BUYERS.length)] : undefined,
        note: random() < 0.3 ? NOTES[Math.floor(random() * NOTES.length)] : undefined,
        soldAt: now - daysAgo * DAY - Math.floor(random() * DAY),
      });
      sold++;
    }

    return (
      `Cleared ${removed.products} products and ${removed.sales} sales. ` +
      `Seeded ${created.length} products from bdmushroom.com and ${sold} sales.`
    );
  },
});

/**
 * Row counts for whichever deployment you point it at, without needing a
 * session. Handy for telling dev and prod apart:
 *
 *   npx convex run seed:count          # dev
 *   npx convex run --prod seed:count   # production
 */
export const count = internalQuery({
  args: {},
  handler: async (ctx) => {
    const products = await ctx.db.query("products").collect();
    const sales = await ctx.db.query("sales").collect();
    const orders = await ctx.db.query("orders").collect();
    const config = await ctx.db.query("authConfig").first();
    const sessions = await ctx.db.query("sessions").collect();
    return {
      products: products.length,
      sales: sales.length,
      orders: orders.length,
      ordersByStatus: orders.reduce<Record<string, number>>((acc, o) => {
        acc[o.orderStatus] = (acc[o.orderStatus] ?? 0) + 1;
        return acc;
      }, {}),
      /** Sales that came from a confirmed order, rather than entered directly. */
      salesFromOrders: orders.reduce((n, o) => n + (o.saleIds?.length ?? 0), 0),
      categories: [...new Set(products.map((p) => p.category).filter(Boolean))].length,
      passcodeSet: config !== null,
      activeSessions: sessions.filter((s) => s.expiresAt > Date.now()).length,
    };
  },
});

/*
  The stock lots from the hand-kept profit sheet. Dates are DD/MM/YY.

  Profit is deliberately not copied across — it is derived from sell minus
  buy, which is why one row here differs from the sheet: the fogger's 2nd lot
  reads "sell 180, buy 90, profit 70", but 180 - 90 is 90. The sheet's own
  arithmetic disagrees with itself there, so the prices win.

  The agar's 2nd lot had "ক্রয়" and "বিক্রয়" the wrong way round (buy 9000,
  sell 3200); the stated profit of 5800 only works as sell 9000 / buy 3200,
  which is what is used.
*/
const SHEET: {
  product: string;
  category: string;
  lots: { label: string; date: string; qty: number; buy: number; sell: number }[];
}[] = [
  {
    product: "Hygrometer / হাইড্রোমিটার",
    category: "Farming Equipment",
    lots: [
      { label: "1st stock", date: "2026-08-01", qty: 20, buy: 280, sell: 560 },
      { label: "2nd stock", date: "2026-08-10", qty: 30, buy: 290, sell: 560 },
    ],
  },
  {
    product: "এগার এগার পাউডার/Agar Agar Powder",
    category: "Farmer Products",
    lots: [
      { label: "1st stock", date: "2026-08-01", qty: 2, buy: 2800, sell: 9000 },
      { label: "2nd stock", date: "2026-08-10", qty: 2.5, buy: 3200, sell: 9000 },
    ],
  },
  {
    product: "Fogger 4 nozzle / ফগার ৪ নজেল",
    category: "Farming Equipment",
    lots: [
      { label: "1st stock", date: "2026-09-01", qty: 50, buy: 100, sell: 180 },
      { label: "2nd stock", date: "2026-09-05", qty: 80, buy: 90, sell: 180 },
    ],
  },
  {
    product: "Fogger 5 nozzle / ফগার ৫ নজেল",
    category: "Farming Equipment",
    lots: [{ label: "1st stock", date: "2026-09-01", qty: 50, buy: 120, sell: 220 }],
  },
  {
    product: "Single 12v DC Motor / সিঙ্গেল ১২ভি ডিসি মোটর",
    category: "Farming Equipment",
    lots: [{ label: "1st stock", date: "2026-09-01", qty: 50, buy: 400, sell: 650 }],
  },
  {
    product: "Double 12v DC Motor / ডাবল ১২ভি ডিসি মোটর",
    category: "Farming Equipment",
    lots: [{ label: "1st stock", date: "2026-09-01", qty: 50, buy: 800, sell: 1200 }],
  },
  {
    product: "DGDR Heater / ডিজিডিআর হিটার",
    category: "Farming Equipment",
    lots: [{ label: "1st stock", date: "2026-09-01", qty: 50, buy: 800, sell: 1200 }],
  },
];

/**
 * Loads the allocation split and the profit sheet's stock lots.
 *
 *   npx convex run seed:profitSheet
 *   npx convex run --prod seed:profitSheet
 *
 * Existing stock lots are cleared first so it is safe to re-run. Products,
 * sales and the passcode are untouched; a product named in the sheet that is
 * not in the catalogue is created.
 */
export const profitSheet = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureBuckets(ctx);

    let cleared = 0;
    for (const b of await ctx.db.query("stockBatches").collect()) {
      await ctx.db.delete(b._id);
      cleared++;
    }

    const all = await ctx.db.query("products").collect();
    let createdProducts = 0;
    let lots = 0;

    for (const entry of SHEET) {
      let product = all.find((p) => p.name === entry.product);
      if (!product) {
        const id = await ctx.db.insert("products", {
          name: entry.product,
          costPrice: entry.lots[0].buy,
          details: "Added from the profit calculation sheet.",
          category: entry.category,
          quantity: entry.lots.reduce((sum, l) => sum + l.qty, 0),
          archived: false,
          createdAt: Date.parse(entry.lots[0].date),
        });
        product = (await ctx.db.get(id))!;
        all.push(product);
        createdProducts++;
      }

      for (const lot of entry.lots) {
        await ctx.db.insert("stockBatches", {
          productId: product._id,
          productName: product.name,
          label: lot.label,
          purchasedAt: Date.parse(lot.date),
          quantity: lot.qty,
          unitCost: lot.buy,
          unitPrice: lot.sell,
        });
        lots++;
      }
    }

    return (
      `Cleared ${cleared} old lots. Seeded ${lots} stock lots across ${SHEET.length} products ` +
      `(${createdProducts} newly created) and the 7 allocation categories.`
    );
  },
});

/**
 * Brings stock in line with the lots that produced it:
 *
 *   npx convex run seed:reconcileStock
 *
 * Stock lots only started moving `product.quantity` after the two were
 * connected, so lots recorded before that are not reflected in stock. This
 * recomputes quantity as (units bought in lots − units sold) for every product
 * that has lots. Products with no lots are left alone: the invariant does not
 * apply to them, and their quantity was entered by hand.
 */
export const reconcileStock = internalMutation({
  args: {},
  handler: async (ctx) => {
    const lots = await ctx.db.query("stockBatches").collect();
    const sales = await ctx.db.query("sales").collect();

    const bought = new Map<string, number>();
    for (const l of lots) {
      const k = l.productId as string;
      bought.set(k, (bought.get(k) ?? 0) + l.quantity);
    }
    const sold = new Map<string, number>();
    for (const s of sales) {
      const k = s.productId as string;
      sold.set(k, (sold.get(k) ?? 0) + s.quantity);
    }

    const changes: string[] = [];
    for (const [productId, boughtUnits] of bought) {
      const product = await ctx.db.get(productId as Id<"products">);
      if (!product) continue;
      const next = Math.max(0, boughtUnits - (sold.get(productId) ?? 0));
      if (next !== product.quantity) {
        changes.push(`${product.name}: ${product.quantity} → ${next}`);
        await ctx.db.patch(product._id, { quantity: next });
      }
    }

    return changes.length === 0
      ? "Stock already matches the lots. Nothing changed."
      : `Reconciled ${changes.length} product(s):\n  ${changes.join("\n  ")}`;
  },
});

/**
 * Fills in a selling price for products that have none:
 *
 *   npx convex run seed:backfillSellPrice
 *
 * Products created before orders existed have no sellPrice, so adding one to
 * an order fell back to its cost and recorded the sale at zero profit. The
 * price is taken from the product's most recent stock lot where there is one,
 * since that is a real intended selling price, and otherwise from the
 * catalogue's listed retail price. Anything already set is left alone.
 */
export const backfillSellPrice = internalMutation({
  args: {},
  handler: async (ctx) => {
    const products = await ctx.db.query("products").collect();
    const lots = await ctx.db.query("stockBatches").collect();

    // Most recent lot per product wins — that is the current asking price.
    const latestLot = new Map<string, { at: number; price: number }>();
    for (const l of lots) {
      const key = l.productId as string;
      const seen = latestLot.get(key);
      if (!seen || l.purchasedAt > seen.at) {
        latestLot.set(key, { at: l.purchasedAt, price: l.unitPrice ?? 0 });
      }
    }
    const retail = new Map(CATALOGUE.map((c) => [c.name, c.retailLow]));

    let fromLots = 0;
    let fromCatalogue = 0;
    let untouched = 0;
    const unresolved: string[] = [];

    for (const product of products) {
      if (product.sellPrice !== undefined) {
        untouched++;
        continue;
      }
      const lot = latestLot.get(product._id as string);
      if (lot) {
        await ctx.db.patch(product._id, { sellPrice: lot.price });
        fromLots++;
        continue;
      }
      const listed = retail.get(product.name);
      if (listed !== undefined) {
        await ctx.db.patch(product._id, { sellPrice: listed });
        fromCatalogue++;
        continue;
      }
      unresolved.push(product.name);
    }

    return (
      `Set from stock lots: ${fromLots}. From catalogue retail: ${fromCatalogue}. ` +
      `Already had one: ${untouched}. Needs a price by hand: ${unresolved.length}` +
      (unresolved.length ? ` (${unresolved.slice(0, 5).join(", ")})` : "")
    );
  },
});

export const clear = internalMutation({
  args: {},
  handler: async (ctx) => {
    const removed = await wipe(ctx);
    return `Deleted ${removed.products} products and ${removed.sales} sales.`;
  },
});

const DEMO_COUNT = 13;
const DEMO_CUSTOMER_NAMES = [
  "Rifat",
  "Nusrat",
  "Tanvir",
  "Sadia",
  "Arif",
  "Mehedi",
  "Priya",
  "Sabbir",
  "Jannat",
  "Hasan",
  "Farhana",
  "Mahin",
  "Raju",
];
const DEMO_AREAS = ["Mirpur, Dhaka", "Uttara, Dhaka", "Dhanmondi, Dhaka", "Mohammadpur, Dhaka", "Savar, Dhaka"];
const DEMO_COST_NAMES = [
  "Office snacks",
  "Staff lunch",
  "Delivery fuel",
  "Electricity bill",
  "Internet bill",
  "Packaging materials",
  "Farm labour",
];
const DEMO_ORDER_STATUSES = ["pending", "confirmed", "delivered", "cancelled"] as const;
const DEMO_PAYMENT_STATUSES = ["paid", "due", "partial"] as const;

async function wipeEverything(ctx: MutationCtx) {
  const removed: Record<string, number> = {};

  const sales = await ctx.db.query("sales").collect();
  for (const r of sales) await ctx.db.delete(r._id);
  removed.sales = sales.length;

  const products = await ctx.db.query("products").collect();
  for (const r of products) await ctx.db.delete(r._id);
  removed.products = products.length;

  const customers = await ctx.db.query("customers").collect();
  for (const r of customers) await ctx.db.delete(r._id);
  removed.customers = customers.length;

  const costs = await ctx.db.query("costs").collect();
  for (const r of costs) await ctx.db.delete(r._id);
  removed.costs = costs.length;

  const costNames = await ctx.db.query("costNames").collect();
  for (const r of costNames) await ctx.db.delete(r._id);
  removed.costNames = costNames.length;

  const orders = await ctx.db.query("orders").collect();
  for (const r of orders) await ctx.db.delete(r._id);
  removed.orders = orders.length;

  const lots = await ctx.db.query("stockBatches").collect();
  for (const r of lots) await ctx.db.delete(r._id);
  removed.stockBatches = lots.length;

  const orderCounter = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", "order"))
    .unique();
  if (orderCounter) await ctx.db.delete(orderCounter._id);

  return removed;
}

/**
 * A fixed-size (13 rows each) demo pass across every table the app shows on
 * screen — products, sales, customers, orders, costs and stock lots — so
 * every page has something on it instead of only the ones `demo` touches.
 *
 *   npx convex run seed:demoEverything
 *   npx convex run --prod seed:demoEverything
 *
 * Clears those tables first, so it is safe to re-run and always lands on the
 * same 13-of-each result. `allocationBuckets` (the profit split) and
 * everything auth-related are left alone — they are configuration, not
 * content.
 */
export const demoEverything = internalMutation({
  args: {},
  handler: async (ctx) => {
    const removed = await wipeEverything(ctx);
    await ensureBuckets(ctx);

    const random = makeRandom(20261001);
    const now = Date.now();

    const products: { id: Id<"products">; name: string; cost: number; sell: number }[] = [];
    for (let i = 0; i < DEMO_COUNT; i++) {
      const item = CATALOGUE[i % CATALOGUE.length];
      const id = await ctx.db.insert("products", {
        name: item.name,
        costPrice: item.cost,
        sellPrice: item.retailLow,
        details: item.details,
        category: item.category,
        quantity: item.stock + 15,
        archived: false,
        createdAt: now - Math.floor(random() * 120) * DAY,
      });
      products.push({ id, name: item.name, cost: item.cost, sell: item.retailLow });
    }

    const customers = DEMO_CUSTOMER_NAMES.slice(0, DEMO_COUNT).map((name, i) => ({
      name,
      phone: `017${String(10000000 + i * 137).slice(-8)}`,
      address: DEMO_AREAS[i % DEMO_AREAS.length],
    }));

    // One order per customer, so Orders and Customers agree with each other.
    let ordersCreated = 0;
    for (let i = 0; i < DEMO_COUNT; i++) {
      const customer = customers[i];
      const orderedAt = now - Math.floor(random() * 45) * DAY - Math.floor(random() * DAY);
      const lineCount = 1 + Math.floor(random() * 2);
      const items = [];
      for (let j = 0; j < lineCount; j++) {
        const product = products[Math.floor(random() * products.length)];
        items.push({
          productId: product.id,
          productName: product.name,
          quantity: 1 + Math.floor(random() * 3),
          unit: "পিস",
          unitPrice: product.sell,
          unitCost: product.cost,
        });
      }
      const subtotal = items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);
      const discount = random() < 0.2 ? Math.round(subtotal * 0.05) : 0;
      const deliveryCharge = random() < 0.5 ? 60 : 0;
      const total = subtotal - discount + deliveryCharge;
      const orderStatus = DEMO_ORDER_STATUSES[i % DEMO_ORDER_STATUSES.length];
      const paymentStatus = DEMO_PAYMENT_STATUSES[Math.floor(random() * DEMO_PAYMENT_STATUSES.length)];

      await ctx.db.insert("orders", {
        orderNo: `ORD-${String(i + 1).padStart(6, "0")}`,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerAddress: customer.address,
        orderedAt,
        items,
        subtotal,
        discount,
        deliveryCharge,
        total,
        paymentStatus,
        paidAmount: paymentStatus === "partial" ? Math.round(total * 0.5) : undefined,
        orderStatus,
        note: random() < 0.3 ? "Demo order." : undefined,
        source: "demo",
        createdAt: orderedAt,
      });
      ordersCreated++;

      await ctx.db.insert("customers", {
        name: customer.name,
        phone: customer.phone,
        whatsapp: customer.phone,
        address: customer.address,
        key: customerKey(customer.name, customer.phone),
        orderCount: 1,
        lastOrderedAt: orderedAt,
        createdAt: orderedAt,
      });
    }
    // Keeps numbering gap-free if a real order is placed after this seed runs.
    await ctx.db.insert("counters", { name: "order", value: DEMO_COUNT });

    let salesCreated = 0;
    for (let i = 0; i < DEMO_COUNT; i++) {
      const product = products[Math.floor(random() * products.length)];
      const quantity = random() < 0.75 ? 1 : 1 + Math.floor(random() * 3);
      const current = await ctx.db.get(product.id);
      if (!current || current.quantity < quantity) continue;
      await ctx.db.patch(product.id, { quantity: current.quantity - quantity });

      await ctx.db.insert("sales", {
        productId: product.id,
        productName: product.name,
        unitCost: product.cost,
        unitPrice: product.sell,
        quantity,
        buyer: random() < 0.65 ? DEMO_CUSTOMER_NAMES[Math.floor(random() * DEMO_CUSTOMER_NAMES.length)] : undefined,
        note: random() < 0.3 ? NOTES[Math.floor(random() * NOTES.length)] : undefined,
        soldAt: now - Math.floor(random() ** 1.7 * 30) * DAY - Math.floor(random() * DAY),
      });
      salesCreated++;
    }

    const costNameIds = new Map<string, Id<"costNames">>();
    let costsCreated = 0;
    for (let i = 0; i < DEMO_COUNT; i++) {
      const name = DEMO_COST_NAMES[i % DEMO_COST_NAMES.length];
      const key = name.toLowerCase().trim();
      const spentAt = now - Math.floor(random() * 30) * DAY - Math.floor(random() * DAY);

      let costNameId = costNameIds.get(key);
      if (!costNameId) {
        costNameId = await ctx.db.insert("costNames", {
          name,
          key,
          usageCount: 0,
          createdAt: spentAt,
        });
        costNameIds.set(key, costNameId);
      }
      const row = (await ctx.db.get(costNameId))!;
      await ctx.db.patch(costNameId, { usageCount: row.usageCount + 1, lastUsedAt: spentAt });

      await ctx.db.insert("costs", {
        name,
        costNameId,
        amount: 200 + Math.floor(random() * 2000),
        spentAt,
        note: random() < 0.3 ? "Paid via bKash." : undefined,
        createdAt: spentAt,
      });
      costsCreated++;
    }

    let lotsCreated = 0;
    for (let i = 0; i < DEMO_COUNT; i++) {
      const product = products[i % products.length];
      const quantity = 5 + Math.floor(random() * 30);
      await ctx.db.insert("stockBatches", {
        productId: product.id,
        productName: product.name,
        label: `Lot ${i + 1}`,
        purchasedAt: now - Math.floor(random() * 60) * DAY,
        quantity,
        remaining: quantity,
        unitCost: product.cost,
        unitPrice: product.sell,
      });
      lotsCreated++;
    }

    return (
      `Cleared ${Object.entries(removed)
        .map(([table, n]) => `${n} ${table}`)
        .join(", ")}. ` +
      `Seeded ${products.length} products, ${salesCreated} sales, ${customers.length} customers, ` +
      `${ordersCreated} orders, ${costsCreated} costs, ${lotsCreated} stock lots.`
    );
  },
});

const DEMO_VENDORS: {
  name: string;
  category: VendorCategory;
  phone: string;
  address: string;
  tin: string;
  tradeLicenseNo: string;
}[] = [
  {
    name: "Rifat Mushroom Spawn",
    category: "spawn",
    phone: "01710100001",
    address: "Savar, Dhaka",
    tin: "123456789001",
    tradeLicenseNo: "TRAD/DNCC/100001/2026",
  },
  {
    name: "Green Valley Culture Lab",
    category: "spawn",
    phone: "01710100002",
    address: "Gazipur",
    tin: "123456789002",
    tradeLicenseNo: "TRAD/GCC/100002/2026",
  },
  {
    name: "Dhaka Substrate Supply",
    category: "materials",
    phone: "01710100003",
    address: "Mirpur, Dhaka",
    tin: "123456789003",
    tradeLicenseNo: "TRAD/DNCC/100003/2026",
  },
  {
    name: "Bismillah Agro Chemicals",
    category: "materials",
    phone: "01710100004",
    address: "Tongi, Gazipur",
    tin: "123456789004",
    tradeLicenseNo: "TRAD/GCC/100004/2026",
  },
  {
    name: "Union Engineering Works",
    category: "equipment",
    phone: "01710100005",
    address: "Bogura",
    tin: "123456789005",
    tradeLicenseNo: "TRAD/BOG/100005/2026",
  },
  {
    name: "Packway Packaging",
    category: "packaging",
    phone: "01710100006",
    address: "Narayanganj",
    tin: "123456789006",
    tradeLicenseNo: "TRAD/NCC/100006/2026",
  },
  {
    name: "City Traders",
    category: "other",
    phone: "01710100007",
    address: "Mohammadpur, Dhaka",
    tin: "123456789007",
    tradeLicenseNo: "TRAD/DSCC/100007/2026",
  },
];

/** Folders every new vendor starts with — mirrors `vendors.create`. */
const STARTER_FOLDERS = ["TIN & Trade License", "Receipts", "Video"];

/**
 * A handful of demo vendors across every category, each with its starter
 * folders — so the Vendors page has something to look at.
 *
 *   npx convex run seed:demoVendors
 *   npx convex run --prod seed:demoVendors
 *
 * Clears existing vendors (and their folders/files) first, so it is safe to
 * re-run. Stock lots are untouched — this only ever clears their vendor link
 * via a cascading delete, never the lots themselves.
 */
export const demoVendors = internalMutation({
  args: {},
  handler: async (ctx) => {
    const media = await ctx.db.query("vendorMedia").collect();
    for (const m of media) {
      if (m.storageId) {
        try {
          await ctx.storage.delete(m.storageId);
        } catch {}
      }
      await ctx.db.delete(m._id);
    }
    const folders = await ctx.db.query("vendorFolders").collect();
    for (const f of folders) await ctx.db.delete(f._id);
    const existing = await ctx.db.query("vendors").collect();
    for (const v of existing) {
      const lots = await ctx.db
        .query("stockBatches")
        .withIndex("by_vendor", (q) => q.eq("vendorId", v._id))
        .collect();
      for (const l of lots) await ctx.db.patch(l._id, { vendorId: undefined, mediaIds: undefined });
      await ctx.db.delete(v._id);
    }

    const now = Date.now();
    for (const v of DEMO_VENDORS) {
      const id = await ctx.db.insert("vendors", { ...v, createdAt: now });
      for (const name of STARTER_FOLDERS) {
        await ctx.db.insert("vendorFolders", { vendorId: id, name, createdAt: now });
      }
    }

    return `Cleared ${existing.length} vendor(s). Seeded ${DEMO_VENDORS.length} vendors across every category.`;
  },
});
