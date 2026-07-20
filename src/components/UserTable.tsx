"use client";

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  oauthProvider: string;
  createdAt: string;
}

interface UserTableProps {
  users: UserRow[];
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const roleBadge: Record<string, string> = {
  admin: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  operator: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  developer: "bg-zinc-500/20 text-zinc-400 border-zinc-700",
};

const providerIcon: Record<string, string> = {
  google: "G",
  github: "GH",
};

export default function UserTable({ users }: Readonly<UserTableProps>) {
  if (users.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <p>No users found</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
            <th className="text-left py-3 px-4 font-medium">User</th>
            <th className="text-left py-3 px-4 font-medium">Provider</th>
            <th className="text-center py-3 px-4 font-medium">Role</th>
            <th className="text-right py-3 px-4 font-medium">Joined</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/50">
          {users.map((user) => (
            <tr
              key={user.id}
              className="hover:bg-zinc-900/50 transition-colors"
            >
              <td className="py-3 px-4">
                <div>
                  <p className="text-zinc-200 font-medium">
                    {user.name || "Unknown"}
                  </p>
                  <p className="text-zinc-500 text-xs">{user.email || "—"}</p>
                </div>
              </td>
              <td className="py-3 px-4">
                <span className="inline-flex items-center gap-1.5 text-zinc-400 text-xs">
                  <span className="w-5 h-5 rounded bg-zinc-800 flex items-center justify-center text-[10px] font-bold">
                    {providerIcon[user.oauthProvider] || "?"}
                  </span>
                  {user.oauthProvider}
                </span>
              </td>
              <td className="py-3 px-4 text-center">
                <span
                  className={`px-2 py-0.5 text-xs font-medium rounded-full border ${
                    roleBadge[user.role] || roleBadge.developer
                  }`}
                >
                  {user.role}
                </span>
              </td>
              <td className="py-3 px-4 text-right text-zinc-500 text-xs">
                {timeAgo(user.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
