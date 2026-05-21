export const dynamic = "force-dynamic";

import Link from "next/link";
import DashboardLayout from "@/components/DashboardLayout";
import UserTable from "@/components/UserTable";
import CreateEndUserForm from "@/components/CreateEndUserForm";
import { getUsersPageData } from "@/platform/ops/runtime/end-users";

function formatWei(wei: string): string {
  if (wei === "0") return "0 ETH";
  const value = BigInt(wei);
  const eth = Number(value) / 1e18;
  if (eth < 0.001) return `${wei} wei`;
  return `${eth.toFixed(6)} ETH`;
}

export default async function UsersPage() {
  const { adminUsers, enrichedEndUsers } = await getUsersPageData();

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight">Users</h2>
        <p className="text-zinc-500 mt-1">
          App users and platform accounts
        </p>
      </div>

      {/* End Users section */}
      <div className="border border-zinc-800 rounded-xl bg-zinc-900/30 mb-8">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-zinc-200">App Users</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              App users with credit balances and usage tracking
            </p>
          </div>
          <CreateEndUserForm />
        </div>

        {enrichedEndUsers.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <p>No app users yet</p>
            <p className="text-xs mt-1">
              Create an app user to get started
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
                  <th className="text-left py-3 px-4 font-medium">User</th>
                  <th className="text-right py-3 px-4 font-medium">Credits</th>
                  <th className="text-right py-3 px-4 font-medium">Streams</th>
                  <th className="text-right py-3 px-4 font-medium">Txns</th>
                  <th className="text-center py-3 px-4 font-medium">Status</th>
                  <th className="text-right py-3 px-4 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {enrichedEndUsers.map((user) => (
                  <tr
                    key={user.id}
                    className="hover:bg-zinc-900/50 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <Link
                        href={`/users/${user.id}`}
                        className="hover:text-emerald-400 transition-colors"
                      >
                        <p className="text-zinc-200 font-medium">
                          {user.name || user.email || "Unnamed"}
                        </p>
                        <p className="text-zinc-500 text-xs">
                          {user.walletAddress
                            ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
                            : user.id.slice(0, 12)}
                        </p>
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-right text-zinc-300 font-mono text-xs">
                      {formatWei(user.creditBalanceWei)}
                    </td>
                    <td className="py-3 px-4 text-right text-zinc-300">
                      {user.streamCount}
                    </td>
                    <td className="py-3 px-4 text-right text-zinc-300">
                      {user.transactionCount}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                          user.isActive
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {user.isActive ? "active" : "suspended"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-zinc-500 text-xs">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Admin users */}
      <div className="border border-zinc-800 rounded-xl bg-zinc-900/30">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="font-semibold text-zinc-200">
            Platform Accounts
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Administrators and developers
          </p>
        </div>
        <UserTable users={adminUsers} />
      </div>
    </DashboardLayout>
  );
}
