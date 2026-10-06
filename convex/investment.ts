import { query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./auth";

/*
  Investment is a single running balance, not a ledger of its own — every
  change to it is a side effect of something that already has its own record
  (a stock purchase logged as a cost, a sale). `counters` already exists for
  exactly this shape of thing (see `nextOrderNo` in orders.ts), so this reuses
  it under the name "investment" rather than adding a one-row table.

  It starts at zero and is never backfilled automatically: stock bought before
  this existed was never added to it, so the shopkeeper sets the true starting
  number by hand once, the same way any ledger starts from a known balance.
*/
const COUNTER_NAME = "investment";

export async function adjustInvestment(ctx: MutationCtx, delta: number) {
  if (delta === 0) return;
  const row = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", COUNTER_NAME))
    .unique();
  const next = (row?.value ?? 0) + delta;
  if (row) await ctx.db.patch(row._id, { value: next });
  else await ctx.db.insert("counters", { name: COUNTER_NAME, value: next });
}

export const current = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const row = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", COUNTER_NAME))
      .unique();
    return row?.value ?? 0;
  },
});
