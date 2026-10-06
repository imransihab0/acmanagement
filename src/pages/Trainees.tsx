import { useMemo, useState } from "react";
import { Award, GraduationCap, Pencil, Phone, Plus, Search, Trash2 } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge, Button, Card, EmptyState, Input } from "../components/ui";
import { Pagination, usePagination } from "../components/Pagination";
import { TraineeDialog } from "../components/TraineeDialog";
import { TraineeDetailDialog } from "../components/TraineeDetailDialog";
import { PasscodeConfirmDialog } from "../components/PasscodeConfirmDialog";
import { useT } from "../lib/i18n";
import { gradientFor, initialOf } from "../lib/avatar";
import { normalisePhone } from "../../convex/shared";
import { useToast } from "../lib/toast";
import { useAuthedMutation, useAuthedQuery } from "../lib/session";

export function TraineesPage() {
  const t = useT();
  const toast = useToast();
  const trainees = useAuthedQuery(api.trainees.list, {});
  const removeTrainee = useAuthedMutation(api.trainees.remove);

  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Doc<"trainees"> | null>(null);
  const [deleting, setDeleting] = useState<{ id: Id<"trainees">; name: string } | null>(null);
  const [viewing, setViewing] = useState<Id<"trainees"> | null>(null);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return trainees ?? [];
    const digits = normalisePhone(term);
    return (trainees ?? []).filter(
      (tr) =>
        tr.name.toLowerCase().includes(term) ||
        (digits.length > 2 && normalisePhone(tr.phone).includes(digits)),
    );
  }, [trainees, search]);

  const pager = usePagination(rows, search, 25);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] leading-8 font-bold tracking-tight text-ink sm:text-[28px] sm:leading-9">
            {t("trainees.title")}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3 sm:text-[14px]">{t("trainees.subtitle")}</p>
        </div>
        <Button variant="primary" onClick={() => setAddOpen(true)} className="w-full sm:w-auto">
          <Plus size={17} />
          {t("trainees.add")}
        </Button>
      </div>

      <div className="relative w-full min-w-0 sm:max-w-md">
        <Search
          size={17}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("trainees.searchPlaceholder")}
          className="pl-10.5"
          aria-label={t("common.search")}
        />
      </div>

      <Card>
        {trainees === undefined ? (
          <div className="ac-skeleton h-72 rounded-card bg-surface" aria-hidden />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<GraduationCap size={24} />}
            title={search ? t("trainees.noMatches") : t("trainees.none")}
            body={search ? t("trainees.noMatchesBody") : t("trainees.noneBody")}
            action={
              !search ? (
                <Button variant="primary" onClick={() => setAddOpen(true)}>
                  <Plus size={17} />
                  {t("trainees.add")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-line">
              {pager.pageRows.map((tr) => (
                <li key={tr._id} className="flex items-start gap-3 px-4 py-4 sm:px-5">
                  <button
                    type="button"
                    onClick={() => setViewing(tr._id)}
                    className="flex min-w-0 flex-1 items-start gap-3 text-left"
                    aria-label={`${t("trainees.view")} — ${tr.name}`}
                  >
                    {tr.photoUrl ? (
                      <img
                        src={tr.photoUrl}
                        alt=""
                        className="size-10 shrink-0 rounded-2xl object-cover"
                      />
                    ) : (
                      <span
                        className="flex size-10 shrink-0 items-center justify-center rounded-2xl text-[14px] font-bold text-white"
                        style={{ background: gradientFor(tr.name) }}
                        aria-hidden
                      >
                        {initialOf(tr.name)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14.5px] font-semibold text-ink">{tr.name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
                        {tr.phone && (
                          <span className="inline-flex items-center gap-1">
                            <Phone size={12} aria-hidden />
                            {tr.phone}
                          </span>
                        )}
                        {tr.certificateIssuedAt && (
                          <Badge tone="good">
                            <Award size={11} />
                            {t("trainees.certified")}
                          </Badge>
                        )}
                      </p>
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      onClick={() => setEditing(tr)}
                      aria-label={`${t("common.edit")} ${tr.name}`}
                      className="rounded-lg p-2 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => setDeleting({ id: tr._id, name: tr.name })}
                      aria-label={`${t("common.delete")} ${tr.name}`}
                      className="rounded-lg p-2 text-ink-3 transition-colors hover:bg-surface-2 hover:text-critical"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <Pagination
              page={pager.page}
              pageCount={pager.pageCount}
              pageSize={pager.pageSize}
              total={pager.total}
              onPage={pager.setPage}
              onPageSize={pager.setPageSize}
              itemLabel="trainees"
            />
          </>
        )}
      </Card>

      <TraineeDetailDialog open={viewing !== null} onClose={() => setViewing(null)} traineeId={viewing} />
      <TraineeDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <TraineeDialog open={editing !== null} onClose={() => setEditing(null)} trainee={editing} />
      <PasscodeConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t("trainees.remove")}
        confirmLabel={t("trainees.remove")}
        body={deleting ? `${deleting.name}\n${t("trainees.removeBody")}` : ""}
        onConfirm={async (passcode) => {
          if (!deleting) return;
          await removeTrainee({ id: deleting.id, passcode });
          toast.ok(t("trainees.removed"));
        }}
      />
    </div>
  );
}
