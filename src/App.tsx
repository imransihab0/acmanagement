import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  PieChart,
  Coins,
  Users,
  Truck,
  GraduationCap,
  Menu,
  X,
  Monitor,
  Sun,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
} from "lucide-react";
import { useSettings, type ThemeChoice } from "./lib/settings";
import { useSession } from "./lib/session";
import { prefetchReceiptAssets } from "./lib/pdf";
import { ConnectionBanner, SessionWarning, useIsOffline } from "./components/StatusBar";
import { useT, type MessageKey } from "./lib/i18n";
import { cx } from "./components/ui";
import { DashboardPage } from "./pages/Dashboard";
import { ProductsPage } from "./pages/Products";
import { SalesPage } from "./pages/Sales";
import { ProfitPage } from "./pages/Profit";
import { CostsPage } from "./pages/Costs";
import { CustomersPage } from "./pages/Customers";
import { VendorsPage } from "./pages/Vendors";
import { TraineesPage } from "./pages/Trainees";

type Route =
  | "dashboard"
  | "products"
  | "sales"
  | "customers"
  | "vendors"
  | "trainees"
  | "costs"
  | "profit";

const NAV: { route: Route; key: MessageKey; icon: typeof LayoutDashboard }[] = [
  { route: "dashboard", key: "nav.dashboard", icon: LayoutDashboard },
  { route: "products", key: "nav.products", icon: Package },
  { route: "sales", key: "nav.sales", icon: ShoppingCart },
  { route: "customers", key: "nav.customers", icon: Users },
  { route: "vendors", key: "nav.vendors", icon: Truck },
  { route: "trainees", key: "nav.trainees", icon: GraduationCap },
  { route: "costs", key: "nav.costs", icon: Coins },
  { route: "profit", key: "nav.profit", icon: PieChart },
];

const THEMES: { value: ThemeChoice; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
  { value: "brand", icon: Palette, label: "Brand" },
];

function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  // Orders and sales are one section now; links and bookmarks to the old
  // route still land somewhere sensible rather than on the dashboard.
  if (raw === "orders") return "sales";
  return NAV.some((n) => n.route === raw) ? (raw as Route) : "dashboard";
}

export default function App() {
  const t = useT();
  // The banner is fixed, so everything anchored to the top of the viewport
  // has to shift down by its height while it is showing.
  const offline = useIsOffline();
  const [route, setRoute] = useState<Route>(routeFromHash);
  // Separate from the sidebar's collapsed state: this is the mobile drawer,
  // which is always full width and never a rail.
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const sync = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // So the first "Receipt PDF" tap of the day doesn't race a fresh fetch
  // against a slow connection — see the comment in lib/pdf.ts.
  useEffect(() => {
    prefetchReceiptAssets();
  }, []);

  const go = (next: Route) => {
    window.location.hash = `/${next}`;
    setRoute(next);
    setDrawerOpen(false);
  };

  return (
    <div className={cx("flex min-h-full bg-page", offline && "pt-9")}>
      <ConnectionBanner />
      <SessionWarning />
      {drawerOpen && (
        <div
          className="ac-fade-in fixed inset-0 z-30 bg-scrim backdrop-blur-sm lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <Sidebar
        route={route}
        go={go}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
        offline={offline}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cx(
            "sticky z-20 flex h-16 items-center gap-3 border-b border-line bg-page/80 px-4",
            "backdrop-blur-xl sm:px-6 lg:hidden",
            offline ? "top-9" : "top-0",
          )}
        >
          <button
            onClick={() => setDrawerOpen(true)}
            className="rounded-xl p-2 text-ink-2 transition-colors hover:bg-surface-2"
            aria-label="Open navigation"
          >
            <Menu size={20} />
          </button>
          <span className="text-[15px] font-bold tracking-tight">
            {(() => {
              const item = NAV.find((n) => n.route === route);
              return item ? t(item.key) : "";
            })()}
          </span>
        </header>

        {/* Constant padding — changing it with the rail causes a second jump. */}
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
          {/* Keyed on the route so switching pages replays the entrance. */}
          <div key={route} className="ac-rise mx-auto w-full max-w-[76rem]">
            {route === "dashboard" && <DashboardPage onNavigate={go} />}
            {route === "products" && <ProductsPage />}
            {route === "sales" && <SalesPage />}
            {route === "customers" && <CustomersPage />}
            {route === "vendors" && <VendorsPage />}
            {route === "trainees" && <TraineesPage />}
            {route === "costs" && <CostsPage />}
            {route === "profit" && <ProfitPage />}
          </div>
        </main>
      </div>
    </div>
  );
}

function Sidebar({
  route,
  go,
  drawerOpen,
  onCloseDrawer,
  offline,
}: {
  route: Route;
  go: (r: Route) => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  offline: boolean;
}) {
  const { navCollapsed, toggleNav } = useSettings();
  const t = useT();
  // The rail only applies from `lg` up — below that the sidebar is a drawer
  // and always shows its full width.
  const rail = navCollapsed;

  /*
    Collapsing to the rail animates one property: the aside's width. Nothing
    inside is ever `display: none`, because display cannot be transitioned —
    it snaps, and the label vanishing a frame into a 300ms width animation is
    what reads as broken. Labels instead collapse their own max-width and fade,
    on the same curve and duration as the container.

    Horizontal padding is identical in both states, so the icon column never
    moves: nav px-3 + button px-3 puts every icon's centre at 33px, which is
    the middle of the 68px rail.
  */
  const labelMotion = "overflow-hidden whitespace-nowrap transition-all duration-300 ease-[var(--ease-out)]";

  return (
    <aside
      className={cx(
        "fixed inset-y-0 left-0 z-40 flex w-68 shrink-0 flex-col overflow-hidden border-r border-line bg-surface",
        "transition-[width,transform] duration-300 ease-[var(--ease-out)]",
        "lg:sticky lg:h-screen lg:translate-x-0",
        offline ? "lg:top-9" : "lg:top-0",
        drawerOpen ? "translate-x-0" : "-translate-x-full",
        rail && "lg:w-17",
      )}
    >
      <div className="flex h-20 shrink-0 items-center px-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white p-1 shadow-[var(--shadow-hero)]">
          <img src="/brand/bdmushroom-seal.png" alt="" className="size-full object-contain" />
        </span>
        <div
          className={cx(
            "leading-tight",
            labelMotion,
            rail ? "lg:ml-0 lg:max-w-0 lg:opacity-0" : "ml-3 max-w-40 opacity-100",
          )}
        >
          <p className="text-[16px] font-bold tracking-tight text-ink">Ledger</p>
          <p className="text-[11.5px] text-ink-3">{t("nav.tagline")}</p>
        </div>
        <button
          onClick={onCloseDrawer}
          className="ml-auto rounded-xl p-2 text-ink-3 transition-colors hover:bg-surface-2 lg:hidden"
          aria-label="Close navigation"
        >
          <X size={18} />
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pt-2">
        <p
          className={cx(
            "shrink-0 px-3 text-[10.5px] font-bold tracking-[0.08em] text-ink-3 uppercase",
            labelMotion,
            rail ? "lg:max-h-0 lg:pb-0 lg:opacity-0" : "max-h-5 pb-2 opacity-100",
          )}
        >
          {t("nav.menu")}
        </p>
        {NAV.map(({ route: r, key, icon: Icon }) => {
          const active = route === r;
          const label = t(key);
          return (
            <button
              key={r}
              onClick={() => go(r)}
              aria-current={active ? "page" : undefined}
              title={rail ? label : undefined}
              style={active ? { background: "var(--grad-violet)" } : undefined}
              className={cx(
                "ac-press flex h-11 shrink-0 items-center overflow-hidden rounded-xl px-3 text-[14px] font-semibold",
                active
                  ? "text-white shadow-[var(--shadow-hero)]"
                  : "text-ink-2 hover:bg-surface-2 hover:text-ink",
              )}
            >
              <Icon size={18} className="shrink-0" />
              <span
                className={cx(
                  labelMotion,
                  rail ? "lg:ml-0 lg:max-w-0 lg:opacity-0" : "ml-3 max-w-40 opacity-100",
                )}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3 py-4">
        <LanguageToggle rail={rail} />
        <ThemeToggle rail={rail} />
        <SignOutButton collapsed={rail} />
        <CollapseButton collapsed={rail} onToggle={toggleNav} />
      </div>
    </aside>
  );
}

/**
 * Two controls occupying the same slot: a three-up picker when there is room,
 * a single cycling button on the rail. They cross-fade in a fixed-height box
 * rather than swapping with `hidden`, so the footer never jumps.
 */
function ThemeToggle({ rail }: { rail: boolean }) {
  const { theme, setTheme } = useSettings();

  const cycle = () => {
    const index = THEMES.findIndex((t) => t.value === theme);
    setTheme(THEMES[(index + 1) % THEMES.length].value);
  };
  const current = THEMES.find((t) => t.value === theme) ?? THEMES[2];
  const CurrentIcon = current.icon;

  const fade = "absolute inset-0 transition-opacity duration-200 ease-[var(--ease-out)]";

  return (
    <div className="relative h-11">
      <div
        className={cx(
          fade,
          "grid grid-cols-4 gap-1 rounded-xl border border-line bg-page p-1",
          rail ? "lg:pointer-events-none lg:opacity-0" : "opacity-100",
        )}
      >
        {THEMES.map(({ value, icon: Icon, label }) => (
          <button
            key={value}
            onClick={() => setTheme(value)}
            aria-pressed={theme === value}
            aria-hidden={rail}
            tabIndex={rail ? -1 : 0}
            title={label}
            className={cx(
              "flex items-center justify-center rounded-lg transition-all",
              theme === value
                ? "bg-surface text-accent shadow-[var(--shadow-sm)]"
                : "text-ink-3 hover:text-ink",
            )}
          >
            <Icon size={15} />
            <span className="sr-only">{label}</span>
          </button>
        ))}
      </div>

      <button
        onClick={cycle}
        title={`Theme: ${current.label}`}
        aria-label={`Theme: ${current.label}. Click to change.`}
        aria-hidden={!rail}
        tabIndex={rail ? 0 : -1}
        className={cx(
          fade,
          "flex items-center justify-center rounded-xl border border-line bg-page text-accent hover:bg-surface-2",
          rail ? "lg:opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <CurrentIcon size={17} />
      </button>
    </div>
  );
}

/**
 * Switching language also switches numerals and date formats, so the whole
 * screen changes script — not just the labels around Bengali product names.
 */
function LanguageToggle({ rail }: { rail: boolean }) {
  const { lang, setLang } = useSettings();
  const options: { value: "en" | "bn"; short: string; label: string }[] = [
    { value: "en", short: "EN", label: "English" },
    { value: "bn", short: "বাং", label: "বাংলা" },
  ];
  const other = options.find((o) => o.value !== lang)!;

  return (
    <div className="relative h-11">
      <div
        className={cx(
          "absolute inset-0 grid grid-cols-2 gap-1 rounded-xl border border-line bg-page p-1",
          "transition-opacity duration-200 ease-[var(--ease-out)]",
          rail ? "lg:pointer-events-none lg:opacity-0" : "opacity-100",
        )}
      >
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => setLang(o.value)}
            aria-pressed={lang === o.value}
            aria-hidden={rail}
            tabIndex={rail ? -1 : 0}
            className={cx(
              "flex items-center justify-center rounded-lg text-[12.5px] font-bold transition-all",
              lang === o.value
                ? "bg-surface text-accent shadow-[var(--shadow-sm)]"
                : "text-ink-3 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      <button
        onClick={() => setLang(other.value)}
        aria-label={`Switch to ${other.label}`}
        title={other.label}
        aria-hidden={!rail}
        tabIndex={rail ? 0 : -1}
        className={cx(
          "absolute inset-0 flex items-center justify-center rounded-xl border border-line bg-page",
          "text-[12px] font-bold text-accent transition-opacity duration-200 hover:bg-surface-2",
          rail ? "lg:opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {options.find((o) => o.value === lang)!.short}
      </button>
    </div>
  );
}

function SignOutButton({ collapsed }: { collapsed: boolean }) {
  const { signOut, expiresAt } = useSession();
  const t = useT();
  const hint = expiresAt
    ? `Session ends ${new Date(expiresAt).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })}`
    : "Sign out";

  return (
    <button
      onClick={signOut}
      title={hint}
      aria-label={t("nav.signOut")}
      className={cx(
        "flex h-11 items-center overflow-hidden rounded-xl px-3 text-[13.5px] font-semibold",
        "text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink",
      )}
    >
      <LogOut size={18} className="shrink-0" />
      <span
        className={cx(
          "overflow-hidden whitespace-nowrap transition-all duration-300 ease-[var(--ease-out)]",
          collapsed ? "lg:ml-0 lg:max-w-0 lg:opacity-0" : "ml-3 max-w-40 opacity-100",
        )}
      >
        {t("nav.signOut")}
      </span>
    </button>
  );
}

/** Desktop-only: the drawer has its own close button on small screens. */
function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      className={cx(
        "hidden h-11 items-center overflow-hidden rounded-xl px-3 text-[13.5px] font-semibold",
        "text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink lg:flex",
      )}
    >
      <Icon size={18} className="shrink-0" />
      <span
        className={cx(
          "overflow-hidden whitespace-nowrap transition-all duration-300 ease-[var(--ease-out)]",
          collapsed ? "lg:ml-0 lg:max-w-0 lg:opacity-0" : "ml-3 max-w-40 opacity-100",
        )}
      >
        Collapse
      </span>
    </button>
  );
}
