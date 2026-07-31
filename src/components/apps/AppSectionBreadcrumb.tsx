import Link from "next/link";

interface Props {
  appId: string;
  appName: string;
  /** Current section label (last crumb). */
  section?: string;
  /**
   * Optional intermediate crumb between the app and the current section,
   * e.g. Identities → a single identity.
   */
  parentSection?: { label: string; href: string };
}

/**
 * In-app navigation: My Apps → app → [section] → current.
 */
export default function AppSectionBreadcrumb({
  appId,
  appName,
  section = "Plans",
  parentSection,
}: Readonly<Props>) {
  return (
    <nav className="text-sm text-zinc-500 mb-3" aria-label="Breadcrumb">
      <Link href="/apps" className="hover:text-zinc-300 transition-colors">
        My Apps
      </Link>
      <span className="mx-1.5 text-zinc-600" aria-hidden>
        /
      </span>
      <Link href={`/apps/${appId}`} className="hover:text-zinc-300 transition-colors">
        {appName}
      </Link>
      {parentSection ? (
        <>
          <span className="mx-1.5 text-zinc-600" aria-hidden>
            /
          </span>
          <Link
            href={parentSection.href}
            className="hover:text-zinc-300 transition-colors"
          >
            {parentSection.label}
          </Link>
        </>
      ) : null}
      <span className="mx-1.5 text-zinc-600" aria-hidden>
        /
      </span>
      <span className="text-zinc-200 font-medium" aria-current="page">
        {section}
      </span>
    </nav>
  );
}
