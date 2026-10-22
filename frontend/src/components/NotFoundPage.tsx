import { Link } from "react-router-dom";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";
import { PageHead } from "@/components/ns/Page";
import { actionLinkClass } from "@/lib/ns";

export function NotFoundPage(): JSX.Element {
  usePageTitle("Not found");
  return (
    <div className="pb-16">
      <PageHead title="Not here" lead="This address isn’t part of Nebularr. It may have moved in the redesign." />
      <Link to={PATHS.home} className={actionLinkClass}>
        Back to the overview
      </Link>
    </div>
  );
}
