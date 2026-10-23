import { NavLink, Outlet, useLocation } from "react-router-dom";
import { PageHead } from "@/components/ns/Page";
import { PATHS, pathTitle } from "../routes/paths";
import { cn } from "@/lib/utils";
import { useReadinessSteps } from "../hooks/useReadinessSteps";
import { INTEGRATION_SECTIONS, sectionAnchor } from "../pages/integrations/sections";

const SECTIONS = [
  {
    to: PATHS.integrations,
    label: "Integrations",
    hint: "Connections, sign-in, alerts",
    lead: "How Nebularr reaches Sonarr, Radarr and MyAnimeList, who can sign in, and where alerts go.",
  },
  {
    to: PATHS.artwork,
    label: "Artwork",
    hint: "Posters and fanart, cache",
    lead: "Where posters and fanart come from and how much of them Nebularr keeps on disk.",
  },
  {
    to: PATHS.schedules,
    label: "Schedules",
    hint: "When jobs run, retention",
    lead: "When each job runs, and how long run history is kept.",
  },
  { to: PATHS.logs, label: "Logs", hint: "Live application log", lead: "The live application log from this instance." },
];

/** The Setup section: one page head and a side menu around the four
    configuration screens. */
export function SetupShell(): JSX.Element {
  const location = useLocation();
  const { steps, loading } = useReadinessSteps();
  const done = steps.filter((step) => step.done).length;
  return (
    <div className="pb-16">
      <PageHead
        title="Setup"
        lead={SECTIONS.find((section) => section.to === location.pathname)?.lead ?? pathTitle(location.pathname)}
        aside={
          loading ? null : (
            <p className="text-base text-muted-foreground">
              <span className={cn("cond text-[40px] leading-none font-[640]", done === steps.length ? "text-ok" : "text-foreground")}>
                {done} of {steps.length}
              </span>{" "}
              readiness checks done
            </p>
          )
        }
      />
      <div className="flex flex-wrap items-start gap-x-12 gap-y-6">
        <nav aria-label="Setup sections" className="flex w-full flex-row flex-wrap gap-x-6 md:w-52 md:flex-col">
          {SECTIONS.map((section) => (
            <div key={section.to} className="contents md:block">
            <NavLink
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
            {section.to === PATHS.integrations && location.pathname === PATHS.integrations ? (
              <ul className="hidden pb-2 pl-5 md:block">
                {INTEGRATION_SECTIONS.map((sub) => (
                  <li key={sub.title}>
                    <a
                      href={`#${sectionAnchor(sub.title)}`}
                      className="flex min-h-9 items-center text-[13px] text-muted-foreground hover:text-foreground"
                    >
                      {sub.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            </div>
          ))}
        </nav>
        <div className="min-w-0 flex-[999_1_640px]">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
