import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cx } from "./ui";

export type Delta = {
  /** Change as a fraction, e.g. 0.124 for +12.4%. Null when there is no baseline. */
  fraction: number | null;
  label: string;
};

export type TileAccent = "violet" | "emerald" | "amber" | "sky";

/*
  "violet" renders as bdmushroom's crimson, not the brand gradient
  (--grad-violet) — that gradient is green now, the same as "emerald", and
  a page that uses both categories on one grid needs them to stay two
  different colours.
*/
const GRADIENTS: Record<TileAccent, string> = {
  violet: "var(--grad-crimson)",
  emerald: "var(--grad-emerald)",
  amber: "var(--grad-amber)",
  sky: "var(--grad-sky)",
};

/**
 * A stat tile is a chart form in its own right — when the story is one number,
 * this is the answer, not a one-bar bar chart.
 *
 * `hero` paints the whole tile with a brand gradient and puts white on it;
 * every gradient here clears 4.5:1 against white at both ends. The other tiles
 * stay on the surface with a soft tint so four saturated blocks never compete.
 * Hero values use proportional figures — tabular-nums is for aligned columns.
 */
export function StatTile({
  label,
  value,
  sub,
  icon,
  accent,
  hero = false,
  delta,
}: {
  label: string;
  /** A node, so callers can pass an <AnimatedNumber> instead of a string. */
  value: ReactNode;
  sub?: ReactNode;
  icon: ReactNode;
  accent: TileAccent;
  hero?: boolean;
  delta?: Delta;
}) {
  if (hero) {
    return (
      <div
        className="relative overflow-hidden rounded-card p-5 text-white shadow-[var(--shadow-hero)] transition-transform duration-300 ease-[var(--ease-out)] hover:-translate-y-1"
        style={{ background: GRADIENTS[accent] }}
      >
        {/* Soft highlight so the fill reads as a surface, not a flat swatch. */}
        <div
          className="pointer-events-none absolute -top-16 -right-10 size-44 rounded-full opacity-25 blur-2xl"
          style={{ background: "rgba(255,255,255,0.9)" }}
          aria-hidden
        />
        <div className="relative flex items-start justify-between gap-3">
          <p className="text-[13px] font-semibold text-white/80">{label}</p>
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-white/20"
            aria-hidden
          >
            {icon}
          </span>
        </div>
        <p className="relative mt-3 truncate text-[34px] leading-11 font-bold tracking-tight xl:text-[38px]">
          {value}
        </p>
        <div className="relative mt-2 flex flex-wrap items-center gap-2">
          {delta && <DeltaChip delta={delta} onGradient />}
          {sub && <span className="text-[12.5px] text-white/75">{sub}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface p-5 shadow-[var(--shadow-card)] transition-all duration-300 ease-[var(--ease-out)] hover:-translate-y-1 hover:shadow-[var(--shadow-pop)]">
      <div
        className="pointer-events-none absolute -top-20 -right-12 size-40 rounded-full opacity-[0.14] blur-2xl"
        style={{ background: GRADIENTS[accent] }}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-3">
        <p className="text-[13px] font-semibold text-ink-2">{label}</p>
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-xl text-white"
          style={{ background: GRADIENTS[accent] }}
          aria-hidden
        >
          {icon}
        </span>
      </div>
      <p className="relative mt-3 truncate text-[28px] leading-9 font-bold tracking-tight text-ink xl:text-[32px]">
        {value}
      </p>
      <div className="relative mt-2 flex flex-wrap items-center gap-2">
        {delta && <DeltaChip delta={delta} />}
        {sub && <span className="text-[12.5px] text-ink-3">{sub}</span>}
      </div>
    </div>
  );
}

/**
 * Direction is carried by an arrow and a signed number, never by color alone —
 * the tint is reinforcement.
 */
function DeltaChip({ delta, onGradient = false }: { delta: Delta; onGradient?: boolean }) {
  if (delta.fraction === null) {
    return (
      <span
        className={cx(
          "inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11.5px] font-semibold",
          onGradient ? "bg-white/20 text-white" : "bg-surface-2 text-ink-3",
        )}
      >
        <Minus size={11} aria-hidden />
        {delta.label}
      </span>
    );
  }

  const up = delta.fraction >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const pct = `${up ? "+" : "−"}${(Math.abs(delta.fraction) * 100).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}%`;

  return (
    <span
      className={cx(
        "inline-flex items-center gap-0.5 rounded-lg px-1.5 py-0.5 text-[11.5px] font-semibold",
        onGradient
          ? "bg-white/20 text-white"
          : up
            ? "bg-good-soft text-good-ink"
            : "bg-critical-soft text-critical-ink",
      )}
      title={`${pct} ${delta.label}`}
    >
      <Icon size={12} aria-hidden />
      {pct}
    </span>
  );
}
