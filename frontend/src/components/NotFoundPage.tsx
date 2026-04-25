import { Link } from "react-router-dom";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";

export function NotFoundPage(): JSX.Element {
  usePageTitle("Not found");
  return (
    <div className="card span-12">
      <h2>Page not found</h2>
      <p className="muted">This path is not part of the Nebularr control plane.</p>
      <p>
        <Link to={PATHS.home}>Go to home</Link>
      </p>
    </div>
  );
}
