import { useEffect, useState } from "react";
import { GraduationCap } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button, Field, Input, Modal, ModalFooter, Select, SectionLabel, Textarea } from "./ui";
import { useT } from "../lib/i18n";
import { errorMessage, useToast } from "../lib/toast";
import { useAuthedMutation } from "../lib/session";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

function toDateInput(ts?: number) {
  return ts ? new Date(ts).toISOString().slice(0, 10) : "";
}

export function TraineeDialog({
  open,
  onClose,
  trainee,
}: {
  open: boolean;
  onClose: () => void;
  /** Present when editing an existing trainee. */
  trainee?: Doc<"trainees"> | null;
}) {
  const t = useT();
  const toast = useToast();
  const create = useAuthedMutation(api.trainees.create);
  const update = useAuthedMutation(api.trainees.update);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [fatherName, setFatherName] = useState("");
  const [fatherPhone, setFatherPhone] = useState("");
  const [motherName, setMotherName] = useState("");
  const [motherPhone, setMotherPhone] = useState("");
  const [bloodGroup, setBloodGroup] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [nationality, setNationality] = useState("");
  const [nidNumber, setNidNumber] = useState("");
  const [hometown, setHometown] = useState("");
  const [currentAddress, setCurrentAddress] = useState("");
  const [religion, setReligion] = useState("");
  const [facebookUrl, setFacebookUrl] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [twitterUrl, setTwitterUrl] = useState("");
  const [tiktokUrl, setTiktokUrl] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(trainee?.name ?? "");
    setPhone(trainee?.phone ?? "");
    setFatherName(trainee?.fatherName ?? "");
    setFatherPhone(trainee?.fatherPhone ?? "");
    setMotherName(trainee?.motherName ?? "");
    setMotherPhone(trainee?.motherPhone ?? "");
    setBloodGroup(trainee?.bloodGroup ?? "");
    setDateOfBirth(toDateInput(trainee?.dateOfBirth));
    setNationality(trainee?.nationality ?? "");
    setNidNumber(trainee?.nidNumber ?? "");
    setHometown(trainee?.hometown ?? "");
    setCurrentAddress(trainee?.currentAddress ?? "");
    setReligion(trainee?.religion ?? "");
    setFacebookUrl(trainee?.facebookUrl ?? "");
    setWhatsapp(trainee?.whatsapp ?? "");
    setYoutubeUrl(trainee?.youtubeUrl ?? "");
    setTwitterUrl(trainee?.twitterUrl ?? "");
    setTiktokUrl(trainee?.tiktokUrl ?? "");
    setLinkedinUrl(trainee?.linkedinUrl ?? "");
    setNote(trainee?.note ?? "");
  }, [open, trainee]);

  const valid = name.trim() !== "" && !saving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      const payload = {
        name,
        phone,
        fatherName,
        fatherPhone,
        motherName,
        motherPhone,
        bloodGroup,
        dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00`).getTime() : undefined,
        nationality,
        nidNumber,
        hometown,
        currentAddress,
        religion,
        facebookUrl,
        whatsapp,
        youtubeUrl,
        twitterUrl,
        tiktokUrl,
        linkedinUrl,
        note,
      };
      if (trainee) {
        await update({ id: trainee._id, ...payload });
        toast.ok(t("trainees.updated"));
      } else {
        await create(payload);
        toast.ok(t("trainees.added"));
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
      open={open}
      onClose={onClose}
      icon={<GraduationCap size={19} />}
      title={trainee ? t("trainees.edit") : t("trainees.add")}
      width="sm:max-w-2xl"
    >
      <form onSubmit={submit}>
        <div className="flex max-h-[70vh] flex-col gap-6 overflow-y-auto px-6 py-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t("trainees.name")}>
              {(id) => (
                <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              )}
            </Field>
            <Field label={t("trainees.phone")}>
              {(id) => (
                <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01XXX-XXXXXX" />
              )}
            </Field>
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel>{t("trainees.family")}</SectionLabel>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={t("trainees.fatherName")}>
                {(id) => <Input id={id} value={fatherName} onChange={(e) => setFatherName(e.target.value)} />}
              </Field>
              <Field label={t("trainees.fatherPhone")}>
                {(id) => <Input id={id} value={fatherPhone} onChange={(e) => setFatherPhone(e.target.value)} />}
              </Field>
              <Field label={t("trainees.motherName")}>
                {(id) => <Input id={id} value={motherName} onChange={(e) => setMotherName(e.target.value)} />}
              </Field>
              <Field label={t("trainees.motherPhone")}>
                {(id) => <Input id={id} value={motherPhone} onChange={(e) => setMotherPhone(e.target.value)} />}
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel>{t("trainees.identity")}</SectionLabel>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={t("trainees.dob")}>
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={dateOfBirth}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                  />
                )}
              </Field>
              <div className="flex flex-col gap-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <label className="text-[13px] font-semibold text-ink-2">{t("trainees.bloodGroup")}</label>
                  <span className="text-[11.5px] text-ink-3">{t("common.optional")}</span>
                </div>
                <Select value={bloodGroup} onChange={(e) => setBloodGroup(e.target.value)} aria-label={t("trainees.bloodGroup")}>
                  <option value="">—</option>
                  {BLOOD_GROUPS.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </Select>
              </div>
              <Field label={t("trainees.nationality")}>
                {(id) => <Input id={id} value={nationality} onChange={(e) => setNationality(e.target.value)} />}
              </Field>
              <Field label={t("trainees.nid")}>
                {(id) => <Input id={id} value={nidNumber} onChange={(e) => setNidNumber(e.target.value)} />}
              </Field>
              <Field label={t("trainees.religion")}>
                {(id) => <Input id={id} value={religion} onChange={(e) => setReligion(e.target.value)} />}
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel>{t("trainees.addresses")}</SectionLabel>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={t("trainees.hometown")}>
                {(id) => <Input id={id} value={hometown} onChange={(e) => setHometown(e.target.value)} />}
              </Field>
              <Field label={t("trainees.currentAddress")}>
                {(id) => (
                  <Input id={id} value={currentAddress} onChange={(e) => setCurrentAddress(e.target.value)} />
                )}
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel>{t("trainees.socialLinks")}</SectionLabel>
              <span className="text-[11.5px] text-ink-3">{t("common.optional")}</span>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={t("trainees.facebook")}>
                {(id) => <Input id={id} value={facebookUrl} onChange={(e) => setFacebookUrl(e.target.value)} placeholder="facebook.com/…" />}
              </Field>
              <Field label={t("trainees.whatsapp")}>
                {(id) => <Input id={id} value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="01XXX-XXXXXX" />}
              </Field>
              <Field label={t("trainees.youtube")}>
                {(id) => <Input id={id} value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} placeholder="youtube.com/…" />}
              </Field>
              <Field label={t("trainees.twitter")}>
                {(id) => <Input id={id} value={twitterUrl} onChange={(e) => setTwitterUrl(e.target.value)} placeholder="x.com/…" />}
              </Field>
              <Field label={t("trainees.tiktok")}>
                {(id) => <Input id={id} value={tiktokUrl} onChange={(e) => setTiktokUrl(e.target.value)} placeholder="tiktok.com/@…" />}
              </Field>
              <Field label={t("trainees.linkedin")}>
                {(id) => <Input id={id} value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} placeholder="linkedin.com/in/…" />}
              </Field>
            </div>
          </div>

          <Field label={t("common.note")} hint={t("common.optional")}>
            {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            {saving ? t("common.saving") : trainee ? t("common.save") : t("trainees.add")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
