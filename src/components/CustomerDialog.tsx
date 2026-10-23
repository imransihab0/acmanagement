import { useEffect, useRef, useState } from "react";
import { ArrowRight, Camera, Globe, MessageCircle, Trash2, Upload, UserRound } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button, Field, Input, Modal, ModalFooter, Textarea, cx } from "./ui";
import { PhoneListField } from "./PhoneListField";
import { useT } from "../lib/i18n";
import { errorMessage, useToast } from "../lib/toast";
import { useAuthedAction, useAuthedMutation } from "../lib/session";
import { normalisePhone } from "../../convex/shared";
import { uploadFileToR2, useFileDrop, useUploadProgress } from "../lib/upload";
import { avatarThemeFor } from "../lib/avatar";

/** What the dialog needs to edit someone — the list query's shape, not the row's. */
export type EditableCustomer = {
  _id: Id<"customers">;
  name: string;
  photoUrl?: string | null;
  phone?: string;
  extraPhones?: string[];
  whatsapp?: string;
  facebookUrl?: string;
  address?: string;
};

/**
 * Adds or corrects a customer by hand.
 *
 * The phone is the one field that carries weight: it is what decides whether
 * two entries are the same person, here and everywhere else. Saving without
 * one is allowed — plenty of counter customers never give a number — but then
 * the name has to do that job, and two people sharing a name will collide.
 */
export function CustomerDialog({
  open,
  onClose,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  /** Present when editing someone already saved. */
  customer?: EditableCustomer | null;
}) {
  const t = useT();
  const toast = useToast();
  const create = useAuthedMutation(api.customers.create);
  const update = useAuthedMutation(api.customers.update);
  const generateR2UploadUrl = useAuthedAction(api.r2.generateUploadUrl);
  const setPhotoMutation = useAuthedMutation(api.customers.setPhoto);
  const removePhotoMutation = useAuthedMutation(api.customers.removePhoto);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [extraPhones, setExtraPhones] = useState<string[]>([]);
  const [whatsapp, setWhatsapp] = useState("");
  const [facebookUrl, setFacebookUrl] = useState("");
  const [address, setAddress] = useState("");
  /* Same independent-of-the-prop state machine as ProductDialog's photo —
     see the comment there for why `customer.photoUrl` alone is not enough. */
  const [savedPhotoUrl, setSavedPhotoUrl] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const uploadStatus = useUploadProgress();
  /*
    On by default, because in this trade the phone and the WhatsApp number are
    the same one far more often than not. Ticked, the field follows the phone
    rather than holding a stale copy of it — so correcting the phone corrects
    both, which is the whole reason the tick exists.
  */
  const [sameWhatsapp, setSameWhatsapp] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(customer?.name ?? "");
    setPhone(customer?.phone ?? "");
    setExtraPhones(customer?.extraPhones ?? []);
    setWhatsapp(customer?.whatsapp ?? "");
    setFacebookUrl(customer?.facebookUrl ?? "");
    setAddress(customer?.address ?? "");
    setSavedPhotoUrl(customer?.photoUrl ?? null);
    setPhotoPreview(customer?.photoUrl ?? null);
    setPendingPhoto(null);
    /*
      Editing starts ticked only when the two numbers really are the same
      one — compared as digits, so "+8801711…" and "01711-…" count as equal.
      A customer with a separate WhatsApp number keeps it.
    */
    setSameWhatsapp(
      customer
        ? !customer.whatsapp ||
            normalisePhone(customer.whatsapp) === normalisePhone(customer.phone)
        : true,
    );
  }, [open, customer]);

  // What actually gets saved: the phone when the box is ticked, otherwise
  // whatever was typed in the WhatsApp field.
  const whatsappValue = sameWhatsapp ? phone : whatsapp;

  const valid = name.trim() !== "";

  async function pickPhoto(file: File) {
    const preview = URL.createObjectURL(file);
    setPhotoPreview(preview);

    if (!customer) {
      // No customer to attach it to yet — uploaded once Save creates one.
      setPendingPhoto(file);
      return;
    }
    setPhotoBusy(true);
    try {
      const { publicUrl } = await uploadFileToR2(generateR2UploadUrl, file, "customers");
      await setPhotoMutation({ id: customer._id, photoUrl: publicUrl });
      setSavedPhotoUrl(publicUrl);
      toast.ok(t("contacts.photoUpdated"));
    } catch (err) {
      toast.error(errorMessage(err));
      setPhotoPreview(savedPhotoUrl);
    } finally {
      setPhotoBusy(false);
    }
  }

  const { dragOver, dropProps } = useFileDrop((file) => void pickPhoto(file));

  async function clearPhoto() {
    if (!customer || !savedPhotoUrl) {
      setPhotoPreview(null);
      setPendingPhoto(null);
      return;
    }
    setPhotoBusy(true);
    try {
      await removePhotoMutation({ id: customer._id });
      setSavedPhotoUrl(null);
      setPhotoPreview(null);
      toast.ok(t("contacts.photoRemoved"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      const payload = { name, phone, extraPhones, whatsapp: whatsappValue, facebookUrl, address };
      if (customer) {
        await update({ id: customer._id, ...payload });
        toast.ok(t("customers.updated"));
      } else {
        const id = await create(payload);
        // A photo picked before the customer existed uploads now, against
        // the id Save just produced.
        if (pendingPhoto) {
          const { publicUrl } = await uploadFileToR2(generateR2UploadUrl, pendingPhoto, "customers");
          await setPhotoMutation({ id, photoUrl: publicUrl });
        }
        toast.ok(t("customers.added"));
      }
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      guardChanges
      open={open}
      onClose={onClose}
      icon={<UserRound size={19} />}
      title={customer ? t("customers.editTitle") : t("customers.addTitle")}
      subtitle={customer ? t("customers.editSubtitle") : t("customers.addSubtitle")}
    >
      <form onSubmit={submit}>
        <div className="flex flex-col gap-5 px-6 py-6">
          <div className="flex items-center gap-4">
            <div className="relative shrink-0 flex items-center justify-center">
              {photoPreview && (
                <span
                  className="pointer-events-none absolute -inset-1 rounded-full opacity-75 blur-md ac-avatar-glow"
                  style={{ background: avatarThemeFor(name || "Customer").glow }}
                  aria-hidden
                />
              )}
              <div
                {...dropProps}
                className={cx(
                  "relative z-10 flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-page transition-all",
                  dragOver ? "border-accent ring-2 ring-accent" : "border-line-strong",
                  photoPreview && "ring-2 ring-white/90 dark:ring-white/50",
                )}
                style={photoPreview ? {
                  boxShadow: `0 0 18px 2px ${avatarThemeFor(name || "Customer").glow}, 0 0 0 2px ${avatarThemeFor(name || "Customer").ring}`,
                } : undefined}
              >
                {photoPreview ? (
                  <img src={photoPreview} alt="" className="size-full object-cover rounded-full" />
                ) : (
                  <Camera size={22} className="text-ink-3" aria-hidden />
                )}
                {photoBusy && (
                  <div className="absolute inset-0 flex items-center justify-center bg-page/70 rounded-full">
                    <div className="ac-skeleton size-5 rounded-full" aria-hidden />
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void pickPhoto(file);
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={photoBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={14} />
                  {photoPreview ? t("contacts.changePhoto") : t("contacts.uploadPhoto")}
                </Button>
                {photoPreview && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={photoBusy}
                    onClick={() => void clearPhoto()}
                  >
                    <Trash2 size={14} />
                    {t("contacts.removePhoto")}
                  </Button>
                )}
              </div>
              {photoBusy && uploadStatus && (
                <div className="w-48 mt-1">
                  <div className="flex items-center justify-between text-[11px] text-ink-3 mb-1">
                    <span>{uploadStatus.stage === "compressing" ? "Compressing..." : "Uploading..."}</span>
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
            </div>
          </div>

          <Field label={t("orders.customerName")}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="মোঃ রিফাত হোসেন"
                autoComplete="off"
                required
              />
            )}
          </Field>
          <Field label={t("orders.phone")} hint={t("customers.phoneHint")}>
            {(id) => (
              <Input
                id={id}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="01712-345678"
                autoComplete="off"
                inputMode="tel"
              />
            )}
          </Field>
          <PhoneListField phones={extraPhones} onChange={setExtraPhones} />
          {/* ------------------------------------------------- WhatsApp */}
          <div className="flex flex-col gap-2.5">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line-strong bg-page px-3.5 py-3">
              <input
                type="checkbox"
                checked={sameWhatsapp}
                onChange={(e) => setSameWhatsapp(e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--accent)]"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                  <MessageCircle size={15} className="text-accent" aria-hidden />
                  {t("customers.sameWhatsapp")}
                </span>
                <span className="mt-0.5 block text-[12px] leading-4.5 text-ink-3">
                  {sameWhatsapp && phone.trim()
                    ? `${t("customers.whatsapp")}: ${phone.trim()}`
                    : t("customers.sameWhatsappHint")}
                </span>
              </span>
            </label>

            {!sameWhatsapp && (
              <Field label={t("customers.whatsapp")}>
                {(id) => (
                  <Input
                    id={id}
                    value={whatsapp}
                    onChange={(e) => setWhatsapp(e.target.value)}
                    placeholder="01812-345678"
                    autoComplete="off"
                    inputMode="tel"
                  />
                )}
              </Field>
            )}
          </div>

          <Field label={t("customers.facebook")} hint={t("customers.facebookHint")}>
            {(id) => (
              <div className="relative">
                <Globe
                  size={16}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
                  aria-hidden
                />
                <Input
                  id={id}
                  value={facebookUrl}
                  onChange={(e) => setFacebookUrl(e.target.value)}
                  placeholder="facebook.com/rahim.store"
                  autoComplete="off"
                  className="pl-10"
                  inputMode="url"
                />
              </div>
            )}
          </Field>

          <Field label={t("orders.address")}>
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="১২/ক, মিরপুর রোড, ঢাকা"
              />
            )}
          </Field>
        </div>

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid || saving}>
            {saving ? t("common.saving") : customer ? t("common.save") : t("customers.add")}
            {!saving && <ArrowRight size={16} />}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
