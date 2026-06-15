import { Suspense } from "react";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-zinc-950">
          <div className="animate-pulse text-zinc-500">Loading...</div>
        </div>
      }
    >
      <LoginForm
        githubOAuthEnabled={!!process.env.GITHUB_CLIENT_ID?.trim()}
      />
    </Suspense>
  );
}
