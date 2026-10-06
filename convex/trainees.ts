import { mutation, query, type QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireSession, verifyPasscode } from "./auth";

/** Attaches a signed, short-lived photo URL — the stored `photoId` is never useful to the browser on its own. */
async function withPhoto<T extends { photoId?: Id<"_storage"> }>(ctx: QueryCtx, p: T) {
  const photoUrl = p.photoId ? await ctx.storage.getUrl(p.photoId) : null;
  return { ...p, photoUrl };
}

export const list = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const rows = await ctx.db.query("trainees").withIndex("by_createdAt").order("desc").collect();
    return await Promise.all(rows.map((r) => withPhoto(ctx, r)));
  },
});

/**
 * A trainee's whole profile: their info, the lessons allocated to them (and
 * which are done), and every file in their gallery.
 */
export const detail = query({
  args: { token: v.string(), id: v.id("trainees") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const trainee = await ctx.db.get(args.id);
    if (!trainee) return null;

    const [lessons, media] = await Promise.all([
      ctx.db
        .query("traineeLessons")
        .withIndex("by_trainee", (q) => q.eq("traineeId", args.id))
        .collect(),
      ctx.db
        .query("traineeMedia")
        .withIndex("by_trainee", (q) => q.eq("traineeId", args.id))
        .collect(),
    ]);

    const mediaWithUrl = await Promise.all(
      media.map(async (m) => ({ ...m, url: await ctx.storage.getUrl(m.storageId) })),
    );

    return {
      trainee: await withPhoto(ctx, trainee),
      lessons: [...lessons].sort((a, b) => a.order - b.order),
      media: mediaWithUrl.sort((a, b) => b.createdAt - a.createdAt),
    };
  },
});

function trim(value?: string) {
  return value?.trim() || undefined;
}

function validate(name: string) {
  if (!name.trim()) throw new ConvexError("A trainee needs a name.");
}

const profileArgs = {
  token: v.string(),
  name: v.string(),
  phone: v.optional(v.string()),
  fatherName: v.optional(v.string()),
  fatherPhone: v.optional(v.string()),
  motherName: v.optional(v.string()),
  motherPhone: v.optional(v.string()),
  bloodGroup: v.optional(v.string()),
  dateOfBirth: v.optional(v.number()),
  nationality: v.optional(v.string()),
  nidNumber: v.optional(v.string()),
  hometown: v.optional(v.string()),
  currentAddress: v.optional(v.string()),
  religion: v.optional(v.string()),
  facebookUrl: v.optional(v.string()),
  whatsapp: v.optional(v.string()),
  youtubeUrl: v.optional(v.string()),
  twitterUrl: v.optional(v.string()),
  tiktokUrl: v.optional(v.string()),
  linkedinUrl: v.optional(v.string()),
  note: v.optional(v.string()),
};

function profilePatch(args: Record<string, unknown> & { name: string; dateOfBirth?: number }) {
  return {
    name: args.name.trim(),
    phone: trim(args.phone as string | undefined),
    fatherName: trim(args.fatherName as string | undefined),
    fatherPhone: trim(args.fatherPhone as string | undefined),
    motherName: trim(args.motherName as string | undefined),
    motherPhone: trim(args.motherPhone as string | undefined),
    bloodGroup: trim(args.bloodGroup as string | undefined),
    dateOfBirth: args.dateOfBirth,
    nationality: trim(args.nationality as string | undefined),
    nidNumber: trim(args.nidNumber as string | undefined),
    hometown: trim(args.hometown as string | undefined),
    currentAddress: trim(args.currentAddress as string | undefined),
    religion: trim(args.religion as string | undefined),
    facebookUrl: trim(args.facebookUrl as string | undefined),
    whatsapp: trim(args.whatsapp as string | undefined),
    youtubeUrl: trim(args.youtubeUrl as string | undefined),
    twitterUrl: trim(args.twitterUrl as string | undefined),
    tiktokUrl: trim(args.tiktokUrl as string | undefined),
    linkedinUrl: trim(args.linkedinUrl as string | undefined),
    note: trim(args.note as string | undefined),
  };
}

export const create = mutation({
  args: profileArgs,
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    validate(args.name);
    return await ctx.db.insert("trainees", { ...profilePatch(args), createdAt: Date.now() });
  },
});

export const update = mutation({
  args: { ...profileArgs, id: v.id("trainees") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError("That trainee no longer exists.");
    validate(args.name);
    await ctx.db.patch(args.id, profilePatch(args));
  },
});

export const setPhoto = mutation({
  args: { token: v.string(), id: v.id("trainees"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError("That trainee no longer exists.");
    await ctx.db.patch(args.id, { photoId: args.storageId });
    if (row.photoId) await ctx.storage.delete(row.photoId);
  },
});

/** Removes a trainee, their lessons, and every file in their gallery. */
export const remove = mutation({
  args: { token: v.string(), id: v.id("trainees"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const row = await ctx.db.get(args.id);
    if (!row) return;
    if (row.photoId) await ctx.storage.delete(row.photoId);

    const [lessons, media] = await Promise.all([
      ctx.db
        .query("traineeLessons")
        .withIndex("by_trainee", (q) => q.eq("traineeId", args.id))
        .collect(),
      ctx.db
        .query("traineeMedia")
        .withIndex("by_trainee", (q) => q.eq("traineeId", args.id))
        .collect(),
    ]);
    for (const l of lessons) await ctx.db.delete(l._id);
    for (const m of media) {
      await ctx.storage.delete(m.storageId);
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(args.id);
  },
});

/* --------------------------------------------------------------- lessons */

export const addLesson = mutation({
  args: { token: v.string(), traineeId: v.id("trainees"), name: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const name = args.name.trim();
    if (!name) throw new ConvexError("A lesson needs a name.");
    const trainee = await ctx.db.get(args.traineeId);
    if (!trainee) throw new ConvexError("That trainee no longer exists.");
    const existing = await ctx.db
      .query("traineeLessons")
      .withIndex("by_trainee", (q) => q.eq("traineeId", args.traineeId))
      .collect();
    return await ctx.db.insert("traineeLessons", {
      traineeId: args.traineeId,
      name,
      completed: false,
      order: existing.length,
      createdAt: Date.now(),
    });
  },
});

export const setLessonCompleted = mutation({
  args: { token: v.string(), id: v.id("traineeLessons"), completed: v.boolean() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError("That lesson no longer exists.");
    await ctx.db.patch(args.id, {
      completed: args.completed,
      completedAt: args.completed ? Date.now() : undefined,
    });
  },
});

export const removeLesson = mutation({
  args: { token: v.string(), id: v.id("traineeLessons"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const row = await ctx.db.get(args.id);
    if (!row) return;
    await ctx.db.delete(args.id);
  },
});

/* ----------------------------------------------------------------- media */

export const generateUploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    return await ctx.storage.generateUploadUrl();
  },
});

export const attachMedia = mutation({
  args: {
    token: v.string(),
    traineeId: v.id("trainees"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    kind: v.union(v.literal("image"), v.literal("video")),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const trainee = await ctx.db.get(args.traineeId);
    if (!trainee) throw new ConvexError("That trainee no longer exists.");
    return await ctx.db.insert("traineeMedia", {
      traineeId: args.traineeId,
      storageId: args.storageId,
      fileName: args.fileName,
      kind: args.kind,
      createdAt: Date.now(),
    });
  },
});

export const removeMedia = mutation({
  args: { token: v.string(), id: v.id("traineeMedia"), passcode: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    await verifyPasscode(ctx, args.passcode);
    const row = await ctx.db.get(args.id);
    if (!row) return;
    await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
  },
});

/** Marks the certificate as issued, the first time one is generated. */
export const markCertificateIssued = mutation({
  args: { token: v.string(), id: v.id("trainees") },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.token);
    const row = await ctx.db.get(args.id);
    if (!row || row.certificateIssuedAt) return;
    await ctx.db.patch(args.id, { certificateIssuedAt: Date.now() });
  },
});
