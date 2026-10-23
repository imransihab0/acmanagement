import { useEffect, useState } from "react";
import { BarChart3, Globe, MapPin, MessageCircle, Phone, UserRound } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Modal, cx } from "./ui";
import { ContactPhotoAvatar } from "./ContactPhotoAvatar";
import { CustomerDashboardPanel, ReceiptPanel } from "./CustomerDashboard";
import { useT } from "../lib/i18n";
import { avatarGradientFor } from "../lib/avatar";
import { useAuthedAction, useAuthedMutation, useAuthedQuery } from "../lib/session";
import { uploadFileToR2 } from "../lib/upload";
import { externalUrl, whatsappUrl } from "../../convex/shared";

/**
 * One customer: who they are, and — a click away — what they have bought.
 *
 * The profile stays short. Their numbers and receipts open as a dashboard
 * beside it, and a receipt opens beside that, the profile sliding out of the
 * way while it is open and back when it closes.
 */
export function CustomerDetailDialog({
  open,
  onClose,
  customerId,
}: {
  open: boolean;
  onClose: () => void;
  customerId: Id<"customers"> | null;
}) {
  const t = useT();
  const data = useAuthedQuery(api.customers.detail, customerId ? { id: customerId } : "skip");
  const generateR2UploadUrl = useAuthedAction(api.r2.generateUploadUrl);
  const setPhoto = useAuthedMutation(api.customers.setPhoto);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [receiptId, setReceiptId] = useState<Id<"orders"> | null>(null);
  useEffect(() => {
    if (!open) {
      setDashboardOpen(false);
      setReceiptId(null);
    }
  }, [open, customerId]);

  const name = data?.customer.name ?? "";
  // Read from the live list, so a payment recorded elsewhere shows here too.
  const receipt: Doc<"orders"> | null = receiptId ? (data?.sales.find((o) => o._id === receiptId) ?? null) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={
        data?.customer ? (
          <ContactPhotoAvatar
            name={name}
            photoUrl={data.customer.photoUrl}
            onUpload={async (file) => {
              const { publicUrl } = await uploadFileToR2(generateR2UploadUrl, file, "customers");
              await setPhoto({ id: data.customer._id, photoUrl: publicUrl });
            }}
          />
        ) : (
          <UserRound size={19} />
        )
      }
      iconInteractive={Boolean(data?.customer)}
      gradient={name ? avatarGradientFor(name) : undefined}
      title={name || t("customers.title")}
      subtitle={data?.customer.phone ?? data?.customer.address ?? undefined}
      width="sm:max-w-2xl"
      onBack={() => (receiptId ? setReceiptId(null) : setDashboardOpen(false))}
      aside={
        dashboardOpen && data ? (
          <CustomerDashboardPanel
            name={name}
            orders={data.sales}
            openId={receiptId ?? undefined}
            onOpenReceipt={(o) => setReceiptId(o._id)}
            onClose={() => {
              setReceiptId(null);
              setDashboardOpen(false);
            }}
          />
        ) : undefined
      }
      detail={receipt ? <ReceiptPanel order={receipt} onClose={() => setReceiptId(null)} /> : undefined}
    >
      {!data ? (
        <div className="ac-skeleton h-64 bg-surface" aria-hidden />
      ) : (
        <div className="flex flex-col gap-6 px-6 py-6">
          {(data.customer.phone || data.customer.address || data.customer.facebookUrl) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-2">
              {data.customer.phone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone size={14} className="text-ink-3" aria-hidden />
                  {data.customer.phone}
                </span>
              )}
              {data.customer.extraPhones?.map((p, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                  <Phone size={14} className="text-ink-3" aria-hidden />
                  {p}
                </span>
              ))}
              {/* The two that are worth a click get one. */}
              {whatsappUrl(data.customer.whatsapp ?? data.customer.phone) && (
                <a
                  href={whatsappUrl(data.customer.whatsapp ?? data.customer.phone)!}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 font-semibold text-good-ink hover:underline"
                >
                  <MessageCircle size={14} aria-hidden />
                  {data.customer.whatsapp && data.customer.whatsapp !== data.customer.phone
                    ? data.customer.whatsapp
                    : t("customers.whatsapp")}
                </a>
              )}
              {externalUrl(data.customer.facebookUrl) && (
                <a
                  href={externalUrl(data.customer.facebookUrl)!}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline"
                >
                  <Globe size={14} aria-hidden />
                  {t("customers.facebook")}
                </a>
              )}
              {data.customer.address && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin size={14} className="text-ink-3" aria-hidden />
                  {data.customer.address}
                </span>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              if (dashboardOpen) setReceiptId(null);
              setDashboardOpen((v) => !v);
            }}
            aria-expanded={dashboardOpen}
            className={cx(
              "ac-glow group flex w-full items-center justify-center gap-2 rounded-2xl border px-4 py-3.5",
              "border-accent/40 bg-accent-soft/40 text-[13.5px] font-medium tracking-wide text-ink-2",
              "transition-colors hover:bg-accent-soft hover:text-ink",
            )}
          >
            <BarChart3 size={16} className="text-accent transition-transform group-hover:scale-110" />
            {dashboardOpen ? t("vendors.hideDashboard") : t("vendors.dashboard")}
          </button>
        </div>
      )}
    </Modal>
  );
}
