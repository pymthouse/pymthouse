import Link from "next/link";

type CrumbKey = "plans" | "discovery-profiles";

interface Props {
  appId: string;
  appName: string;
  current: CrumbKey;
}

/**
 * In-app navigation: My Apps → … → current section (Plans or Discovery profiles).
 */
export default function AppSectionBreadcrumb({ appId, appName, current }: Props) {
  return (
    <nav className="text-sm text-zinc-500 mb-3" aria-label="Breadcrumb">
      <Link href="/apps" className="hover:text-zinc-300 transition-colors">
        My Apps
      </Link>
      <span className="mx-1.5 text-zinc-600" aria-hidden>
        /
      </span>
      <span className="text-zinc-400">{appName}</span>
      <span className="mx-1.5 text-zinc-600" aria-hidden>
        /
      </span>
      {current === "plans" ? (
        <span className="text-zinc-200 font-medium">Plans</span>
      ) : (
        <>
          <Link
            href={`/apps/${appId}/plans`}
            className="hover:text-zinc-300 transition-colors"
          >
            Plans
          </Link>
          <span className="mx-1.5 text-zinc-600" aria-hidden>
            /
          </span>
          <span className="text-zinc-200 font-medium">Discovery profiles</span>
        </>
      )}
    </nav>
  );
}
