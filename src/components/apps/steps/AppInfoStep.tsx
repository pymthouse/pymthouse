"use client";

import type { AppFormData } from "../AppWizard";

interface Props {
  data: AppFormData;
  onChange: (updates: Partial<AppFormData>) => void;
  readOnly?: boolean;
}

export default function AppInfoStep({ data, onChange, readOnly = false }: Readonly<Props>) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">App Info</h2>
      </div>
      <div>
        <label htmlFor="app-info-name" className="block text-sm font-medium text-zinc-300 mb-1.5">
          App Name <span className="text-red-400">*</span>
        </label>
        <input
          id="app-info-name"
          type="text"
          value={data.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="My Awesome App"
          disabled={readOnly}
          className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 disabled:opacity-60 disabled:cursor-not-allowed"
        />
      </div>

      <div>
        <label htmlFor="app-info-description" className="block text-sm font-medium text-zinc-300 mb-1.5">
          Description
        </label>
        <p className="text-xs text-zinc-500 mb-1.5">
          Short internal description of the provider app and what it exposes.
        </p>
        <textarea
          id="app-info-description"
          value={data.description}
          onChange={(e) => onChange({ description: e.target.value })}
          rows={4}
          placeholder="Describe your app..."
          disabled={readOnly}
          className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 resize-none disabled:opacity-60 disabled:cursor-not-allowed"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="app-info-developer" className="block text-sm font-medium text-zinc-300 mb-1.5">
            Developer Name
          </label>
          <input
            id="app-info-developer"
            type="text"
            value={data.developerName}
            onChange={(e) => onChange({ developerName: e.target.value })}
            placeholder="Acme Inc."
            disabled={readOnly}
            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 disabled:opacity-60 disabled:cursor-not-allowed"
          />
        </div>
        <div>
          <label htmlFor="app-info-website" className="block text-sm font-medium text-zinc-300 mb-1.5">
            Website URL
          </label>
          <input
            id="app-info-website"
            type="url"
            value={data.websiteUrl}
            onChange={(e) => onChange({ websiteUrl: e.target.value })}
            placeholder="https://example.com"
            disabled={readOnly}
            className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 disabled:opacity-60 disabled:cursor-not-allowed"
          />
        </div>
      </div>
    </div>
  );
}
