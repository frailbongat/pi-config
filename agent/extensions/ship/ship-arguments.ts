/**
 * Argument parsing, kept away from the extension host so the tests can import
 * it without loading a model provider.
 */
import type { ShipOverride } from "./ship-destination";

export interface ShipArguments {
  readonly issueNumber?: string;
  readonly override?: ShipOverride;
  /** Run the formatters and linters even if the agent already ran them clean. */
  readonly recheck?: boolean;
  /** Print the step-by-step progress notices instead of just the commit. */
  readonly verbose?: boolean;
  /**
   * Reference the issue without closing it, as `(refs #42)` rather than
   * `(closes #42)`. For the change that moves a ticket forward but does not
   * finish it.
   */
  readonly keepOpen?: boolean;
}

const TRUNK_WORDS = new Set(["main", "trunk", "master"]);
const BRANCH_WORDS = new Set(["branch", "here"]);
const RECHECK_WORDS = new Set(["recheck", "check", "checks"]);
const VERBOSE_WORDS = new Set(["verbose", "-v", "--verbose", "loud"]);
const KEEP_OPEN_WORDS = new Set([
  "refs",
  "ref",
  "--refs",
  "open",
  "keep-open",
  "keepopen",
  "no-close",
  "noclose",
  "wip",
]);

/**
 * Tokens in any order, because there is no reason to remember an order for two
 * of them. `/ship`, `/ship 174`, `/ship main`, `/ship main 174` all parse.
 *
 * `main` is a keyword meaning "the trunk", not a branch name. On a repository
 * whose trunk is `master`, `/ship main` still lands on `master`, because the
 * destination is resolved from `origin/HEAD` either way.
 *
 * `refs` is the same kind of keyword for the issue: it keeps the reference and
 * drops the closing verb, so `/ship refs` on a session that mentions an issue
 * writes `(refs #42)` and leaves the ticket open.
 */
export function parseShipArguments(
  raw: string,
  command = "/ship",
): ShipArguments {
  const usage = `Usage: ${command} [main|branch] [recheck] [verbose] [refs] [issue-number] (example: ${command} main refs 174)`;
  let issueNumber: string | undefined;
  let override: ShipOverride | undefined;
  let recheck = false;
  let verbose = false;
  let keepOpen = false;

  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const word = token.toLowerCase();

    if (/^\d+$/.test(word)) {
      if (issueNumber) throw new Error(`Two issue numbers given. ${usage}`);
      if (!/^[1-9]\d*$/.test(word) || !Number.isSafeInteger(Number(word))) {
        throw new Error(usage);
      }
      issueNumber = word;
      continue;
    }

    if (RECHECK_WORDS.has(word)) {
      recheck = true;
      continue;
    }

    if (VERBOSE_WORDS.has(word)) {
      verbose = true;
      continue;
    }

    if (KEEP_OPEN_WORDS.has(word)) {
      keepOpen = true;
      continue;
    }

    const parsed = TRUNK_WORDS.has(word)
      ? "trunk"
      : BRANCH_WORDS.has(word)
        ? "branch"
        : undefined;
    if (!parsed) throw new Error(`Unrecognized argument "${token}". ${usage}`);
    if (override && override !== parsed) {
      throw new Error(`Two conflicting destinations given. ${usage}`);
    }
    override = parsed;
  }

  return { issueNumber, override, recheck, verbose, keepOpen };
}

/** Kept for callers that only ever passed an issue number. */
export function parseIssueNumberArgument(
  raw: string,
  command = "/ship",
): string | undefined {
  return parseShipArguments(raw, command).issueNumber;
}
