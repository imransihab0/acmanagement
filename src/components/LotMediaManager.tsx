import { useRef, useState } from "react";
import { Check, Image as ImageIcon, Link2, Trash2, Upload, Video as VideoIcon } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button, cx } from "./ui";
import { useT } from "../lib/i18n";
import { errorMessage, useToast } from "../lib/toast";
import { useAuthedAction, useAuthedMutation, useAuthedQuery } from "../lib/session";
import { mediaKindOf, uploadFileToR2, useFileDrop, useUploadProgress } from "../lib/upload";

/**
 * The receipts/photos/videos attached to one stock lot — shared by the lot's
 * own detail view and its edit form, so "view what's attached" and "add
 * more" work the same way no matter which one opened it.
 *
 * Needs a saved lot to attach anything to, which is why this only renders
 * once a lot has an id — a lot being created has nothing to point media at
 * yet.
 */
export function LotMediaManager({ lotId }: { lotId: Id<"stockBatches"> }) {
  const t = useT();
  const toast = useToast();
  const data = useAuthedQuery(api.profit.lotDetail, { id: lotId });
  const vendorData = useAuthedQuery(
    api.vendors.detail,
    data?.vendor ? { id: data.vendor._id } : "skip",
  );
  const generateR2UploadUrl = useAuthedAction(api.r2.generateUploadUrl);
  const attachVendorMedia = useAuthedMutation(api.vendors.attachMedia);
  const attachLotMedia = useAuthedMutation(api.profit.attachLotMedia);
  const removeLotMedia = useAuthedMutation(api.profit.removeLotMedia);

  const [uploading, setUploading] = useState(false);
  const [picking, setPicking] = useState(false);
  const uploadStatus = useUploadProgress();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const vendor = data?.vendor;
  const media = data?.media ?? [];
  const attachedIds = new Set(media.map((m) => m._id));
  const pickable = (vendorData?.media ?? []).filter((m) => !attachedIds.has(m._id));

  async function handleUpload(file: File) {
    if (!vendor) return;
    setUploading(true);
    try {
      const { publicUrl } = await uploadFileToR2(generateR2UploadUrl, file, "lots");
      const mediaId = await attachVendorMedia({
        vendorId: vendor._id,
        url: publicUrl,
        fileName: file.name,
        kind: mediaKindOf(file),
      });
      await attachLotMedia({ lotId, mediaId });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleAttachExisting(mediaId: Id<"vendorMedia">) {
    try {
      await attachLotMedia({ lotId, mediaId });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleDetach(mediaId: Id<"vendorMedia">) {
    try {
      await removeLotMedia({ lotId, mediaId });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const { dragOver, dropProps } = useFileDrop((file) => void handleUpload(file));

  return (
    <div>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <p className="text-[10.5px] font-bold tracking-[0.09em] text-ink-3 uppercase">
          {t("lot.media")}
        </p>
        {vendor && (
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant="secondary" onClick={() => setPicking((v) => !v)}>
              <Link2 size={14} />
              {t("lot.attachExisting")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} />
              {uploading ? t("vendors.uploading") : t("lot.uploadNew")}
            </Button>
          </div>
        )}
      </div>
      {uploading && uploadStatus && (
        <div className="mb-2 rounded-xl border border-line bg-page p-2.5">
          <div className="flex items-center justify-between text-[11.5px] text-ink-3 mb-1.5">
            <span>{uploadStatus.stage === "compressing" ? "Compressing media..." : "Uploading..."}</span>
            <span className="font-semibold tabular-nums">{uploadStatus.progress}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent transition-all duration-200"
              style={{ width: `${Math.max(5, uploadStatus.progress)}%` }}
            />
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleUpload(file);
        }}
      />

      {!vendor ? (
        <p className="text-[13px] text-ink-3">{t("lot.needVendorFirst")}</p>
      ) : picking ? (
        <div className="rounded-xl border border-line bg-page p-2">
          {pickable.length === 0 ? (
            <p className="px-2 py-3 text-[13px] text-ink-3">{t("lot.noFiles")}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {pickable.map((m) => (
                <button
                  key={m._id}
                  type="button"
                  onClick={() => void handleAttachExisting(m._id)}
                  className="group relative overflow-hidden rounded-lg border border-line"
                >
                  {m.url && m.kind === "image" ? (
                    <img src={m.url} alt="" className="aspect-square w-full object-cover" />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center bg-surface-2 text-ink-3">
                      <VideoIcon size={18} />
                    </div>
                  )}
                  <span className="absolute inset-0 flex items-center justify-center bg-ink/0 opacity-0 transition-all group-hover:bg-ink/40 group-hover:opacity-100">
                    <Check size={18} className="text-white" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          {...dropProps}
          className={cx(
            "rounded-xl transition-colors",
            dragOver && "bg-accent-soft ring-2 ring-accent",
          )}
        >
          {media.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
              <p className="text-[13px] text-ink-3">{t("lot.noMedia")}</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 p-1 sm:grid-cols-4">
              {media.map((m) => (
                <div
                  key={m._id}
                  className="group relative overflow-hidden rounded-lg border border-line bg-page"
                >
                  {m.url && m.kind === "image" ? (
                    <img src={m.url} alt="" className="aspect-square w-full object-cover" />
                  ) : m.url ? (
                    <video
                      src={m.url}
                      controls
                      className="aspect-square w-full bg-black object-contain"
                    />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center text-ink-3">
                      <ImageIcon size={18} />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDetach(m._id)}
                    aria-label={`${t("lot.detach")} — ${m.fileName}`}
                    className="absolute top-1 right-1 rounded-md bg-page/90 p-1 text-ink-3 opacity-0 backdrop-blur-sm transition-opacity hover:text-critical group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
