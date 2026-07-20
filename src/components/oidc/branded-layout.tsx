"use client";

import {
  type AppBranding,
  getBrandingCssVars,
  shouldUseWhiteLabelBranding,
} from "@/lib/oidc/branding-shared";

interface BrandedLayoutProps {
  branding: AppBranding;
  children: React.ReactNode;
}

export function BrandedLayout({ branding, children }: BrandedLayoutProps) {
  const cssVars = getBrandingCssVars(branding);
  const isWhiteLabel = shouldUseWhiteLabelBranding(branding);

  return (
    <main
      className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col"
      style={cssVars as React.CSSProperties}
    >
      <div className="flex-1 flex items-center justify-center p-6">
        {children}
      </div>

      <footer className="py-6 px-6 border-t border-zinc-800/50">
        <div className="max-w-2xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 text-sm text-zinc-500">
            {isWhiteLabel ? (
              <>
                {branding.logoUrl && (
                  // Tenant logo URLs are dynamic, so next/image remote host config cannot enumerate them.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={branding.logoUrl}
                    alt={branding.displayName}
                    className="h-5 w-auto"
                  />
                )}
                <span>{branding.displayName}</span>
              </>
            ) : (
              <>
                <span className="font-semibold">
                  <span className="text-emerald-400">pymt</span>house
                </span>
                <span className="text-zinc-600">|</span>
                <span>Identity Infrastructure</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-4 text-xs text-zinc-500">
            {branding.privacyPolicyUrl && (
              <a
                href={branding.privacyPolicyUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-zinc-300 transition-colors"
              >
                Privacy
              </a>
            )}
            {branding.tosUrl && (
              <a
                href={branding.tosUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-zinc-300 transition-colors"
              >
                Terms
              </a>
            )}
            {branding.supportUrl && (
              <a
                href={branding.supportUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-zinc-300 transition-colors"
              >
                Support
              </a>
            )}
            {branding.supportEmail && !branding.supportUrl && (
              <a
                href={`mailto:${branding.supportEmail}`}
                className="hover:text-zinc-300 transition-colors"
              >
                Support
              </a>
            )}
          </div>
        </div>
      </footer>
    </main>
  );
}

interface BrandedHeaderProps {
  branding: AppBranding;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: "emerald" | "violet" | "red";
}

export function BrandedHeader({
  branding,
  title,
  subtitle,
  badge,
  badgeColor = "emerald",
}: BrandedHeaderProps) {
  const isWhiteLabel = shouldUseWhiteLabelBranding(branding);
  
  const badgeColors = {
    emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    violet: "border-violet-500/20 bg-violet-500/10 text-violet-300",
    red: "border-red-500/20 bg-red-500/10 text-red-300",
  };

  return (
    <div className="flex items-start gap-4 mb-6">
      {isWhiteLabel && branding.logoUrl ? (
        // Tenant logo URLs are dynamic, so next/image remote host config cannot enumerate them.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={branding.logoUrl}
          alt={branding.displayName}
          className="w-14 h-14 rounded-2xl object-cover shrink-0 border border-zinc-700"
        />
      ) : (
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
          style={{ backgroundColor: branding.primaryColor }}
        >
          <svg
            className="w-7 h-7 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
            />
          </svg>
        </div>
      )}
      <div className="min-w-0">
        {badge && (
          <div
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${badgeColors[badgeColor]}`}
          >
            {badge}
          </div>
        )}
        <h1 className="text-2xl font-semibold text-zinc-100 mt-3">{title}</h1>
        {subtitle && (
          <p className="text-sm text-zinc-400 mt-2 max-w-xl">{subtitle}</p>
        )}
      </div>
    </div>
  );
}

interface BrandedButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  children: React.ReactNode;
}

export function BrandedButton({
  variant = "primary",
  children,
  className = "",
  type = "button",
  ...props
}: BrandedButtonProps) {
  const baseClasses = "px-6 py-3 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  
  const variantClasses = {
    primary: "text-white hover:opacity-90",
    secondary: "border border-zinc-700 text-zinc-300 hover:bg-zinc-800/50",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };

  const style = variant === "primary" 
    ? { backgroundColor: "var(--branding-primary)" }
    : undefined;

  return (
    <button
      type={type}
      className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      style={style}
      {...props}
    >
      {children}
    </button>
  );
}
