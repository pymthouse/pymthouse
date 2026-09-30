import { cookies } from "next/headers";
import { Suspense } from "react";
import { LoginForm } from "./login-form";
import {
  OAUTH_ERROR_NOTICE_COOKIE,
  openOauthErrorNotice,
} from "@/lib/oauth-error-notice";
import { isTurnkeyBackendAuthEnabled } from "@/lib/turnkey-backend-auth";
import { openWalletConfirm, WALLET_CONFIRM_COOKIE } from "@/lib/turnkey-wallet-handoff";
import { maskEmail } from "@/lib/turnkey-wallet-login";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const noticeEmail =
    openOauthErrorNotice(cookieStore.get(OAUTH_ERROR_NOTICE_COOKIE)?.value)?.email ??
    null;
  const confirm = openWalletConfirm(cookieStore.get(WALLET_CONFIRM_COOKIE)?.value);

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-zinc-950">
          <div className="animate-pulse text-zinc-500">Loading...</div>
        </div>
      }
    >
      <LoginForm
        noticeEmail={noticeEmail}
        backendAuth={isTurnkeyBackendAuthEnabled()}
        confirmEmail={confirm ? maskEmail(confirm.email) : null}
      />
    </Suspense>
  );
}
