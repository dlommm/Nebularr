import { NavLink, Outlet, useLocation } from "react-router-dom";
import { PageHead } from "@/components/ns/Page";
import { PATHS, pathTitle } from "../routes/paths";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { to: PATHS.integrations, label: "Integrations", hint: "Sonarr, Radarr, MyAnimeList, sign-in, alerts" },
  { to: PATHS.artwork, label: "Artwork", hint: "Posters and fanart, cache" },
  { to: PATHS.schedules, label: "Schedules", hint: "When jobs run, retention" },
  { to: PATHS.logs, label: "Logs", hint: "Live application log" },
];

/** The Setup section: one page head and a side menu around the four
    configuration screens. */
export function SetupShell(): JSX.Element {
  const location = useLocation();
  return (
    <div className="pb-16">
      <PageHead title="Setup" lead={`${pathTitle(location.pathname)} — how Nebularr connects, what it keeps, and when it runs.`} />
      <div className="flex flex-wrap items-start gap-x-12 gap-y-6">
        <nav aria-label="Setup sections" className="flex w-full flex-row flex-wrap gap-x-6 md:w-52 md:flex-col">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.to}
              to={section.to}
              className={({ isActive }) =>
                cn(
                  "group flex min-h-11 items-center gap-3 text-[15px] md:border-t md:border-border md:py-2",
                  isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span aria-hidden className={cn("hidden size-2 shrink-0 md:block", isActive ? "bg-foreground" : "bg-transparent")} />
                  <span className="min-w-0">
                    <span className="block">{section.label}</span>
                    <span className="hidden text-xs text-subtle-foreground md:block">{section.hint}</span>
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-[999_1_640px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
