import { useEffect, useRef, useState } from "react";
import { KeyRound, PackageSearch } from "lucide-react";
import { Button, Field, Input, Modal, ModalFooter } from "./ui";
import { useT } from "../lib/i18n";
import { errorMessage, useToast } from "../lib/toast";

/**
 * Sets a product's stock to an exact number, instead of nudging it by one.
 *
 * Modeled on `PasscodeConfirmDialog`, but a plain confirm has nothing for the
 * admin to type — this one does, so the passcode field sits below the number
 * rather than being the whole form. The passcode is still checked server-side
 * by the mutation itself.
 */
export function SetStockDialog({
  open,
  onClose,
  productName,
  currentQuantity,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  productName: string;
  currentQuantity: number;
  /** Receives the new quantity and the typed passcode; throw to keep the dialog open. */
  onConfirm: (quantity: number, passcode: string) => Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const [quantity, setQuantity] = useState("");
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const passcodeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuantity(String(currentQuantity));
      setPasscode("");
    }
  }, [open, currentQuantity]);

  const parsed = Number(quantity);
  const validQuantity = quantity.trim() !== "" && Number.isInteger(parsed) && parsed >= 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validQuantity || !passcode || busy) return;
    setBusy(true);
    try {
      await onConfirm(parsed, passcode);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
      setPasscode("");
      passcodeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("confirm.setStock")} icon={<PackageSearch size={19} />} width="sm:max-w-md">
      <form onSubmit={submit}>
        <div className="flex flex-col gap-5 px-6 py-6">
          <p className="text-[14px] leading-6.5 whitespace-pre-line text-ink-2">
            {productName}
            {"\n"}
            {t("confirm.setStockBody")}
          </p>

          <Field label={t("confirm.setStockLabel")}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="tabular-nums"
                autoFocus
                required
              />
            )}
          </Field>

          <label className="flex flex-col gap-2">
            <span className="text-[13px] font-semibold text-ink-2">{t("confirm.passcode")}</span>
            <div className="relative">
              <KeyRound
                size={16}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
                aria-hidden
              />
              <Input
                ref={passcodeRef}
                type="password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                className="pl-10"
              />
            </div>
            <span className="text-[12px] leading-4.5 text-ink-3">{t("confirm.passcodeHintStock")}</span>
          </label>
        </div>

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!validQuantity || !passcode || busy}>
            {busy ? t("common.saving") : t("confirm.setStockConfirm")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
