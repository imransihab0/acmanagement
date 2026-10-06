import { useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import { KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Button, Input, cx } from "./ui";
import { useSession } from "../lib/session";
import { errorMessage } from "../lib/toast";

/**
 * Nothing renders until the server confirms a live session. This is a gate,
 * not decoration — the Convex functions behind it independently reject any
 * call without a valid token, so bypassing this screen gains nothing.
 */
export function PasscodeGate({ children }: { children: ReactNode }) {
  const { status, configured, signIn } = useSession();

  if (status === "loading" || configured === undefined) return <Booting />;
  if (status === "signedIn") return <>{children}</>;
  // A deployment with no passcode cannot be claimed from the browser — it has
  // to be set with admin credentials. See NotConfigured.
  if (!configured) return <NotConfigured />;
  return <SignInScreen onSignedIn={signIn} />;
}

function Booting() {
  return (
    <div className="flex min-h-full items-center justify-center bg-page">
      <Loader2 size={22} className="animate-spin text-ink-3" aria-label="Loading" />
    </div>
  );
}

/**
 * Shown when a deployment has no passcode yet. Deliberately offers no way to
 * set one: the endpoint that does is internal, so whoever reaches a fresh
 * deployment first cannot take it over.
 */
function NotConfigured() {
  return (
    <div className="flex min-h-full items-center justify-center bg-page p-4">
      <div className="ac-pop-in w-full max-w-md text-center">
        <span
          className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl text-white shadow-[var(--shadow-hero)]"
          style={{ background: "var(--grad-violet)" }}
        >
          <ShieldCheck size={24} />
        </span>
        <h1 className="text-[22px] leading-7 font-bold tracking-tight text-ink">
          No passcode set
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-6 text-ink-3">
          This deployment has no passcode yet, and one cannot be set from here.
          Run this with your Convex credentials:
        </p>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface px-4 py-3 text-left text-[12.5px] text-ink">
          npx convex run auth:setPasscode {"'"}
          {'{"passcode":"…"}'}
          {"'"}
        </pre>
        <p className="mt-3 text-[12px] leading-5 text-ink-3">
          Then add the addresses allowed to sign in:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface px-4 py-3 text-left text-[12.5px] text-ink">
          npx convex run otp:allowEmail {"'"}
          {'{"email":"you@gmail.com"}'}
          {"'"}
        </pre>
      </div>
    </div>
  );
}

/**
 * Which step the screen is on.
 *
 * `passcode` is where every sign-in starts and usually ends. The other two
 * exist for the case the server escalates into: after five wrong passcodes it
 * stops accepting one on its own, and the way back is an emailed code.
 */
type Step = "passcode" | "email" | "code";

/**
 * Signing in: the passcode, and an emailed code only when it is needed.
 *
 * Normally this is one field. After five wrong passcodes the server answers
 * `otpRequired`, and the screen switches to asking for an address and the code
 * sent to it; a passcode is accepted again only against the grant that
 * produces. A correct passcode at any point clears the count and the next
 * sign-in is one field again.
 *
 * The browser decides none of this. It never counts failures itself or
 * chooses when to escalate — it goes where the server's answer sends it, and
 * the grant token it holds is one the server issued and can withdraw.
 */
function SignInScreen({
  onSignedIn,
}: {
  onSignedIn: (token: string, expiresAt: number) => void;
}) {
  const login = useMutation(api.auth.login);
  const requestCode = useAction(api.otp.requestCode);
  const verifyCode = useMutation(api.otp.verifyCode);
  const completeLogin = useMutation(api.otp.completeLogin);

  const [step, setStep] = useState<Step>("passcode");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [passcode, setPasscode] = useState("");
  const [grantToken, setGrantToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
    Whether the emailed-code detour is in play. It is never chosen here — it
    follows from the server having answered `otpRequired`, which is what moved
    the screen off the passcode step in the first place.
  */
  const escalated = step !== "passcode" || grantToken !== null;

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestCode({ email });
      if (!result.ok) {
        setError(result.error ?? "The code could not be sent.");
        return;
      }
      setCode("");
      setStep("code");
      setNotice(`Code sent to ${email.trim().toLowerCase()}. It expires in 10 minutes.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verifyCode({ email, code });
      if (!result.ok) {
        setError(result.error);
        setCode("");
        return;
      }
      setGrantToken(result.grantToken);
      setPasscode("");
      setStep("passcode");
      setNotice("Code accepted. Now enter your passcode.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitPasscode(e: React.FormEvent) {
    e.preventDefault();
    if (busy || passcode.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      /*
        Two routes to the same place. Ordinarily the passcode stands on its
        own; once the server has escalated, it is only accepted against the
        grant a verified code produced. Which one applies is the server's
        call — this just follows the answer it gave.
      */
      if (grantToken) {
        const result = await completeLogin({ grantToken, passcode });
        if (!result.ok) {
          /*
            The grant is spent whether or not the passcode was right, so there
            is nothing left to retry against. Back to the email step, with the
            address kept so the only thing to redo is the code.
          */
          setGrantToken(null);
          setPasscode("");
          setCode("");
          setStep("email");
          setError(`${result.error} Verify by email again to unlock the passcode.`);
          return;
        }
        onSignedIn(result.token, result.expiresAt);
        return;
      }

      const result = await login({ passcode });
      if (!result.ok) {
        setPasscode("");
        if (result.otpRequired) {
          // Escalated. The passcode alone will not be looked at again until a
          // code has been answered.
          setStep("email");
          setError(result.error);
          return;
        }
        setError(result.error);
        return;
      }
      onSignedIn(result.token, result.expiresAt);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Back to the plain passcode field, abandoning a half-finished escalation. */
  function startOver() {
    setGrantToken(null);
    setStep("passcode");
    setCode("");
    setPasscode("");
    setError(null);
    setNotice(null);
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-page p-4">
      <div className="ac-pop-in w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-4 flex size-14 items-center justify-center overflow-hidden rounded-2xl bg-white p-1.5 shadow-[var(--shadow-hero)]">
            <img src="/brand/bdmushroom-seal.png" alt="" className="size-full object-contain" />
          </span>
          <h1 className="text-[22px] leading-7 font-bold tracking-tight text-ink">Ledger</h1>
          <p className="mt-1.5 max-w-xs text-[13.5px] leading-6 text-ink-3">
            {step === "email"
              ? "Verify by email to unlock the passcode again."
              : step === "code"
                ? "Enter the code we emailed you."
                : grantToken
                  ? "Code accepted. Now your passcode."
                  : "Enter your passcode to continue."}
          </p>
        </div>

        {escalated && <StepDots step={step} />}

        <div className="rounded-card border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
          {step === "email" && (
            <form onSubmit={sendCode} className="flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-[13px] font-semibold text-ink-2">Email</span>
                <div className="relative">
                  <Mail
                    size={16}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
                    aria-hidden
                  />
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError(null);
                    }}
                    placeholder="you@gmail.com"
                    autoComplete="email"
                    autoFocus
                    className="pl-10"
                  />
                </div>
              </label>
              <Message error={error} notice={notice} />
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !email.trim()}
                className="w-full"
              >
                {busy ? "Sending…" : "Email me a code"}
              </Button>
            </form>
          )}

          {step === "code" && (
            <form onSubmit={submitCode} className="flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-[13px] font-semibold text-ink-2">Six-digit code</span>
                <Input
                  value={code}
                  onChange={(e) => {
                    // Digits only, so a pasted "123 456" still works.
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                    setError(null);
                  }}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  className="text-center text-[22px] font-bold tracking-[0.4em] tabular-nums"
                />
              </label>
              <Message error={error} notice={notice} />
              <Button
                type="submit"
                variant="primary"
                disabled={busy || code.length < 6}
                className="w-full"
              >
                {busy ? "Checking…" : "Verify code"}
              </Button>
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={startOver}
                  className="text-[12.5px] font-semibold text-ink-3 hover:text-ink"
                >
                  Use another email
                </button>
                <button
                  type="button"
                  onClick={() => sendCode()}
                  disabled={busy}
                  className="text-[12.5px] font-semibold text-accent hover:underline disabled:opacity-40"
                >
                  Send again
                </button>
              </div>
            </form>
          )}

          {step === "passcode" && (
            <form onSubmit={submitPasscode} className="flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <span className="text-[13px] font-semibold text-ink-2">Passcode</span>
                <div className="relative">
                  <KeyRound
                    size={16}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
                    aria-hidden
                  />
                  <Input
                    type="password"
                    value={passcode}
                    onChange={(e) => {
                      setPasscode(e.target.value);
                      setError(null);
                    }}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    autoFocus
                    className="pl-10"
                  />
                </div>
              </label>
              <Message error={error} notice={notice} />
              {grantToken && (
                <p className="text-[12px] leading-4.5 text-ink-3">
                  One try. A wrong passcode closes this step and needs a fresh emailed code.
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={busy || passcode.length === 0}
                className="w-full"
              >
                {busy ? "Checking…" : "Unlock"}
              </Button>
              {escalated && (
                <button
                  type="button"
                  onClick={startOver}
                  className="text-[12.5px] font-semibold text-ink-3 hover:text-ink"
                >
                  Start again
                </button>
              )}
            </form>
          )}
        </div>

        <p className="mt-5 flex items-start justify-center gap-2 px-2 text-center text-[12px] leading-5 text-ink-3">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>Sessions last one day, then you sign in again.</span>
        </p>
      </div>
    </div>
  );
}

/** Where you are in the two proofs, so the screen never feels like a loop. */
function StepDots({ step }: { step: Step }) {
  const order: Step[] = ["email", "code", "passcode"];
  // The escalation runs email -> code -> passcode, which is why `passcode`
  // is last here even though an ordinary sign-in starts on it.
  const at = order.indexOf(step);
  return (
    <ol className="mb-3 flex items-center justify-center gap-2" aria-label="Sign-in progress">
      {order.map((s, i) => (
        <li
          key={s}
          aria-current={i === at ? "step" : undefined}
          className={cx(
            "h-1.5 rounded-full transition-all duration-300",
            i === at ? "w-7 bg-accent" : i < at ? "w-4 bg-accent/45" : "w-4 bg-line-strong",
          )}
        />
      ))}
    </ol>
  );
}

function Message({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) {
    return (
      <p
        role="alert"
        className={cx(
          "rounded-xl border border-[color-mix(in_srgb,var(--critical)_28%,transparent)]",
          "bg-critical-soft px-3.5 py-2.5 text-[12.5px] font-medium text-critical-ink",
        )}
      >
        {error}
      </p>
    );
  }
  if (notice) {
    return (
      <p className="rounded-xl border border-line bg-page px-3.5 py-2.5 text-[12.5px] text-ink-2">
        {notice}
      </p>
    );
  }
  return null;
}
