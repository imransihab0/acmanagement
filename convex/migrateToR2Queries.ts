import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

export const getItemsToMigrate = internalQuery({
  args: {},
  handler: async (ctx: QueryCtx) => {
    // 1. Products
    const products = await ctx.db.query("products").collect();
    const productsToMigrate = await Promise.all(
      products
        .filter((p) => p.photoId && !p.photoUrl)
        .map(async (p) => {
          const url = await ctx.storage.getUrl(p.photoId!);
          return {
            id: p._id,
            table: "products" as const,
            name: p.name,
            storageId: p.photoId!,
            signedUrl: url,
          };
        }),
    );

    // 2. Customers
    const customers = await ctx.db.query("customers").collect();
    const customersToMigrate = await Promise.all(
      customers
        .filter((c) => c.photoId && !c.photoUrl)
        .map(async (c) => {
          const url = await ctx.storage.getUrl(c.photoId!);
          return {
            id: c._id,
            table: "customers" as const,
            name: c.name,
            storageId: c.photoId!,
            signedUrl: url,
          };
        }),
    );

    // 3. Vendors
    const vendors = await ctx.db.query("vendors").collect();
    const vendorsToMigrate = await Promise.all(
      vendors
        .filter((v) => v.photoId && !v.photoUrl)
        .map(async (v) => {
          const url = await ctx.storage.getUrl(v.photoId!);
          return {
            id: v._id,
            table: "vendors" as const,
            name: v.name,
            storageId: v.photoId!,
            signedUrl: url,
          };
        }),
    );

    // 4. VendorMedia
    const vendorMedia = await ctx.db.query("vendorMedia").collect();
    const mediaToMigrate = await Promise.all(
      vendorMedia
        .filter((m) => m.storageId && !m.url)
        .map(async (m) => {
          const url = await ctx.storage.getUrl(m.storageId!);
          return {
            id: m._id,
            table: "vendorMedia" as const,
            name: m.fileName,
            storageId: m.storageId!,
            signedUrl: url,
          };
        }),
    );

    return {
      products: productsToMigrate.filter((p) => p.signedUrl !== null),
      customers: customersToMigrate.filter((c) => c.signedUrl !== null),
      vendors: vendorsToMigrate.filter((v) => v.signedUrl !== null),
      vendorMedia: mediaToMigrate.filter((m) => m.signedUrl !== null),
    };
  },
});

export const updateProductUrl = internalMutation({
  args: { id: v.id("products"), photoUrl: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { photoUrl: args.photoUrl });
  },
});

export const updateCustomerUrl = internalMutation({
  args: { id: v.id("customers"), photoUrl: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { photoUrl: args.photoUrl });
  },
});

export const updateVendorUrl = internalMutation({
  args: { id: v.id("vendors"), photoUrl: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { photoUrl: args.photoUrl });
  },
});

export const updateVendorMediaUrl = internalMutation({
  args: { id: v.id("vendorMedia"), url: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { url: args.url });
  },
});
