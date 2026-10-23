"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

function getR2Client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 environment variables are missing.");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function getBucketName() {
  return process.env.R2_BUCKET_NAME || "bdmushroom";
}

function getPublicUrlBase() {
  return (process.env.R2_PUBLIC_URL || "https://pub-d000c4a5bfd84b37be91842d8a0d3fb4.r2.dev").replace(/\/$/, "");
}

export const runMigration = internalAction({
  args: {},
  handler: async (ctx) => {
    const client = getR2Client();
    const bucket = getBucketName();
    const publicBase = getPublicUrlBase();

    const items = await ctx.runQuery(internal.migrateToR2Queries.getItemsToMigrate);
    const results = {
      productsMigrated: 0,
      customersMigrated: 0,
      vendorsMigrated: 0,
      mediaMigrated: 0,
      errors: [] as string[],
    };

    // Helper to transfer one file from Convex to R2
    async function transferFile(signedUrl: string, key: string) {
      const res = await fetch(signedUrl);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      const bytes = new Uint8Array(await res.arrayBuffer());

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
        }),
      );
      return `${publicBase}/${key}`;
    }

    // 1. Products
    for (const p of items.products) {
      try {
        const key = `products/${p.id}.webp`;
        const publicUrl = await transferFile(p.signedUrl!, key);
        await ctx.runMutation(internal.migrateToR2Queries.updateProductUrl, {
          id: p.id,
          photoUrl: publicUrl,
        });
        results.productsMigrated++;
      } catch (err: any) {
        results.errors.push(`Product ${p.name} (${p.id}): ${err.message}`);
      }
    }

    // 2. Customers
    for (const c of items.customers) {
      try {
        const key = `customers/${c.id}.webp`;
        const publicUrl = await transferFile(c.signedUrl!, key);
        await ctx.runMutation(internal.migrateToR2Queries.updateCustomerUrl, {
          id: c.id,
          photoUrl: publicUrl,
        });
        results.customersMigrated++;
      } catch (err: any) {
        results.errors.push(`Customer ${c.name} (${c.id}): ${err.message}`);
      }
    }

    // 3. Vendors
    for (const v of items.vendors) {
      try {
        const key = `vendors/${v.id}.webp`;
        const publicUrl = await transferFile(v.signedUrl!, key);
        await ctx.runMutation(internal.migrateToR2Queries.updateVendorUrl, {
          id: v.id,
          photoUrl: publicUrl,
        });
        results.vendorsMigrated++;
      } catch (err: any) {
        results.errors.push(`Vendor ${v.name} (${v.id}): ${err.message}`);
      }
    }

    // 4. Vendor Media
    for (const m of items.vendorMedia) {
      try {
        const ext = m.name.includes(".") ? m.name.split(".").pop()!.toLowerCase() : "bin";
        const key = `vendors/gallery/${m.id}.${ext}`;
        const publicUrl = await transferFile(m.signedUrl!, key);
        await ctx.runMutation(internal.migrateToR2Queries.updateVendorMediaUrl, {
          id: m.id,
          url: publicUrl,
        });
        results.mediaMigrated++;
      } catch (err: any) {
        results.errors.push(`Media ${m.name} (${m.id}): ${err.message}`);
      }
    }

    return results;
  },
});
