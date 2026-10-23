import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireSession, verifyPasscode } from "./auth";

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
  Suppliers — who the shop buys stock from. The mirror image of `customers`,
  but with a fixed category (there are only a handful of real supplier roles
  in a mushroom business) and a media gallery (TIN, trade license, receipts)
  that a stock lot can point into without ever copying a file twice.
*/

/** Every vendor starts with these — renameable and deletable like any other folder. */
const STARTER_FOLDERS = ["TIN & Trade License", "Receipts", "Video"];

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const rows = await ctx.db.query("vendors").collect();
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    return await Promise.all(
      sorted.map(async (vendor) => {
        const lots = await ctx.db
          .query("stockBatches")
          .withIndex("by_vendor", (q) => q.eq("vendorId", vendor._id))
          .collect();
        /*
          Each purchase as a dated amount rather than a pre-summed "this
          month" — which month it is depends on the browser's timezone, so
          the card does that sum itself.
        */
        const purchases = lots.map((l) => ({ at: l.purchasedAt, amount: l.quantity * l.unitCost }));
        const due = lots.reduce(
          (sum, l) => sum + (l.vendorPaid !== undefined ? l.quantity * l.unitCost - l.vendorPaid : 0),
          0,
        );
        const lastPurchaseAt = purchases.length > 0 ? Math.max(...purchases.map((p) => p.at)) : null;
        return { ...(await withPhoto(ctx, vendor)), purchases, due, lastPurchaseAt };
      }),
    );
  },
});

export const get = query({
  args: { token: v.string(), id: v.id("vendors") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await ctx.db.get(args.id);
  },
});

/**
 * A vendor's whole profile: their info, their folders, every file in their
 * gallery (grouped by folder, with a signed URL each), and the lots bought
 * from them — so "what have I actually bought from this person" is one
 * screen instead of hunting through every product.
 */
export const detail = query({
  args: { token: v.string(), id: v.id("vendors") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const vendor = await ctx.db.get(args.id);
    if (!vendor) return null;

    const [folders, media, lots] = await Promise.all([
      ctx.db
        .query("vendorFolders")
        .withIndex("by_vendor", (q) => q.eq("vendorId", args.id))
        .collect(),
      ctx.db
        .query("vendorMedia")
        .withIndex("by_vendor", (q) => q.eq("vendorId", args.id))
        .collect(),
      ctx.db
        .query("stockBatches")
        .withIndex("by_vendor", (q) => q.eq("vendorId", args.id))
        .collect(),
    ]);

    const mediaWithUrl = await Promise.all(
      media.map(async (m) => ({
        _id: m._id,
        folderId: m.folderId ?? null,
        kind: m.kind,
        fileName: m.fileName,
        createdAt: m.createdAt,
        url: m.url ?? (m.storageId ? await ctx.storage.getUrl(m.storageId) : null),
      })),
    );

    return {
      vendor: await withPhoto(ctx, vendor),
      folders: [...folders].sort((a, b) => a.createdAt - b.createdAt),
      media: mediaWithUrl,
      lots: [...lots].sort((a, b) => b.purchasedAt - a.purchasedAt),
    };
  },
});

async function validate(ctx: MutationCtx, name: string, categoryId: Id<"vendorCategories"> | undefined) {
  if (!name.trim()) throw new ConvexError("A vendor needs a name.");
  if (categoryId && !(await ctx.db.get(categoryId))) {
    throw new ConvexError("That category no longer exists.");
  }
}

export const create = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    categoryId: v.optional(v.id("vendorCategories")),
    subCategoryId: v.optional(v.id("vendorCategories")),
    phone: v.optional(v.string()),
    extraPhones: v.optional(v.array(v.string())),
    whatsapp: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    address: v.optional(v.string()),
    tin: v.optional(v.string()),
    tradeLicenseNo: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await validate(ctx, args.name, args.categoryId);
    const now = Date.now();
    const id = await ctx.db.insert("vendors", {
      name: args.name.trim(),
      categoryId: args.categoryId,
      subCategoryId: args.subCategoryId,
      phone: args.phone?.trim() || undefined,
      extraPhones: cleanPhones(args.extraPhones),
      whatsapp: args.whatsapp?.trim() || undefined,
      facebookUrl: args.facebookUrl?.trim() || undefined,
      address: args.address?.trim() || undefined,
      tin: args.tin?.trim() || undefined,
      tradeLicenseNo: args.tradeLicenseNo?.trim() || undefined,
      note: args.note?.trim() || undefined,
      createdAt: now,
    });
    for (const name of STARTER_FOLDERS) {
      await ctx.db.insert("vendorFolders", { vendorId: id, name, createdAt: now });
    }
    return id;
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    id: v.id("vendors"),
    name: v.string(),
    categoryId: v.optional(v.id("vendorCategories")),
    subCategoryId: v.optional(v.id("vendorCategories")),
    phone: v.optional(v.string()),
    extraPhones: v.optional(v.array(v.string())),
    whatsapp: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    address: v.optional(v.string()),
    tin: v.optional(v.string()),
    tradeLicenseNo: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError("That vendor no longer exists.");
    await validate(ctx, args.name, args.categoryId);
    await ctx.db.patch(args.id, {
      name: args.name.trim(),
      categoryId: args.categoryId,
      subCategoryId: args.subCategoryId,
      // Picked from the editable list now, so the old fixed one goes.
      category: undefined,
      phone: args.phone?.trim() || undefined,
      extraPhones: cleanPhones(args.extraPhones),
      whatsapp: args.whatsapp?.trim() || undefined,
      facebookUrl: args.facebookUrl?.trim() || undefined,
      address: args.address?.trim() || undefined,
      tin: args.tin?.trim() || undefined,
      tradeLicenseNo: args.tradeLicenseNo?.trim() || undefined,
      note: args.note?.trim() || undefined,
    });
  },
});

/** Points a vendor at a newly uploaded photo, replacing whichever one they had. */
export const setPhoto = mutation({
  args: {
    token: v.string(),
    id: v.id("vendors"),
    photoUrl: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const vendor = await ctx.db.get(args.id);
    if (!vendor) throw new ConvexError("That vendor no longer exists.");
    const oldPhotoId = vendor.photoId;
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
  args: { token: v.string(), id: v.id("vendors") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const vendor = await ctx.db.get(args.id);
    if (!vendor) throw new ConvexError("That vendor no longer exists.");
    const oldPhotoId = vendor.photoId;
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
 * Removes a vendor, their folders and every file in their gallery. Lots
 * bought from them are kept — a lot is history, not a record that belongs to
 * the vendor — but the link is cleared since it would otherwise point at
 * nothing.
 */
export const remove = mutation({
  args: { token: v.string(), id: v.id("vendors"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);

    const media = await ctx.db
      .query("vendorMedia")
      .withIndex("by_vendor", (q) => q.eq("vendorId", args.id))
      .collect();
    for (const m of media) {
      if (m.storageId) {
        try {
          await ctx.storage.delete(m.storageId);
        } catch {}
      }
      await ctx.db.delete(m._id);
    }
    const folders = await ctx.db
      .query("vendorFolders")
      .withIndex("by_vendor", (q) => q.eq("vendorId", args.id))
      .collect();
    for (const f of folders) await ctx.db.delete(f._id);

    const lots = await ctx.db
      .query("stockBatches")
      .withIndex("by_vendor", (q) => q.eq("vendorId", args.id))
      .collect();
    for (const l of lots) {
      await ctx.db.patch(l._id, { vendorId: undefined, mediaIds: undefined });
    }

    await ctx.db.delete(args.id);
  },
});

/* ----------------------------------------------------------------- folders */

export const createFolder = mutation({
  args: { token: v.string(), vendorId: v.id("vendors"), name: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const name = args.name.trim();
    if (!name) throw new ConvexError("A folder needs a name.");
    const vendor = await ctx.db.get(args.vendorId);
    if (!vendor) throw new ConvexError("That vendor no longer exists.");
    return await ctx.db.insert("vendorFolders", {
      vendorId: args.vendorId,
      name,
      createdAt: Date.now(),
    });
  },
});

export const renameFolder = mutation({
  args: { token: v.string(), id: v.id("vendorFolders"), name: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const name = args.name.trim();
    if (!name) throw new ConvexError("A folder needs a name.");
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError("That folder no longer exists.");
    await ctx.db.patch(args.id, { name });
  },
});

/** Deletes a folder and everything filed in it. */
export const removeFolder = mutation({
  args: { token: v.string(), id: v.id("vendorFolders"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const folder = await ctx.db.get(args.id);
    if (!folder) return;

    const media = await ctx.db
      .query("vendorMedia")
      .withIndex("by_folder", (q) => q.eq("folderId", args.id))
      .collect();
    for (const m of media) {
      await unlinkMediaFromLots(ctx, folder.vendorId, m._id);
      if (m.storageId) {
        try {
          await ctx.storage.delete(m.storageId);
        } catch {}
      }
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(args.id);
  },
});

/* ------------------------------------------------------------------ media */

export const generateUploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Files a freshly uploaded storage object into a vendor's gallery. */
export const attachMedia = mutation({
  args: {
    token: v.string(),
    vendorId: v.id("vendors"),
    folderId: v.optional(v.id("vendorFolders")),
    storageId: v.optional(v.id("_storage")),
    url: v.optional(v.string()),
    fileName: v.string(),
    kind: v.union(v.literal("image"), v.literal("video")),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const vendor = await ctx.db.get(args.vendorId);
    if (!vendor) throw new ConvexError("That vendor no longer exists.");
    return await ctx.db.insert("vendorMedia", {
      vendorId: args.vendorId,
      folderId: args.folderId,
      storageId: args.storageId,
      url: args.url,
      kind: args.kind,
      fileName: args.fileName,
      createdAt: Date.now(),
    });
  },
});

async function unlinkMediaFromLots(
  ctx: MutationCtx,
  vendorId: Id<"vendors">,
  mediaId: Id<"vendorMedia">,
) {
  // Only lots from the same vendor can reference this file, so the scan is
  // bounded to one vendor's purchases rather than the whole ledger.
  const lots = await ctx.db
    .query("stockBatches")
    .withIndex("by_vendor", (q) => q.eq("vendorId", vendorId))
    .collect();
  for (const lot of lots) {
    if (!lot.mediaIds?.includes(mediaId)) continue;
    await ctx.db.patch(lot._id, { mediaIds: lot.mediaIds.filter((m) => m !== mediaId) });
  }
}

/** Deletes a file outright — not just unlinking it from one place it's used. */
export const removeMedia = mutation({
  args: { token: v.string(), id: v.id("vendorMedia"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const row = await ctx.db.get(args.id);
    if (!row) return;
    await unlinkMediaFromLots(ctx, row.vendorId, args.id);
    if (row.storageId) {
      try {
        await ctx.storage.delete(row.storageId);
      } catch {}
    }
    await ctx.db.delete(args.id);
  },
});

export const internalGenerateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const replaceMediaStorageId = internalMutation({
  args: {
    mediaId: v.id("vendorMedia"),
    newStorageId: v.id("_storage"),
    oldStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.mediaId);
    if (!row) throw new Error("Media row not found");
    if (row.storageId !== args.oldStorageId) {
      throw new Error(`Storage ID mismatch: expected ${args.oldStorageId}, got ${row.storageId}`);
    }
    await ctx.db.patch(args.mediaId, { storageId: args.newStorageId });
    await ctx.storage.delete(args.oldStorageId);
    return { ok: true, mediaId: args.mediaId, newStorageId: args.newStorageId };
  },
});
