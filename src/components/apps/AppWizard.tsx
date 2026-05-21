"use client";

import { useRouter } from "next/navigation";
import type { AppFormData } from "@/domains/developer-apps/ui/app-editor";
import { useAppWizardState } from "@/domains/developer-apps/ui/use-app-wizard-state";
import { OIDC_SCOPES } from "@/platform/oidc/scopes";
import WizardActions from "./wizard/WizardActions";
import WizardAdvancedSection from "./wizard/WizardAdvancedSection";
import WizardBasicsSection from "./wizard/WizardBasicsSection";
import WizardCallbackSection from "./wizard/WizardCallbackSection";
import WizardOAuthCapabilitiesSection from "./wizard/WizardOAuthCapabilitiesSection";

const USERS_TOKEN_SCOPE = OIDC_SCOPES.find((s) => s.value === "users:token")!;

interface Props {
  initialData?: Partial<AppFormData>;
}

const fieldClass =
  "w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded-md text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/50 disabled:opacity-50";

export default function AppWizard({ initialData }: Props) {
  const router = useRouter();
  const {
    formData,
    callbackUrl,
    saving,
    error,
    showAdvanced,
    hasDeviceCode,
    hasIssueUserTokens,
    canSubmit,
    setField,
    setCallbackUrl,
    toggleAdvanced,
    toggleConfidential,
    toggleDeviceCode,
    toggleIssueUserTokens,
    submit,
  } = useAppWizardState(initialData);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const appId = await submit();
      router.push(`/apps/${appId}`);
    } catch {}
  };

  return (
    <div className="max-w-[540px]">
      <h1 className="text-lg font-semibold text-zinc-100 pb-4 mb-6 border-b border-zinc-800">
        Register a new OAuth app
      </h1>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
        {error && (
          <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {error}
          </div>
        )}

        <WizardBasicsSection
          fieldClass={fieldClass}
          formData={formData}
          onNameChange={(value) => setField("name", value)}
          onWebsiteUrlChange={(value) => setField("websiteUrl", value)}
          onDescriptionChange={(value) => setField("description", value)}
        />

        <WizardOAuthCapabilitiesSection
          formData={formData}
          hasDeviceCode={hasDeviceCode}
          hasIssueUserTokens={hasIssueUserTokens}
          usersTokenScope={USERS_TOKEN_SCOPE}
          onToggleConfidential={toggleConfidential}
          onToggleDeviceCode={toggleDeviceCode}
          onToggleIssueUserTokens={toggleIssueUserTokens}
        />

        <WizardCallbackSection
          callbackUrl={callbackUrl}
          fieldClass={fieldClass}
          onCallbackUrlChange={setCallbackUrl}
        />

        <WizardAdvancedSection
          developerName={formData.developerName}
          fieldClass={fieldClass}
          showAdvanced={showAdvanced}
          onToggleAdvanced={toggleAdvanced}
          onDeveloperNameChange={(value) => setField("developerName", value)}
        />

        <WizardActions
          canSubmit={canSubmit}
          saving={saving}
          onCancel={() => router.push("/apps")}
        />
      </form>
    </div>
  );
}
