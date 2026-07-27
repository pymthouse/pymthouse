"use client";

import { useEffect, useRef, useState } from "react";
import CopyIdButton from "@/components/apps/CopyIdButton";
import SidebarCreditPreview from "@/components/SidebarCreditPreview";

function roleBadgeClassName(role: string): string {
  if (role === "admin") return "bg-amber-500/15 text-amber-400";
  if (role === "operator") return "bg-blue-500/15 text-blue-400";
  return "bg-zinc-700/60 text-zinc-400";
}

/** Labeled row with an optional copy button for the full (untruncated) value. */
function FieldRow({
  label,
  value,
  mono = false,
}: Readonly<{
  label: string;
  value: string;
  mono?: boolean;
}>) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-zinc-500">{label}</p>
      <div className="flex items-center gap-1.5">
        <p
          className={`min-w-0 flex-1 truncate text-[11px] text-zinc-300 ${mono ? "font-mono" : ""}`}
          title={value}
        >
          {value}
        </p>
        <CopyIdButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

const PROFILE_ICON =
  "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z";

/**
 * Sidebar Profile control: opens an account context menu (no navigation).
 */
export default function UserMenu({
  name,
  email,
  userId,
  role,
}: Readonly<{
  name: string | null;
  email: string | null;
  userId: string;
  role?: string;
}>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Label "Wallet" for 0x… addresses so users aren't confused by seeing a
  // raw hex string under a generic "Name" heading.
  const isWallet = typeof name === "string" && /^0x[0-9a-fA-F]{8,}$/.test(name.trim());
  const nameLabel = isWallet ? "Wallet" : "Name";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Profile"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 ${
          open
            ? "bg-emerald-500/10 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.12)]"
            : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
        }`}
      >
        <svg
          className="h-5 w-5 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d={PROFILE_ICON}
          />
        </svg>
        Profile
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40 sm:w-64"
        >
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Account
            </p>
            {role && (
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${roleBadgeClassName(role)}`}
              >
                {role}
              </span>
            )}
          </div>

          <div className="space-y-3 p-4">
            {name && (
              <FieldRow label={nameLabel} value={name} mono={isWallet} />
            )}
            {email && (
              <FieldRow label="Email" value={email} />
            )}
            <FieldRow label="User ID" value={userId} mono />
          </div>

          <div className="border-t border-zinc-800 px-4 py-2.5">
            <SidebarCreditPreview />
          </div>
        </div>
      )}
    </div>
  );
}
