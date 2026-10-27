export type BrandingMode = "blackLabel" | "whiteLabel";

export interface AppBranding {
  mode: BrandingMode;
  appId: string | null;
  appName: string;
  displayName: string;
  logoUrl: string | null;
  primaryColor: string;
  websiteUrl: string | null;
  privacyPolicyUrl: string | null;
  tosUrl: string | null;
  supportUrl: string | null;
  supportEmail: string | null;
  developerName: string | null;
  customLoginDomain: string | null;
  customLoginEnabled: boolean;
}

const DEFAULT_BRANDING: AppBranding = {
  mode: "blackLabel",
  appId: null,
  appName: "pymthouse",
  displayName: "pymthouse",
  logoUrl: null,
  primaryColor: "#10b981",
  websiteUrl: null,
  privacyPolicyUrl: null,
  tosUrl: null,
  supportUrl: null,
  supportEmail: null,
  developerName: null,
  customLoginDomain: null,
  customLoginEnabled: false,
};

export function getDefaultBranding(): AppBranding {
  return { ...DEFAULT_BRANDING };
}

export function shouldUseWhiteLabelBranding(branding: AppBranding): boolean {
  return branding.mode === "whiteLabel";
}

export function getBrandingCssVars(branding: AppBranding): Record<string, string> {
  const color = isValidHexColor(branding.primaryColor) ? branding.primaryColor : "#10b981";
  return {
    "--branding-primary": color,
    "--branding-primary-hover": adjustColorBrightness(color, -10),
    "--branding-primary-muted": `${color}1a`,
  };
}

function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function adjustColorBrightness(hex: string, amount: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
