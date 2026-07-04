import { Link } from "react-router-dom";
import { PATHS } from "../routes/paths";
import { usePageTitle } from "../hooks/usePageTitle";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function NotFoundPage(): JSX.Element {
  usePageTitle("Not found");
  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>Page not found</CardTitle>
        <CardDescription>This path is not part of the Nebularr control plane.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="secondary" render={<Link to={PATHS.home} />}>
          Go to home
        </Button>
      </CardContent>
    </GlassCard>
  );
}
