"use client";

interface Props {
  developerName: string;
  fieldClass: string;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  onDeveloperNameChange: (value: string) => void;
}

export default function WizardAdvancedSection({
  developerName,
  fieldClass,
  showAdvanced,
  onToggleAdvanced,
  onDeveloperNameChange,
}: Props) {
  return (
    <div className="border-t border-zinc-800 pt-4">
      <button
        type="button"
        onClick={onToggleAdvanced}
        className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        <svg
          className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        Advanced settings
      </button>

      {showAdvanced && (
        <div className="mt-4 space-y-5 pl-[22px]">
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-1.5">
              Developer / organization name
            </label>
            <input
              type="text"
              value={developerName}
              onChange={(e) => onDeveloperNameChange(e.target.value)}
              placeholder="Acme Inc."
              className={fieldClass}
            />
          </div>
        </div>
      )}
    </div>
  );
}
