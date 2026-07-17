import { Suspense } from "react";
import { AdminLoginForm } from "./admin-login-form";

export default function AdminLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-zinc-950">
          <div className="animate-pulse text-zinc-500">Loading...</div>
        </div>
      }
    >
      <AdminLoginForm />
    </Suspense>
  );
}
