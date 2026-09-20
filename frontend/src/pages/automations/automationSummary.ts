import type { RuleAction, RuleParams } from "../../types";

/**
 * Plain-English renderings of an automation rule.
 *
 * The rule model is genuinely hard to hold in your head — "items in scope that
 * fail EVERY requirement receive the actions" — so the editor leads with a
 * sentence instead of asking you to reassemble it from twenty controls. These
 * are pure functions so the phrasing is unit-testable without rendering.
 *
 * Honesty rule: never describe something the rule does not do. Where a shape is
 * outside what we can phrase safely (an exotic cron, an unknown action), fall
 * back to the raw value rather than guessing.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ALIASES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "05:00" from minute/hour fields, or null when either is not a plain number. */
function clockTime(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${pad(h)}:${pad(m)}`;
}

function dayName(field: string): string | null {
  if (/^\d$/.test(field)) return DAY_NAMES[Number(field) % 7] ?? null;
  return DAY_NAMES[DAY_ALIASES[field.toLowerCase()] ?? -1] ?? null;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * Human phrasing for a 5-field crontab expression, e.g. "every Saturday at
 * 05:00". Anything outside the common shapes returns the raw expression, which
 * is honest rather than wrong.
 */
export function describeCron(cron: string): string {
  const raw = (cron ?? "").trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [minute, hour, dom, month, dow] = parts;
  const at = clockTime(minute, hour);

  if (month === "*" && dom === "*" && dow === "*") {
    if (at) return `every day at ${at}`;
    const everyNMinutes = /^\*\/(\d+)$/.exec(minute);
    if (everyNMinutes && hour === "*") {
      const n = Number(everyNMinutes[1]);
      return n === 1 ? "every minute" : `every ${n} minutes`;
    }
    const everyNHours = /^\*\/(\d+)$/.exec(hour);
    if (everyNHours && /^\d{1,2}$/.test(minute)) {
      const n = Number(everyNHours[1]);
      return n === 1 ? "every hour" : `every ${n} hours`;
    }
    return raw;
  }

  if (month === "*" && dow === "*" && at) {
    const everyNDays = /^\*\/(\d+)$/.exec(dom);
    if (everyNDays) {
      const n = Number(everyNDays[1]);
      return n === 1 ? `every day at ${at}` : `every ${n} days at ${at}`;
    }
    if (/^\d{1,2}$/.test(dom)) return `monthly on the ${ordinal(Number(dom))} at ${at}`;
  }

  if (month === "*" && dom === "*" && at) {
    const days = dow.split(",").map(dayName);
    if (days.every((day): day is string => day !== null) && days.length > 0) {
      if (days.length === 1) return `every ${days[0]} at ${at}`;
      return `every ${joinList(days)} at ${at}`;
    }
  }

  return raw;
}

/** "a, b and c" — Oxford-free, matching the app's existing copy voice. */
function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function mediaNoun(media: string | undefined): string {
  if (media === "movies") return "movies";
  if (media === "series") return "series";
  return "movies and series";
}

const STATUS_WORDS: Record<string, string> = {
  ended: "ended",
  continuing: "still-running",
  upcoming: "upcoming",
  deleted: "deleted",
};

/** "monitored ended anime series under /media/anime tagged keep" */
export function describeScope(scope: RuleParams["scope"]): string {
  const s = scope ?? {};
  const qualifiers: string[] = [];
  if (s.monitored_only ?? true) qualifiers.push("monitored");
  const statuses = (s.series_status_any ?? []).map((st) => STATUS_WORDS[st]).filter(Boolean);
  if (statuses.length > 0) qualifiers.push(joinList(statuses));
  if (s.anime_only) qualifiers.push("anime");

  let phrase = `${qualifiers.join(" ")} ${mediaNoun(s.media)}`.trim();

  const genres = s.genres_any ?? [];
  if (genres.length > 0) phrase += ` in ${joinList(genres)}`;

  const folders = s.root_folders_any ?? [];
  if (folders.length > 0) phrase += ` under ${joinList(folders)}`;

  const tags = s.tags_any ?? [];
  if (tags.length > 0) phrase += ` tagged ${joinList(tags)}`;

  return phrase;
}

/**
 * What an item needs in order to count as conforming, e.g. "English audio at
 * 1080p or better". Returns null when the rule sets no requirements at all.
 */
export function describeRequirements(require: RuleParams["require"]): string | null {
  const r = require ?? {};
  const clauses: string[] = [];
  const langs = r.audio_language_any ?? [];
  if (langs.length > 0) clauses.push(`${joinList(langs)} audio`);
  const subs = r.subtitle_language_any ?? [];
  if (subs.length > 0) clauses.push(`${joinList(subs)} subtitles`);
  if (r.resolution_min != null) clauses.push(`${r.resolution_min}p or better`);
  const codecs = r.video_codec_any ?? [];
  if (codecs.length > 0) clauses.push(`${joinList(codecs)} video`);
  const qualities = r.quality_any ?? [];
  if (qualities.length > 0) clauses.push(`quality ${joinList(qualities)}`);
  return clauses.length === 0 ? null : joinList(clauses);
}

/**
 * `subject` is what the action lands on. For a series rule that is the show, not
 * the episode the fault was found on — saying "it" there would describe an
 * episode-level action the backend never performs.
 */
function describeAction(action: RuleAction, subject: string): string | null {
  switch (action.type) {
    case "search_missing":
      return "search for the missing file";
    case "search_upgrade":
      return "search for an upgrade";
    case "tag":
      return action.label ? `tag ${subject} “${action.label}”` : `tag ${subject}`;
    case "set_monitored":
      // The "once it conforms" qualifier is dropped here: the sentence that folds
      // these in already opens with the conforming condition, so repeating it read
      // as two separate conditions.
      return action.value ? `monitor ${subject}` : `unmonitor ${subject}`;
    default:
      return null;
  }
}

/** "search for an upgrade and tag it “needs-upgrade”" */
export function describeActions(
  actions: RuleAction[] | undefined,
  subject = "it",
): string {
  const phrases = (actions ?? [])
    .map((action) => describeAction(action, subject))
    .filter((p): p is string => p !== null);
  return phrases.length === 0 ? "do nothing" : joinList(phrases);
}

/**
 * The whole rule as one sentence, e.g.
 * "Every Saturday at 05:00, look at monitored movies — for anything that isn't
 * 1080p or better, search for an upgrade."
 */
export function summarizeAutomation(input: {
  cron?: string;
  params?: RuleParams;
}): string {
  const params = input.params ?? {};
  const schedule = describeCron(input.cron ?? "");
  const scope = describeScope(params.scope);
  const requirements = describeRequirements(params.require);

  // Conforming-state actions read backwards if folded into the "anything that
  // isn't…" clause — they fire on items that DO meet the bar — so they get
  // their own clause.
  const actions = params.actions ?? [];
  const onNonConforming = actions.filter((a) => (a.when ?? "non_conforming") === "non_conforming");
  const onConforming = actions.filter((a) => a.when === "conforming");

  const lead = schedule ? `${sentenceCase(schedule)}, look at ${scope}` : `Looks at ${scope}`;

  // A series action always lands on the show, because the conformance question is
  // asked of every aired episode and answered about the series.
  const isSeries = (params.scope?.media ?? "both") === "series";
  const subject = isSeries ? "the show" : "it";

  const clauses: string[] = [];
  if (onNonConforming.length > 0) {
    const target = requirements
      ? `anything that isn't ${requirements}`
      : isSeries
        ? "any show missing an episode"
        : "anything missing a file";
    clauses.push(`for ${target}, ${describeActions(onNonConforming, subject)}`);
  }
  if (onConforming.length > 0) {
    // Stated as the completeness condition it actually compiles to, not as "once
    // it conforms" — for a series that is an every-aired-episode claim, and the
    // whole point of the rule is that it is not a per-episode one.
    const condition = requirements
      ? isSeries
        ? `where every aired episode is ${requirements}`
        : `where the file is already ${requirements}`
      : isSeries
        ? "where no aired episode is missing"
        : "where the file is already there";
    clauses.push(`${condition}, ${describeActions(onConforming, subject)}`);
  }

  if (clauses.length === 0) return `${lead}.`;
  // Semicolon, not "and": the two clauses describe opposite sets, and "…search for
  // an upgrade and where the file is already 1080p…" reads as one run-on condition.
  return `${lead} — ${clauses.join("; ")}.`;
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/** "Up to 10 searches per run, at most once every 7 days per item." */
export function describeLimits(input: {
  params?: RuleParams;
  budget_per_run?: number;
  cooldown_days?: number;
}): string | null {
  const actions = input.params?.actions ?? [];
  // Budget and cooldown only govern searches; saying otherwise on a tag-only
  // rule would be a false claim (the backend never cools those down).
  if (!actions.some((a) => a.type.startsWith("search_"))) return null;
  const budget = input.budget_per_run ?? 10;
  const cooldown = input.cooldown_days ?? 7;
  return `Up to ${budget} search${budget === 1 ? "" : "es"} per run, at most once every ${cooldown} day${cooldown === 1 ? "" : "s"} per item.`;
}

/**
 * Human labels for the reason codes a run records in
 * `details.instances[*][*].failure_reasons`. An unrecognised code is returned
 * as-is rather than guessed at, so a reason added server-side shows up honestly
 * in an older UI instead of being dropped or mislabelled.
 */
const REASON_LABELS: Record<string, string> = {
  no_file: "missing a file",
  audio_language: "wrong audio language",
  subtitle_language: "missing the required subtitles",
  resolution: "below the resolution floor",
  video_codec: "wrong video codec",
  quality: "wrong quality",
  unknown: "unexplained",
};

export function describeFailureReason(code: string): string {
  return REASON_LABELS[code] ?? code;
}

/**
 * "42 missing a file, 18 below the resolution floor and 6 wrong audio language"
 * — the per-reason counts as one line. Returns null for an empty set so callers
 * can omit the row entirely rather than render an empty label.
 */
export function describeFailureReasons(
  reasons: Record<string, number> | undefined,
): string | null {
  const entries = Object.entries(reasons ?? {});
  if (entries.length === 0) return null;
  // Already sorted by count server-side; sorted again here so the line does not
  // depend on JSON key order surviving the round trip.
  return joinList(
    entries
      .slice()
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([code, count]) => `${count} ${describeFailureReason(code)}`),
  );
}
