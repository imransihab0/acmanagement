"use node";

import { action } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { api } from "./_generated/api";

function getR2Client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new ConvexError("Cloudflare R2 is not configured in Convex environment variables.");
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function getBucketName() {
  return process.env.R2_BUCKET_NAME || "bdmushroom";
}

function getPublicUrlBase() {
  return (process.env.R2_PUBLIC_URL || "https://pub-d000c4a5bfd84b37be91842d8a0d3fb4.r2.dev").replace(/\/$/, "");
}

/**
 * Generates a presigned PUT URL allowing the client browser to upload directly to Cloudflare R2.
 */
export const generateUploadUrl = action({
  args: {
    token: v.optional(v.string()),
    folder: v.optional(v.string()),
    fileName: v.string(),
    contentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.token) {
      const session = await ctx.runQuery(api.auth.validate, { token: args.token });
      if (!session.valid) {
        throw new ConvexError("Unauthorized: Session is invalid or expired.");
      }
    }

    const client = getR2Client();
    const bucket = getBucketName();
    const publicBase = getPublicUrlBase();

    const folder = (args.folder ?? "media").replace(/^\/+|\/+$/g, "");
    const ext = args.fileName.includes(".")
      ? args.fileName.split(".").pop()!.toLowerCase()
      : "jpg";
    const unique = Math.random().toString(36).slice(2, 10);
    const key = `${folder}/${Date.now()}-${unique}.${ext}`;
    const contentType = args.contentType || "application/octet-stream";

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });
    const publicUrl = `${publicBase}/${key}`;

    return { uploadUrl, key, publicUrl };
  },
});

/**
 * Deletes an object from Cloudflare R2 by key or full public URL.
 */
export const deleteObject = action({
  args: {
    token: v.optional(v.string()),
    keyOrUrl: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.token) {
      const session = await ctx.runQuery(api.auth.validate, { token: args.token });
      if (!session.valid) {
        throw new ConvexError("Unauthorized: Session is invalid or expired.");
      }
    }

    try {
      const client = getR2Client();
      const bucket = getBucketName();
      const publicBase = getPublicUrlBase();

      let key = args.keyOrUrl.trim();
      if (key.startsWith(publicBase)) {
        key = key.slice(publicBase.length).replace(/^\/+/, "");
      } else if (key.startsWith("http://") || key.startsWith("https://")) {
        try {
          const parsed = new URL(key);
          key = parsed.pathname.replace(/^\/+/, "");
        } catch {}
      }

      if (!key) return { success: false, error: "Missing key" };

      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );

      return { success: true };
    } catch (err: any) {
      console.warn("Cloudflare R2 delete failed:", err?.message || err);
      return { success: false, error: err?.message || String(err) };
    }
  },
});
