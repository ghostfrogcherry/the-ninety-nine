"use client";

/**
 * The fourth "use client" file, and why it exists.
 *
 * A draft is the one screen in this app that changes while you look at it:
 * other people pick, packs arrive, the host starts the pod. Without JavaScript
 * the page keeps up through a <meta http-equiv="refresh"> inside <noscript>
 * (see LiveRefresh in ../_parts.tsx), which works but reloads the whole
 * document every few seconds — a white flash, lost scroll, and every card image
 * re-requested. This file is progressive enhancement over that fallback and
 * nothing else; every control it renders is still an ordinary <button> in an
 * ordinary <form>, and the page is complete without it:
 *
 *  - AutoRefresh re-fetches the server component tree in place with
 *    router.refresh() while you are waiting, and stops while the tab is hidden
 *    so a pod left open in a background tab does not poll all evening.
 *  - PickButton reads useFormStatus so the card you chose lights up the moment
 *    you click and the rest of the pack dims (CSS, keyed off `data-pending`)
 *    until the next pack lands. It is also what stops a double click becoming
 *    a second POST — the engine would refuse it, but the refusal would flash an
 *    error for something the person did not mean to do.
 *  - CopyButton copies the invite link. It renders nothing until mounted and
 *    nothing where the Clipboard API is missing (plain http on a LAN address),
 *    so no one is shown a button that cannot work; the readonly input beside
 *    it is the no-JS way to copy.
 *
 * Keep it this small. Anything that can be CSS or a server component should be.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), intervalMs);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Coming back to the tab: catch up now rather than one interval late.
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);

  return null;
}

export function PickButton({ label, children }: { label: string; children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="pick-card"
      aria-label={label}
      title={label}
      disabled={pending}
      aria-busy={pending || undefined}
      data-pending={pending ? "" : undefined}
    >
      {children}
    </button>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setReady(typeof navigator !== "undefined" && Boolean(navigator.clipboard));
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  if (!ready) return null;
  return (
    <button
      type="button"
      className="mini"
      onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
}
