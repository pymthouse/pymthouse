import { cookies } from "next/headers";
import { Suspense } from "react";
import { LoginForm } from "./login-form";
import {
  OAUTH_ERROR_NOTICE_COOKIE,
  openOauthErrorNotice,
} from "@/lib/oauth-error-notice";

export default async function LoginPage() {
  const noticeEmail =
    openOauthErrorNotice(
      (await cookies()).get(OAUTH_ERROR_NOTICE_COOKIE)?.value,
    )?.email ?? null;

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-zinc-950">
          <div className="animate-pulse text-zinc-500">Loading...</div>
        </div>
      }
    >
      <LoginForm noticeEmail={noticeEmail} />
    </Suspense>
  );
}
