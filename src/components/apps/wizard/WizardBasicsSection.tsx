"use client";

import type { AppFormData } from "@/domains/developer-apps/ui/app-editor";

interface Props {
  fieldClass: string;
  formData: AppFormData;
  onNameChange: (value: string) => void;
  onWebsiteUrlChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}

export default function WizardBasicsSection({
  fieldClass,
  formData,
  onNameChange,
  onWebsiteUrlChange,
  onDescriptionChange,
}: Props) {
  return (
    <>
      <div>
        <label className="block text-sm font-medium text-zinc-200 mb-1.5">
          Application name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={formData.name}
          onChange={(e) => onNameChange(e.target.value)}
          required
          className={fieldClass}
        />
        <p className="text-xs text-zinc-500 mt-1.5">Something users will recognize and trust.</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-200 mb-1.5">
          Homepage URL <span className="text-zinc-500 font-normal">(optional)</span>
        </label>
        <input
          type="url"
          value={formData.websiteUrl}
          onChange={(e) => onWebsiteUrlChange(e.target.value)}
          placeholder="https://"
          className={fieldClass}
        />
        <p className="text-xs text-zinc-500 mt-1.5">
          Shown on consent and in marketplace listings when set.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-200 mb-1.5">
          Application description
        </label>
        <textarea
          value={formData.description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={3}
          placeholder="Application description is optional"
          className={`${fieldClass} resize-none`}
        />
        <p className="text-xs text-zinc-500 mt-1.5">
          This is displayed to all users of your application.
        </p>
      </div>
    </>
  );
}
