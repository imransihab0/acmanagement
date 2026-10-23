import { useEffect, useRef, useState } from "react";
import { Camera, PackagePlus, Pencil, Settings2, Trash2, Upload } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { AmountInput, Button, Field, Input, Modal, ModalFooter, Select, Textarea, cx } from "./ui";
import { useT } from "../lib/i18n";
import { CURRENCY_SYMBOL } from "../lib/format";
import { errorMessage, useToast } from "../lib/toast";
import { useAuthedAction, useAuthedMutation } from "../lib/session";
import { uploadFileToR2, useFileDrop, useUploadProgress } from "../lib/upload";
import { useProductCategories } from "../lib/productCategories";
import { ProductCategoriesDialog } from "./ProductCategoriesDialog";

type ProductWithPhoto = Doc<"products"> & { photoUrl?: string | null };

/*
  Only what a product is. Its stock and prices live on its lots — a product
  is added here, then stocked with a lot via Vendors.
*/
type Draft = {
  name: string;
  categoryId: string;
  subCategoryId: string;
  costPrice: string;
  sellPrice: string;
  unit: string;
  details: string;
};

const EMPTY: Draft = {
  name: "",
  categoryId: "",
  subCategoryId: "",
  costPrice: "",
  sellPrice: "",
  unit: "",
  details: "",
};

export function ProductDialog({
  open,
  onClose,
  product,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Present when editing; absent when adding. */
  product?: ProductWithPhoto | null;
  /** Called with the new product's id. */
  onCreated?: (id: Id<"products">) => void;
}) {
  const t = useT();
  const toast = useToast();
  const create = useAuthedMutation(api.products.create);
  const update = useAuthedMutation(api.products.update);
  const generateR2UploadUrl = useAuthedAction(api.r2.generateUploadUrl);
  const setPhoto = useAuthedMutation(api.products.setPhoto);
  const removePhoto = useAuthedMutation(api.products.removePhoto);
  const { categories: productCats, allCategories, subcategoriesOf, label: catLabel, categoryOf, subCategoryOf } = useProductCategories();
  const [manageCategories, setManageCategories] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const uploadStatus = useUploadProgress();
  /*
    The photo is its own small state machine, independent of the rest of the
    form — editing a name and swapping a photo are two different actions that
    happen to live in the same dialog. `savedPhotoUrl` is what the backend
    actually has right now; `photoPreview` is what's on screen, which can
    briefly be a local blob URL while an upload is in flight. Deciding
    whether a photo exists from the `product` prop instead would be wrong —
    that prop is a snapshot from when the dialog opened, so it goes stale the
    moment a photo is uploaded earlier in this same session.
  */
  const [savedPhotoUrl, setSavedPhotoUrl] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (product) {
      const cat = categoryOf(product);
      const sub = subCategoryOf(product);
      const resolvedCategoryId = product.categoryId ?? cat?._id ?? "";
      const validSubcats = subcategoriesOf(resolvedCategoryId);
      const candidateSubId = product.subCategoryId ?? sub?._id ?? "";
      const resolvedSubCategoryId = validSubcats.some((sc) => sc._id === candidateSubId)
        ? candidateSubId
        : "";

      setDraft({
        name: product.name,
        categoryId: resolvedCategoryId,
        subCategoryId: resolvedSubCategoryId,
        costPrice: product.costPrice !== undefined ? String(product.costPrice) : "",
        sellPrice: product.sellPrice !== undefined ? String(product.sellPrice) : "",
        unit: product.unit ?? "",
        details: product.details,
      });
    } else {
      setDraft(EMPTY);
    }
    setSavedPhotoUrl(product?.photoUrl ?? null);
    setPhotoPreview(product?.photoUrl ?? null);
    setPendingPhoto(null);
  }, [open, product, allCategories]);

  // Ensure sub-category always belongs to currently selected category
  useEffect(() => {
    if (!draft.subCategoryId) return;
    const validSubcats = subcategoriesOf(draft.categoryId);
    if (!validSubcats.some((sc) => sc._id === draft.subCategoryId)) {
      setDraft((d) => ({ ...d, subCategoryId: "" }));
    }
  }, [draft.categoryId, draft.subCategoryId, allCategories]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function pickPhoto(file: File) {
    const preview = URL.createObjectURL(file);
    setPhotoPreview(preview);

    if (!product) {
      // No product to attach it to yet — uploaded once Save creates one.
      setPendingPhoto(file);
      return;
    }
    setPhotoBusy(true);
    try {
      const { publicUrl } = await uploadFileToR2(generateR2UploadUrl, file, "products");
      await setPhoto({ id: product._id, photoUrl: publicUrl });
      setSavedPhotoUrl(publicUrl);
      toast.ok(t("products.photoUpdated"));
    } catch (err) {
      toast.error(errorMessage(err));
      setPhotoPreview(savedPhotoUrl);
    } finally {
      setPhotoBusy(false);
    }
  }

  const { dragOver, dropProps } = useFileDrop((file) => void pickPhoto(file));

  async function clearPhoto() {
    if (!product || !savedPhotoUrl) {
      setPhotoPreview(null);
      setPendingPhoto(null);
      return;
    }
    setPhotoBusy(true);
    try {
      await removePhoto({ id: product._id });
      setSavedPhotoUrl(null);
      setPhotoPreview(null);
      toast.ok(t("products.photoRemoved"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPhotoBusy(false);
    }
  }

  const valid = draft.name.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      const selectedCat = allCategories.find((c) => c._id === draft.categoryId && !c.parentId);
      const validSubcats = selectedCat ? subcategoriesOf(selectedCat._id) : [];
      const selectedSubCat = validSubcats.find((c) => c._id === draft.subCategoryId);
      const costPrice = draft.costPrice.trim() !== "" ? Number(draft.costPrice) : undefined;
      const sellPrice = draft.sellPrice.trim() !== "" ? Number(draft.sellPrice) : undefined;
      const payload = {
        name: draft.name,
        details: draft.details,
        costPrice,
        sellPrice,
        category: selectedCat ? selectedCat.name : undefined,
        subCategory: selectedSubCat ? selectedSubCat.name : undefined,
        categoryId: selectedCat ? (selectedCat._id as Id<"productCategories">) : undefined,
        subCategoryId: selectedSubCat ? (selectedSubCat._id as Id<"productCategories">) : undefined,
        unit: draft.unit,
      };
      if (product) {
        await update({ id: product._id, ...payload });
        toast.ok(`Updated ${payload.name.trim()}.`);
      } else {
        const id = await create(payload);
        // A photo picked before the product existed uploads now, against
        // the id Save just produced.
        if (pendingPhoto) {
          const { publicUrl } = await uploadFileToR2(generateR2UploadUrl, pendingPhoto, "products");
          await setPhoto({ id, photoUrl: publicUrl });
        }
        toast.ok(`Added ${payload.name.trim()}.`);
        onClose();
        onCreated?.(id);
        return;
      }
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const subcats = subcategoriesOf(draft.categoryId);

  return (
    <>
      <Modal
        guardChanges
        open={open}
        onClose={onClose}
        icon={product ? <Pencil size={18} /> : <PackagePlus size={19} />}
        title={product ? "Edit product" : "Add product"}
        subtitle={
          product
            ? "Past sales keep the cost they were recorded with."
            : "Add product to catalog. Stock and lots are purchased via Vendors."
        }
      >
        <form onSubmit={submit}>
          <div className="flex flex-col gap-6 px-6 py-6">
            <div className="flex items-center gap-4">
              <div
                {...dropProps}
                className={cx(
                  "relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-page transition-colors",
                  dragOver ? "border-accent ring-2 ring-accent" : "border-line-strong",
                )}
              >
                {photoPreview ? (
                  <img src={photoPreview} alt="" className="size-full object-cover" />
                ) : (
                  <Camera size={22} className="text-ink-3" aria-hidden />
                )}
                {photoBusy && (
                  <div className="absolute inset-0 flex items-center justify-center bg-page/70">
                    <div className="ac-skeleton size-5 rounded-full" aria-hidden />
                  </div>
                )}
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
                    {photoPreview ? t("products.changePhoto") : t("products.uploadPhoto")}
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
                      {t("products.removePhoto")}
                    </Button>
                  )}
                </div>
                {photoBusy && uploadStatus ? (
                  <div className="w-48 mt-0.5">
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
                ) : (
                  <p className="text-[11.5px] text-ink-3">
                    {photoBusy ? t("products.uploading") : t("products.photo")}
                  </p>
                )}
              </div>
            </div>

            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Fresh Oyster Mushroom"
                  autoComplete="off"
                  required
                />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-[13px] font-semibold text-ink-2">
                    {t("products.category")}
                  </label>
                  <button
                    type="button"
                    onClick={() => setManageCategories(true)}
                    className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-ink-3 transition-colors hover:text-accent"
                  >
                    <Settings2 size={13} />
                    {t("products.manageCategories")}
                  </button>
                </div>
                <Select
                  value={draft.categoryId}
                  onChange={(e) => {
                    const nextCatId = e.target.value;
                    const validSubcats = subcategoriesOf(nextCatId);
                    setDraft((d) => ({
                      ...d,
                      categoryId: nextCatId,
                      subCategoryId: validSubcats.some((sc) => sc._id === d.subCategoryId)
                        ? d.subCategoryId
                        : "",
                    }));
                  }}
                >
                  <option value="">{t("products.noCategory")}</option>
                  {productCats.map((c) => (
                    <option key={c._id} value={c._id}>
                      {catLabel(c)}
                    </option>
                  ))}
                </Select>
              </div>

              {subcats.length > 0 && (
                <Field label={t("products.subCategory")} hint={t("common.optional")}>
                  {(id) => (
                    <Select
                      id={id}
                      value={draft.subCategoryId}
                      onChange={(e) => setDraft((d) => ({ ...d, subCategoryId: e.target.value }))}
                    >
                      <option value="">{t("products.noSubCategory")}</option>
                      {subcats.map((sc) => (
                        <option key={sc._id} value={sc._id}>
                          {catLabel(sc)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}

              <Field label={t("products.unit")} hint={t("products.unitHint")}>
                {(id) => (
                  <Input
                    id={id}
                    list="product-unit-suggestions"
                    value={draft.unit}
                    onChange={(e) => set("unit", e.target.value)}
                    placeholder="পিস"
                  />
                )}
              </Field>
            </div>
            <datalist id="product-unit-suggestions">
              <option value="পিস" />
              <option value="কেজি" />
              <option value="গ্রাম" />
              <option value="লিটার" />
              <option value="বক্স" />
              <option value="প্যাকেট" />
            </datalist>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cost price (Buy)" hint="What one unit costs you">
                {(id) => (
                  <AmountInput
                    id={id}
                    symbol={CURRENCY_SYMBOL}
                    value={draft.costPrice}
                    onChange={(e) => set("costPrice", e.target.value)}
                    placeholder="0"
                  />
                )}
              </Field>

              <Field label={t("products.sellPrice")} hint="Asking price">
                {(id) => (
                  <AmountInput
                    id={id}
                    symbol={CURRENCY_SYMBOL}
                    value={draft.sellPrice}
                    onChange={(e) => set("sellPrice", e.target.value)}
                    placeholder="Optional"
                  />
                )}
              </Field>
            </div>

            <Field label="Details" hint="Grade, origin, harvest notes, packaging — anything you want to remember.">
              {(id) => (
                <Textarea
                  id={id}
                  rows={4}
                  value={draft.details}
                  onChange={(e) => set("details", e.target.value)}
                  placeholder="Plain text. Shown on the product card."
                />
              )}
            </Field>
          </div>

          <ModalFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!valid || saving}>
              {saving ? "Saving…" : product ? "Save changes" : "Add product"}
            </Button>
          </ModalFooter>
        </form>
      </Modal>

      <ProductCategoriesDialog
        open={manageCategories}
        onClose={() => setManageCategories(false)}
        onDeleted={(id) => {
          if (draft.categoryId === id) {
            setDraft((d) => ({ ...d, categoryId: "", subCategoryId: "" }));
          } else if (draft.subCategoryId === id) {
            setDraft((d) => ({ ...d, subCategoryId: "" }));
          }
        }}
      />
    </>
  );
}
