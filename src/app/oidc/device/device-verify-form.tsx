"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { normalizeUserCode } from "@/platform/oidc/device";

interface DeviceInfo {
  clientName: string;
  scopes: string[];
  primaryColor?: string;
  impliedDeviceConsent?: boolean;
}

export default function DeviceVerifyForm() {
  const searchParams = useSearchParams();
  const prefilled = searchParams.get("user_code") || "";
  const [userCode, setUserCode] = useState(prefilled);
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error" | "denied"
  >("idle");
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"enter" | "confirm">("enter");
  const impliedConsentStartedRef = useRef(false);

  const rawPrimaryColor = deviceInfo?.primaryColor || "#10b981";
  const primaryColor = /^#[0-9a-fA-F]{6}$/.test(rawPrimaryColor) ? rawPrimaryColor : "#10b981";

  const lookupCode = useCallback(async (code: string): Promise<boolean> => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/v1/oidc/device/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: code, action: "lookup" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error_description || data.error || "Invalid code");
        setStatus("error");
        setStep("enter");
        return false;
      }
      setDeviceInfo({
        clientName: data.client_name,
        scopes: data.scopes,
        primaryColor: data.branding?.primaryColor,
        impliedDeviceConsent: data.implied_device_consent === true,
      });
      setStep("confirm");
      setStatus("idle");
      return true;
    } catch {
      setError("Failed to verify code. Please try again.");
      setStatus("error");
      setStep("enter");
      return false;
    }
  }, []);

  const authorize = useCallback(async (allow: boolean, codeOverride?: string) => {
    const code = normalizeUserCode((codeOverride ?? userCode).trim());
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/v1/oidc/device/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_code: code,
          action: allow ? "approve" : "deny",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error_description || data.error || "Failed");
        setStatus("error");
        return;
      }
      setStatus(allow ? "success" : "denied");
    } catch {
      setError("Something went wrong. Please try again.");
      setStatus("error");
    }
  }, [userCode]);

  // If prefilled, immediately look up the device code
  useEffect(() => {
    if (!prefilled) {
      return;
    }
    const normalized = normalizeUserCode(prefilled);
    void (async () => {
      await Promise.resolve();
      setUserCode(normalized);
      const result = await lookupCode(normalized);
      if (!result) {
        setStep("enter");
        setStatus("error");
        setError("Failed to verify code. Please try again.");
      }
    })();
  }, [prefilled, lookupCode]);

  useEffect(() => {
    if (
      !prefilled ||
      !deviceInfo?.impliedDeviceConsent ||
      impliedConsentStartedRef.current ||
      step !== "confirm" ||
      status !== "idle"
    ) {
      return;
    }
    impliedConsentStartedRef.current = true;
    const code = normalizeUserCode(prefilled);
    void Promise.resolve().then(() => {
      void authorize(true, code);
    });
  }, [prefilled, deviceInfo, step, status, authorize]);

  function handleSubmitCode(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = normalizeUserCode(userCode.trim());
    setUserCode(cleaned);
    lookupCode(cleaned);
  }

  if (status === "success") {
    return (
      <div className="text-center space-y-4">
        <div 
          className="w-16 h-16 rounded-full flex items-center justify-center mx-auto"
          style={{ 
            backgroundColor: `${primaryColor}1a`, 
            borderWidth: 1, 
            borderColor: `${primaryColor}33` 
          }}        >
          <svg className="w-8 h-8" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-zinc-100">Device Authorized</h2>
        <p className="text-sm text-zinc-400">
          You can close this window and return to your device.
        </p>
      </div>
    );
  }

  if (status === "denied") {
    return (
      <div className="text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
          <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-zinc-100">Access Denied</h2>
        <p className="text-sm text-zinc-400">
          The device will not be granted access. You can close this window.
        </p>
      </div>
    );
  }

  if (step === "enter") {
    return (
      <form onSubmit={handleSubmitCode} className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 mb-1">
            Enter Device Code
          </h2>
          <p className="text-sm text-zinc-400">
            Enter the code shown on your device to authorize access to your account.
          </p>
        </div>

        <div>
          <input
            type="text"
            value={userCode}
            onChange={(e) => setUserCode(normalizeUserCode(e.target.value))}
            placeholder="ABCD-1234"
            maxLength={8}
            className="w-full text-center text-2xl font-mono tracking-[0.3em] px-4 py-4 rounded-xl bg-zinc-950/60 border border-zinc-700 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:border-opacity-50"
            style={{ 
              "--tw-ring-color": `${primaryColor}66`,
            } as React.CSSProperties}
            autoFocus
            autoComplete="off"
          />
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={userCode.length < 8 || status === "loading"}
          className="w-full px-6 py-3 text-sm font-medium rounded-xl text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          style={{ backgroundColor: primaryColor }}
        >
          {status === "loading" ? "Verifying..." : "Continue"}
        </button>
      </form>
    );
  }

  // step === "confirm"
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">
          Authorize Device
        </h2>
        <p className="text-sm text-zinc-400">
          Confirm that you want to sign in on {deviceInfo?.clientName || "this device"}.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500">
          Device Code
        </p>
        <p className="text-lg font-mono text-zinc-100 mt-1 tracking-wider">
          {userCode}
        </p>
      </div>

      {deviceInfo && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-500 mb-3">
            Application
          </p>
          <p className="text-sm font-medium text-zinc-100">
            {deviceInfo.clientName}
          </p>
          <p className="text-xs text-zinc-500 mt-2">
            requests access to: {deviceInfo.scopes.join(", ")}
          </p>
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => authorize(false)}
          disabled={status === "loading"}
          className="flex-1 px-6 py-3 text-sm font-medium rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => authorize(true)}
          disabled={status === "loading"}
          className="flex-1 px-6 py-3 text-sm font-medium rounded-xl text-white hover:opacity-90 disabled:opacity-50 transition-colors"
          style={{ backgroundColor: primaryColor }}
        >
          {status === "loading" ? "Authorizing..." : "Authorize"}
        </button>
      </div>
    </div>
  );
}
