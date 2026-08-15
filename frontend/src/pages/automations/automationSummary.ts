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

/** "monitored anime movies and series in /media/anime tagged keep" */
export function describeScope(scope: RuleParams["scope"]): string {
  const s = scope ?? {};
  const qualifiers: string[] = [];
  if (s.monitored_only ?? true) qualifiers.push("monitored");
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
  if (r.resolution_min != null) clauses.push(`${r.resolution_min}p or better`);
  const codecs = r.video_codec_any ?? [];
  if (codecs.length > 0) clauses.push(`${joinList(codecs)} video`);
  const qualities = r.quality_any ?? [];
  if (qualities.length > 0) clauses.push(`quality ${joinList(qualities)}`);
  return clauses.length === 0 ? null : joinList(clauses);
}

function describeAction(action: RuleAction): string | null {
  switch (action.type) {
    case "search_missing":
      return "search for the missing file";
    case "search_upgrade":
      return "search for an upgrade";
    case "tag":
      return action.label ? `tag it “${action.label}”` : "tag it";
    case "set_monitored":
      if (action.when === "conforming") {
        return action.value ? "monitor it once it conforms" : "unmonitor it once it conforms";
      }
      return action.value ? "monitor it" : "unmonitor it";
    default:
      return null;
  }
}

/** "search for an upgrade and tag it “needs-upgrade”" */
export function describeActions(actions: RuleAction[] | undefined): string {
  const phrases = (actions ?? []).map(describeAction).filter((p): p is string => p !== null);
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

  const clauses: string[] = [];
  if (onNonConforming.length > 0) {
    const target = requirements ? `anything that isn't ${requirements}` : "anything missing a file";
    clauses.push(`for ${target}, ${describeActions(onNonConforming)}`);
  }
  if (onConforming.length > 0) clauses.push(describeActions(onConforming));

  if (clauses.length === 0) return `${lead}.`;
  return `${lead} — ${joinList(clauses)}.`;
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
