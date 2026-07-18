import { useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useActionError } from "../../hooks/useActionError";
import { queryKeys } from "../../lib/queryKeys";
import type { LoggingConfigResponse } from "../../types";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SectionCard, SELECT_CLASS } from "./shared";

export function LoggingSection({ loggingConfig }: { loggingConfig: UseQueryResult<LoggingConfigResponse> }): JSX.Element {
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const [loggingLevelChoice, setLoggingLevelChoice] = useState<string>("INFO");
  const [loggingUseEnvDefault, setLoggingUseEnvDefault] = useState(false);

  useEffect(() => {
    if (!loggingConfig.data) return;
    setLoggingLevelChoice(loggingConfig.data.effective_level);
  }, [loggingConfig.data]);

  const saveLoggingConfig = async (): Promise<void> => {
    await runAction(
      async () => {
        if (loggingUseEnvDefault) {
          await api.saveLoggingConfig({ use_environment_default: true });
        } else {
          await api.saveLoggingConfig({ level: loggingLevelChoice });
        }
        setLoggingUseEnvDefault(false);
        await queryClient.invalidateQueries({ queryKey: queryKeys.loggingConfig });
      },
      "save logging level",
    );
  };

  return (
    <SectionCard title="Application logging">
      {loggingConfig.isError ? (
        <QueryErrorNotice label="logging settings" retry={() => void loggingConfig.refetch()} error={loggingConfig.error} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">effective: {loggingConfig.data?.effective_level ?? "…"}</Badge>
        <span className="text-xs text-muted-foreground">
          {loggingConfig.data?.stored_level
            ? "Level stored in database (overrides LOG_LEVEL at startup and when changed here)."
            : `No database override; using process LOG_LEVEL (${loggingConfig.data?.environment_default ?? "…"}) until you save a level below.`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Log level"
          className={SELECT_CLASS}
          value={loggingLevelChoice}
          disabled={loggingUseEnvDefault}
          onChange={(event) => setLoggingLevelChoice(event.target.value)}
        >
          {(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const).map((lvl) => (
            <option key={lvl} value={lvl}>
              {lvl}
            </option>
          ))}
        </select>
        <Button type="button" variant="secondary" size="sm" onClick={() => void saveLoggingConfig()}>
          Apply log level
        </Button>
        <div className="flex items-center gap-2">
          <Checkbox
            id="logging-env-default"
            checked={loggingUseEnvDefault}
            onCheckedChange={(checked) => setLoggingUseEnvDefault(checked === true)}
          />
          <Label htmlFor="logging-env-default" className="text-sm text-muted-foreground">
            on save, clear database override and use LOG_LEVEL from the environment
          </Label>
        </div>
      </div>
    </SectionCard>
  );
}
