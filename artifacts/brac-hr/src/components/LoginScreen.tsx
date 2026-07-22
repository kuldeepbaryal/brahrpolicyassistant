"use client";

import { useEffect, useRef, useState } from "react";
import { api, type PublicUser } from "@/lib/client";
import { BracLogo } from "./BracLogo";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: Record<string, unknown>) => void;
          renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
        };
      };
    };
  }
}

export function LoginScreen({
  clientId,
  hostedDomain,
  mockMode,
  onSignedIn,
}: {
  clientId: string;
  hostedDomain: string;
  mockMode: boolean;
  onSignedIn: (user: PublicUser) => void;
}) {
  const btnRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleCredential = async (credential: string) => {
    setError(null);
    setBusy(true);
    try {
      onSignedIn(await api.signIn(credential));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  useEffect(() => {
    if (mockMode) return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      if (!window.google || !btnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (resp: { credential: string }) => handleCredential(resp.credential),
        hd: hostedDomain,
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      window.google.accounts.id.renderButton(btnRef.current, {
        theme: "outline",
        size: "large",
        shape: "pill",
        text: "signin_with",
        width: 280,
      });
    };
    document.body.appendChild(script);
    return () => { script.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, hostedDomain, mockMode]);

  return (
    <div
      className="flex min-h-dvh items-center justify-center px-6"
      style={{ background: "var(--bg)" }}
    >
      <div className="w-full max-w-sm animate-rise-in">
        <div
          className="rounded-2xl border p-8 text-center sm:p-10"
          style={{
            background: "var(--bg-elevated)",
            borderColor: "var(--border-strong)",
            boxShadow: "var(--shadow)",
          }}
        >
          <div className="flex justify-center">
            <BracLogo size={48} />
          </div>

          <h1
            className="mt-7 text-xl font-semibold tracking-tight"
            style={{ color: "var(--text)" }}
          >
            Your HR questions, answered
          </h1>
          <p
            className="mx-auto mt-2.5 max-w-xs text-sm leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            Ask about leave, benefits, or any BRAC HR policy. Every answer is grounded in
            official HR documents and cites its sources.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3">
            {mockMode ? (
              <button
                onClick={() => handleCredential("mock")}
                disabled={busy}
                className="rounded-lg px-6 py-2.5 text-sm font-semibold text-white transition-all active:scale-[0.98] disabled:opacity-60"
                style={{
                  background: "var(--color-accent-500)",
                }}
              >
                {busy ? "Signing in..." : "Continue (mock dev user)"}
              </button>
            ) : (
              <div ref={btnRef} className="flex justify-center" />
            )}

            {error && (
              <p
                className="rounded-lg px-4 py-2 text-sm"
                style={{ background: "#f8e9e9", color: "var(--color-brand-deepred)" }}
              >
                {error}
              </p>
            )}
          </div>

          <p className="mt-8 text-xs leading-relaxed" style={{ color: "var(--text-faint)" }}>
            Sign in with your <strong style={{ color: "var(--text-muted)" }}>@brac.net</strong> Google account.
            <br />
            Your questions are not stored beyond your session.
          </p>
        </div>

        <p className="mt-4 text-center text-[11px]" style={{ color: "var(--text-faint)" }}>
          For official HR guidance, contact{" "}
          <a href="mailto:hrhelpdesk@brac.net" className="hover:underline" style={{ color: "var(--color-accent-600)" }}>
            hrhelpdesk@brac.net
          </a>
        </p>
      </div>
    </div>
  );
}
