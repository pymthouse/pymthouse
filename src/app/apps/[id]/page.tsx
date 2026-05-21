"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import DashboardLayout from "@/components/DashboardLayout";
import AppSettingsScreen from "@/components/apps/AppSettingsScreen";
import {
  fetchAppEditorModel,
} from "@/domains/developer-apps/ui/app-editor-api";
import {
  getAppStatusInfo,
  type AppEditorModel,
} from "@/domains/developer-apps/ui/app-editor";

export default function AppDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [appData, setAppData] = useState<AppEditorModel | null>(null);

  useEffect(() => {
    fetchAppEditorModel(id)
      .then((data) => setAppData(data))
      .catch(() => setAppData(null))
      .finally(() => setLoading(false));
  }, [id]);

  const handleReviewSubmitted = useCallback(() => {
    setAppData((prev) =>
      prev
        ? {
            ...prev,
            state: { ...prev.state, status: "submitted" },
          }
        : null,
    );
  }, []);

  const handleRevertedToDraft = useCallback(() => {
    setAppData((prev) =>
      prev
        ? {
            ...prev,
            state: { ...prev.state, status: "draft" },
          }
        : null,
    );
  }, []);

  if (loading) {
    return (
      <DashboardLayout>
        <div className="text-zinc-500 text-center py-12 animate-pulse">
          Loading app…
        </div>
      </DashboardLayout>
    );
  }

  if (!appData) {
    return (
      <DashboardLayout>
        <div className="text-center py-12">
          <h2 className="text-lg font-medium text-zinc-300">App not found</h2>
        </div>
      </DashboardLayout>
    );
  }

  const statusInfo =
    getAppStatusInfo(appData.state.status);

  return (
    <DashboardLayout>
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-100">
            {appData.formData.name || "App"}
          </h1>
          <span
            className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}
          >
            {statusInfo.label}
          </span>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Edit integration settings, credentials, and run OIDC tests. The create
          wizard is only used when you add a new app.
        </p>
      </div>

      <AppSettingsScreen
        appId={id}
        initialData={appData.formData}
        initialState={appData.state}
        initialDomains={appData.domains}
        initialPostLogoutRedirectUris={appData.postLogoutRedirectUris}
        initialInitiateLoginUri={appData.initiateLoginUri}
        initialDeviceThirdPartyInitiateLogin={
          appData.deviceThirdPartyInitiateLogin
        }
        canEdit={appData.canEdit}
        canSubmitForReview={appData.canSubmitForReview}
        onReviewSubmitted={handleReviewSubmitted}
        onRevertedToDraft={handleRevertedToDraft}
      />
    </DashboardLayout>
  );
}
