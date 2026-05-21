"use client";

import { docsInteractiveLoginUrl } from "@/platform/docs/base-url";

interface Props {
  callbackUrl: string;
  fieldClass: string;
  onCallbackUrlChange: (value: string) => void;
}

export default function WizardCallbackSection({
  callbackUrl,
  fieldClass,
  onCallbackUrlChange,
}: Props) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-200 mb-1.5">
        Authorization callback URL
      </label>
      <input
        type="url"
        value={callbackUrl}
        onChange={(e) => onCallbackUrlChange(e.target.value)}
        placeholder="https://"
        className={fieldClass}
      />
      <p className="text-xs text-zinc-500 mt-1.5">
        Required for the browser authorization code flow. Optional if you only use device or
        server flows for now; you can add this later in app settings. Read our{" "}
        <a
          href={docsInteractiveLoginUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-500 hover:underline"
        >
          OAuth documentation
        </a>{" "}
        for more information.
      </p>
    </div>
  );
}
