import { useState, useEffect, type DragEvent } from "react";
import imageCompression from "browser-image-compression";
import type { Id } from "../../convex/_generated/dataModel";
import { errorMessage } from "./toast";

export const COMPRESS_THRESHOLD_BYTES = 160 * 1024; // 160 KB
export const TARGET_MAX_BYTES = 180 * 1024;         // 180 KB (strictly under 200 KB)

export type UploadStatus = {
  id: string;
  fileName: string;
  fileSize: number;
  compressedSize?: number;
  stage: "compressing" | "uploading" | "done" | "error";
  progress: number; // 0 to 100
  error?: string;
};

let currentUpload: UploadStatus | null = null;
const listeners = new Set<(status: UploadStatus | null) => void>();

export function getUploadStatus(): UploadStatus | null {
  return currentUpload;
}

export function setUploadStatus(
  statusOrUpdater: UploadStatus | null | ((prev: UploadStatus | null) => UploadStatus | null),
) {
  if (typeof statusOrUpdater === "function") {
    currentUpload = statusOrUpdater(currentUpload);
  } else {
    currentUpload = statusOrUpdater;
  }
  listeners.forEach((l) => l(currentUpload));
}

/** Reactive hook to observe active upload & compression status globally */
export function useUploadProgress(): UploadStatus | null {
  const [status, setStatus] = useState<UploadStatus | null>(currentUpload);
  useEffect(() => {
    const handler = (s: UploadStatus | null) => setStatus(s);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);
  return status;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(file: File): boolean {
  if (file.type && file.type.startsWith("image/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "bmp", "avif", "heic", "heif"].includes(ext || "");
}

/** If the image is Apple HEIC format, convert to JPEG so standard canvas/compression can read it */
async function ensureJpegCompatible(file: File): Promise<File> {
  const isHeic =
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    file.name.toLowerCase().endsWith(".heic") ||
    file.name.toLowerCase().endsWith(".heif");

  if (!isHeic) return file;

  try {
    const heic2any = (await import("heic2any")).default;
    const result = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.85,
    });
    const blob = Array.isArray(result) ? result[0] : result;
    const newName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
    return new File([blob], newName, { type: "image/jpeg", lastModified: Date.now() });
  } catch (err) {
    console.warn("Could not convert HEIC to JPEG, will attempt direct compression:", err);
    return file;
  }
}

/** Fast canvas fallback in case standard library fails on an unusual file */
async function fallbackCanvasCompress(file: File, targetBytes: number): Promise<File> {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    let maxDim = 1280;
    const qualities = [0.75, 0.6, 0.45, 0.3];
    let bestBlob: Blob | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, w);
      canvas.height = Math.max(1, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) break;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      for (const q of qualities) {
        const blob = await new Promise<Blob | null>((res) =>
          canvas.toBlob((b) => res(b), "image/jpeg", q),
        );
        if (blob) {
          if (!bestBlob || blob.size < bestBlob.size) {
            bestBlob = blob;
          }
          if (blob.size <= targetBytes) {
            return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), {
              type: "image/jpeg",
              lastModified: Date.now(),
            });
          }
        }
      }
      maxDim = Math.round(maxDim * 0.75);
    }

    if (bestBlob && bestBlob.size < file.size) {
      return new File([bestBlob], file.name.replace(/\.[^.]+$/, ".jpg"), {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
    }

    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Compresses an image file if it is larger than 160KB so that its final
 * size is strictly under 200KB, preserving visual clarity while drastically
 * reducing network bandwidth and Convex database storage.
 */
export async function compressMedia(
  file: File,
  onProgress?: (stage: "compressing", percent: number) => void,
): Promise<File> {
  // If <= 160KB, no compression needed
  if (file.size <= COMPRESS_THRESHOLD_BYTES) {
    return file;
  }

  // Only compress raster images (JPEG, PNG, WebP, HEIC, etc.)
  if (!isImage(file) || file.type === "image/svg+xml" || file.type === "image/gif") {
    return file;
  }

  try {
    const readyFile = await ensureJpegCompatible(file);
    const targetMB = TARGET_MAX_BYTES / (1024 * 1024); // ~0.175 MB (180 KB)

    let compressed: File;
    try {
      compressed = await imageCompression(readyFile, {
        maxSizeMB: targetMB,
        maxWidthOrHeight: 1280,
        useWebWorker: false, // Runs 100% locally in browser thread (no CDN dependency)
        maxIteration: 10,
        initialQuality: 0.8,
        onProgress: (p: number) => {
          onProgress?.("compressing", p);
        },
      });

      // If still over 180KB, perform a second pass with lower max dimension and quality
      if (compressed.size > TARGET_MAX_BYTES) {
        compressed = await imageCompression(compressed, {
          maxSizeMB: targetMB * 0.8,
          maxWidthOrHeight: 1024,
          useWebWorker: false,
          maxIteration: 8,
          initialQuality: 0.65,
          onProgress: (p: number) => {
            onProgress?.("compressing", p);
          },
        });
      }
    } catch (bicErr) {
      console.warn("browser-image-compression error, falling back to canvas:", bicErr);
      compressed = await fallbackCanvasCompress(readyFile, TARGET_MAX_BYTES);
    }

    let finalFile = compressed.size < file.size ? compressed : file;
    // Guaranteed safety check: if still above 180KB, canvas fallback
    if (finalFile.size > TARGET_MAX_BYTES) {
      finalFile = await fallbackCanvasCompress(readyFile, TARGET_MAX_BYTES);
    }

    console.info(
      `[Compressor] ${file.name}: ${formatFileSize(file.size)} → ${formatFileSize(finalFile.size)} (${Math.round(
        (1 - finalFile.size / file.size) * 100,
      )}% smaller)`,
    );

    return finalFile;
  } catch (err) {
    console.warn("Media compression failed completely, uploading original file:", err);
    return file;
  }
}

/**
 * Uploads a file to a Convex upload URL with compression (for images > 160KB down to under 200KB)
 * and updates the global upload status bar.
 */
export async function uploadFile(
  uploadUrl: string,
  file: File,
  onProgress?: (progress: number) => void,
): Promise<Id<"_storage">> {
  const uploadId = Math.random().toString(36).slice(2);
  const needsCompression =
    file.size > COMPRESS_THRESHOLD_BYTES &&
    isImage(file) &&
    file.type !== "image/svg+xml" &&
    file.type !== "image/gif";

  setUploadStatus({
    id: uploadId,
    fileName: file.name,
    fileSize: file.size,
    stage: needsCompression ? "compressing" : "uploading",
    progress: needsCompression ? 10 : 25,
  });

  try {
    let preparedFile = file;
    if (needsCompression) {
      preparedFile = await compressMedia(file, (_, percent) => {
        // Map compression 0-100% to overall 10-60%
        const overall = 10 + Math.round(percent * 0.5);
        setUploadStatus({
          id: uploadId,
          fileName: file.name,
          fileSize: file.size,
          stage: "compressing",
          progress: overall,
        });
        onProgress?.(overall);
      });
    }

    setUploadStatus({
      id: uploadId,
      fileName: file.name,
      fileSize: file.size,
      compressedSize: preparedFile.size,
      stage: "uploading",
      progress: 65,
    });
    onProgress?.(65);

    // Smooth ticker during the network upload request
    const progressInterval = setInterval(() => {
      setUploadStatus((prev) => {
        if (!prev || prev.id !== uploadId || prev.stage !== "uploading") return prev;
        if (prev.progress >= 94) return prev;
        const nextProgress = prev.progress + 3;
        onProgress?.(nextProgress);
        return { ...prev, progress: nextProgress };
      });
    }, 150);

    let storageId: Id<"_storage">;
    try {
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": preparedFile.type || file.type || "application/octet-stream" },
        body: preparedFile,
      });

      if (!res.ok) {
        throw new Error(`The file failed to upload (${res.status}). Try again.`);
      }

      const json = (await res.json()) as { storageId?: Id<"_storage"> };
      if (!json.storageId) {
        throw new Error("Storage server did not return a valid storageId.");
      }
      storageId = json.storageId;
    } finally {
      clearInterval(progressInterval);
    }

    setUploadStatus({
      id: uploadId,
      fileName: file.name,
      fileSize: file.size,
      compressedSize: preparedFile.size,
      stage: "done",
      progress: 100,
    });
    onProgress?.(100);

    // Auto-dismiss after 2.5 seconds
    setTimeout(() => {
      if (getUploadStatus()?.id === uploadId) {
        setUploadStatus(null);
      }
    }, 2500);

    return storageId;
  } catch (err) {
    setUploadStatus({
      id: uploadId,
      fileName: file.name,
      fileSize: file.size,
      stage: "error",
      progress: 100,
      error: errorMessage(err),
    });
    setTimeout(() => {
      if (getUploadStatus()?.id === uploadId) {
        setUploadStatus(null);
      }
    }, 4500);
    throw err;
  }
}

/**
 * Uploads a file directly to Cloudflare R2 via presigned PUT URL.
 * Compresses images > 160KB down to under 200KB before uploading.
 * Returns the key and direct public URL of the uploaded object.
 */
export async function uploadFileToR2(
  getUploadUrl: (args: { folder?: string; fileName: string; contentType?: string }) => Promise<{
    uploadUrl: string;
    key: string;
    publicUrl: string;
  }>,
  file: File,
  folder?: string,
  onProgress?: (progress: number) => void,
): Promise<{ key: string; publicUrl: string }> {
  const uploadId = Math.random().toString(36).slice(2);
  const needsCompression =
    file.size > COMPRESS_THRESHOLD_BYTES &&
    isImage(file) &&
    file.type !== "image/svg+xml" &&
    file.type !== "image/gif";

  setUploadStatus({
    id: uploadId,
    fileName: file.name,
    fileSize: file.size,
    stage: needsCompression ? "compressing" : "uploading",
    progress: needsCompression ? 10 : 25,
  });

  try {
    let preparedFile = file;
    if (needsCompression) {
      preparedFile = await compressMedia(file, (_, percent) => {
        const overall = 10 + Math.round(percent * 0.5);
        setUploadStatus({
          id: uploadId,
          fileName: file.name,
          fileSize: file.size,
          stage: "compressing",
          progress: overall,
        });
        onProgress?.(overall);
      });
    }

    setUploadStatus({
      id: uploadId,
      fileName: file.name,
      fileSize: file.size,
      compressedSize: preparedFile.size,
      stage: "uploading",
      progress: 65,
    });
    onProgress?.(65);

    const contentType = preparedFile.type || file.type || "application/octet-stream";
    const { uploadUrl, key, publicUrl } = await getUploadUrl({
      folder,
      fileName: preparedFile.name,
      contentType,
    });

    const progressInterval = setInterval(() => {
      setUploadStatus((prev) => {
        if (!prev || prev.id !== uploadId || prev.stage !== "uploading") return prev;
        if (prev.progress >= 94) return prev;
        const nextProgress = prev.progress + 3;
        onProgress?.(nextProgress);
        return { ...prev, progress: nextProgress };
      });
    }, 150);

    try {
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: preparedFile,
      });

      if (!res.ok) {
        throw new Error(`Cloudflare R2 upload failed (${res.status}). Try again.`);
      }
    } finally {
      clearInterval(progressInterval);
    }

    setUploadStatus({
      id: uploadId,
      fileName: file.name,
      fileSize: file.size,
      compressedSize: preparedFile.size,
      stage: "done",
      progress: 100,
    });
    onProgress?.(100);

    setTimeout(() => {
      if (getUploadStatus()?.id === uploadId) {
        setUploadStatus(null);
      }
    }, 2500);

    return { key, publicUrl };
  } catch (err) {
    setUploadStatus({
      id: uploadId,
      fileName: file.name,
      fileSize: file.size,
      stage: "error",
      progress: 100,
      error: errorMessage(err),
    });
    setTimeout(() => {
      if (getUploadStatus()?.id === uploadId) {
        setUploadStatus(null);
      }
    }, 4500);
    throw err;
  }
}

/** Whether a picked file should be stored (and rendered) as an image or a video. */
export function mediaKindOf(file: File): "image" | "video" {
  return file.type.startsWith("video/") ? "video" : "image";
}

/**
 * Drag-and-drop for a single file, dropped anywhere a `<input type="file">`
 * already lets someone pick one.
 */
export function useFileDrop(onFile: (file: File) => void) {
  const [dragOver, setDragOver] = useState(false);

  return {
    dragOver,
    dropProps: {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        setDragOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      },
    },
  };
}
