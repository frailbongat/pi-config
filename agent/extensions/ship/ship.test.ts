import { describe, expect, it } from "bun:test";
import {
  ensureFastForward,
  isStaleRejection,
  pushWithRetry,
  syncLocalTrunk,
  RebaseConflictError,
} from "./ship-git";
import { resolveDestination, resolveTrunk } from "./ship-destination";
import {
  bulletList,
  formatNotice,
  joinBlocks,
  labelledList,
  outputBlock,
} from "./ship-notice";
import { parseShipArguments } from "./ship-arguments";
import {
  explainNothingToShip,
  listCommittedPaths,
  listUnpushedCommits,
} from "./index";
import { alert, DEFAULT_ALERT } from "./ship-alert";
import { resolveGitHubRepository } from "./ship-repository";
import {
  addClosingIssue,
  addIssueReference,
  forceValidCommitMessage,
  pickFastModel,
  repairCommitMessage,
  shortenSubject,
  stripUnneededBody,
  validateCommitMessage,
} from "./ship-message";
import {
  createCheckLedger,
  expandScripts,
  prepareCache,
  repoWideLabels,
  resolveTool,
  type CheckSpec,
} from "./ship-quality";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function result(stdout: string, code = 0, stderr = "") {
  return {
    stdout,
    stderr,
    code,
    killed: false,
  };
}

/**
 * `rev-parse` answers four different questions in this code, so a test that
 * queues by subcommand alone cannot say which. Keying on the ref makes the
 * repository shape readable instead of positional.
 */
function revParse(refs: Record<string, string>) {
  return (args: string[]) => {
    const ref = args[args.length - 1]!;
    const value = refs[ref];
    return value === undefined ? result("", 1) : result(`${value}\n`);
  };
}

describe("ship repository resolution", () => {
  it("prefers GitHub's canonical repository identity over a renamed origin", async () => {
    const repository = await resolveGitHubRepository(
      async () => result("https://github.com/Project-Lit/litflows-web.git\n"),
      async () => result("Project-Lit/litflows\n"),
    );

    expect(repository).toEqual({
      owner: "Project-Lit",
      repository: "litflows",
    });
  });

  it("falls back to origin when canonical GitHub resolution fails", async () => {
    const repository = await resolveGitHubRepository(
      async () => result("git@github.com:Project-Lit/litflows-web.git\n"),
      async () => result("", 1),
    );

    expect(repository).toEqual({
      owner: "Project-Lit",
      repository: "litflows-web",
    });
  });
});

/**
 * A fake `git` driven by the subcommand, so a test says what the repository
 * looks like rather than which call index returns what.
 */
type Responder =
  | ReturnType<typeof result>[]
  | ((args: string[]) => ReturnType<typeof result>);

function fakeGit(
  responses: Record<string, Responder>,
  calls: string[][] = [],
) {
  return {
    calls,
    git: async (args: string[]) => {
      calls.push(args);
      // `-C <path>` targets another worktree; the subcommand is what matters.
      const rest = args[0] === "-C" ? args.slice(2) : args;
      const responder = responses[rest[0]!];
      if (!responder) return result("", 0);
      if (typeof responder === "function") return responder(rest);
      return responder.length > 1 ? responder.shift()! : responder[0]!;
    },
  };
}

const ranRebase = (calls: string[][]) =>
  calls.some((call) => call[0] === "rebase" && call[1] === "--autostash");

describe("landing fast-forward", () => {
  it("says nothing and rebases nothing when the trunk has not moved", async () => {
    const notices: string[] = [];
    const { git, calls } = fakeGit({
      fetch: [result("")],
      "merge-base": [result("")],
    });

    await ensureFastForward(git, "main", (message) => notices.push(message));

    expect(notices).toEqual([]);
    expect(ranRebase(calls)).toBe(false);
  });

  it("rebases onto a trunk that moved, and names the commit it moved", async () => {
    const notices: string[] = [];
    const { git, calls } = fakeGit({
      fetch: [result("")],
      // Behind first, a descendant once the rebase has replayed HEAD.
      "merge-base": [result("", 1), result("")],
      "rev-parse": [result("deadbee\n")],
      // Incoming from the trunk first, then what is being replayed on top.
      log: [
        result("431b65a perf(convex): resolve auth without Better Auth bundle\n"),
        result("deadbee fix(toast): add upper bound at close arrival\n"),
      ],
      rebase: [result("Successfully rebased and updated refs/heads/main.\n")],
    });

    await ensureFastForward(git, "main", (message) => notices.push(message));

    expect(ranRebase(calls)).toBe(true);
    expect(notices).toHaveLength(1);
    // One sentence and the commits that arrived. The reader's own commits get
    // their own named list, because two `git log --oneline` ranges of the same
    // trunk are the same shape of line in one pile.
    expect(notices[0]).toBe(
      [
        "origin/main has 1 new commit, so your work goes on top of it.",
        "",
        "- 431b65a perf(convex): resolve auth without Better Auth bundle",
        "",
        "Your commits:",
        "",
        "- deadbee fix(toast): add upper bound at close arrival",
      ].join("\n"),
    );
  });

  it("says nothing about local commits when there are none", async () => {
    const notices: string[] = [];
    const { git } = fakeGit({
      fetch: [result("")],
      "merge-base": [result("", 1), result("")],
      "rev-parse": [result("deadbee\n")],
      log: [
        result("431b65a perf(convex): resolve auth without Better Auth bundle\n"),
        result(""),
      ],
      rebase: [result("Successfully rebased and updated refs/heads/main.\n")],
    });

    await ensureFastForward(git, "main", (message) => notices.push(message));

    expect(notices[0]).toBe(
      [
        "origin/main has 1 new commit, so your work goes on top of it.",
        "",
        "- 431b65a perf(convex): resolve auth without Better Auth bundle",
      ].join("\n"),
    );
  });

  it("leaves a content conflict in progress and reports it as one", async () => {
    const { git, calls } = fakeGit({
      fetch: [result("")],
      "merge-base": [result("", 1)],
      "rev-parse": [result("deadbee\n")],
      log: [result("431b65a perf(convex): resolve auth\n")],
      rebase: [
        result("CONFLICT (content): Merge conflict in docs/CONVENTIONS.md\n", 1),
      ],
      "ls-files": [
        result(
          [
            "100644 ba313b1 1\tdocs/CONVENTIONS.md",
            "100644 a53fd85 2\tdocs/CONVENTIONS.md",
            "100644 76e85e0 3\tdocs/CONVENTIONS.md",
            "",
          ].join("\u0000"),
        ),
      ],
    });

    let thrown: unknown;
    try {
      await ensureFastForward(git, "main", () => {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RebaseConflictError);
    const conflict = thrown as RebaseConflictError;
    expect(conflict.kind).toBe("rebase");
    expect(conflict.landOn).toBe("main");
    expect(conflict.paths).toEqual(["docs/CONVENTIONS.md"]);
    expect(conflict.message).toContain("paused mid-conflict");
    // The rebase is the state a resolver needs, so it must not be aborted.
    expect(
      calls.some((call) => call[0] === "rebase" && call[1] === "--abort"),
    ).toBe(false);
  });

  it("reports a conflicted autostash pop as an index conflict", async () => {
    const { git } = fakeGit({
      fetch: [result("")],
      "merge-base": [result("", 1)],
      "rev-parse": [result("deadbee\n")],
      log: [result("431b65a perf(convex): resolve auth\n")],
      // The rebase itself succeeds; the conflict arrives with the stash pop.
      rebase: [result("Successfully rebased and updated refs/heads/main.\n")],
      "ls-files": [
        result(
          [
            "100644 c70fd6f 1\tvite.config.js",
            "100644 0043757 2\tvite.config.js",
            "100644 c9399c9 3\tvite.config.js",
            "",
          ].join("\u0000"),
        ),
      ],
    });

    let thrown: unknown;
    try {
      await ensureFastForward(git, "main", () => {});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RebaseConflictError);
    const conflict = thrown as RebaseConflictError;
    expect(conflict.kind).toBe("index");
    expect(conflict.paths).toEqual(["vite.config.js"]);
    expect(conflict.message).toContain("autostash");
    expect(conflict.manualAdvice).toContain("git add");
  });

  it("still aborts a rebase that failed without a content conflict", async () => {
    const { git, calls } = fakeGit({
      fetch: [result("")],
      "merge-base": [result("", 1)],
      "rev-parse": [result("deadbee\n")],
      log: [result("431b65a perf(convex): resolve auth\n")],
      rebase: [
        result("", 1, "error: cannot rebase: You have unstaged changes.\n"),
        result(""),
      ],
    });

    await expect(
      ensureFastForward(git, "main", () => {}),
    ).rejects.toThrow(/rebasing onto it failed/);
    expect(
      calls.some((call) => call[0] === "rebase" && call[1] === "--abort"),
    ).toBe(true);
  });

  it("refuses when the fetch itself fails, without touching history", async () => {
    const { git, calls } = fakeGit({
      fetch: [result("fatal: could not read from remote repository\n", 128)],
    });

    await expect(ensureFastForward(git, "main", () => {})).rejects.toThrow(
      /Fetching origin\/main failed/,
    );
    expect(ranRebase(calls)).toBe(false);
  });

  it("refuses when a reported-successful rebase still does not descend", async () => {
    const { git } = fakeGit({
      fetch: [result("")],
      "merge-base": [result("", 1)],
      "rev-parse": [result("deadbee\n")],
      log: [result("431b65a perf(convex): resolve auth\n")],
      rebase: [result("")],
    });

    await expect(ensureFastForward(git, "main", () => {})).rejects.toThrow(
      /still does not descend/,
    );
  });
});

describe("ship arguments", () => {
  it("defaults to inferring the destination", () => {
    expect(parseShipArguments("")).toEqual({
      issueNumber: undefined,
      override: undefined,
      recheck: false,
      verbose: false,
      keepOpen: false,
    });
  });

  it("reads a destination and an issue in either order", () => {
    expect(parseShipArguments("main 174")).toEqual({
      issueNumber: "174",
      override: "trunk",
      recheck: false,
      verbose: false,
      keepOpen: false,
    });
    expect(parseShipArguments("174 branch")).toEqual({
      issueNumber: "174",
      override: "branch",
      recheck: false,
      verbose: false,
      keepOpen: false,
    });
  });

  it("takes recheck as a request to run the checks anyway", () => {
    expect(parseShipArguments("main recheck")).toEqual({
      issueNumber: undefined,
      override: "trunk",
      recheck: true,
      verbose: false,
      keepOpen: false,
    });
  });

  it("takes verbose as a request for the step-by-step notices", () => {
    expect(parseShipArguments("verbose")).toEqual({
      issueNumber: undefined,
      override: undefined,
      recheck: false,
      verbose: true,
      keepOpen: false,
    });
    expect(parseShipArguments("main -v").verbose).toBe(true);
  });

  it("takes refs as a request to reference the issue without closing it", () => {
    expect(parseShipArguments("refs 174")).toEqual({
      issueNumber: "174",
      override: undefined,
      recheck: false,
      verbose: false,
      keepOpen: true,
    });
    for (const word of ["ref", "--refs", "open", "keep-open", "no-close", "wip"]) {
      expect(parseShipArguments(`main ${word}`).keepOpen).toBe(true);
    }
  });

  it("rejects arguments it cannot explain", () => {
    expect(() => parseShipArguments("origin/main")).toThrow(/Unrecognized/);
    expect(() => parseShipArguments("main branch")).toThrow(/conflicting/);
    expect(() => parseShipArguments("0")).toThrow(/Usage/);
  });
});

describe("trunk resolution", () => {
  it("reads the trunk from origin/HEAD rather than assuming main", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("origin/master\n")],
    });

    expect(await resolveTrunk(git)).toBe("master");
  });

  it("falls back to a remote branch that exists when origin/HEAD is unset", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("", 1)],
      "rev-parse": revParse({ "refs/remotes/origin/master": "deadbee" }),
    });

    expect(await resolveTrunk(git)).toBe("master");
  });

  it("refuses to guess when the remote names no trunk at all", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("", 1)],
      "rev-parse": revParse({}),
      remote: [result("git@github.com:owner/repo.git\n")],
      "for-each-ref": [result("refs/remotes/origin/feature\n")],
    });

    await expect(resolveTrunk(git)).rejects.toThrow(/git remote set-head/);
  });

  // `git remote set-head origin --auto` fails outright without an origin, so
  // the old catch-all message sent the reader to a command that could not run.
  it("says the remote is missing rather than advising set-head on nothing", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("", 1)],
      "rev-parse": revParse({}),
      remote: [result("", 128)],
    });

    const failure = resolveTrunk(git);
    await expect(failure).rejects.toThrow(/no `origin` remote/);
    await expect(failure).rejects.toThrow(/git remote add origin/);
    await expect(failure).rejects.not.toThrow(/set-head/);
  });

  it("sends an unfetched clone to git fetch, not to set-head", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("", 1)],
      "rev-parse": revParse({}),
      remote: [result("git@github.com:owner/repo.git\n")],
      "for-each-ref": [result("")],
    });

    const failure = resolveTrunk(git);
    await expect(failure).rejects.toThrow(/git fetch origin/);
    await expect(failure).rejects.not.toThrow(/set-head/);
  });

  it("never asks about the remote on the path that succeeds", async () => {
    const { git, calls } = fakeGit({
      "symbolic-ref": [result("origin/main\n")],
    });

    expect(await resolveTrunk(git)).toBe("main");
    expect(calls.some((call) => call[0] === "remote")).toBe(false);
  });
});

describe("destination inference", () => {
  const onTrunk = { "symbolic-ref": [result("origin/main\n"), result("main\n")] };

  it("lands a worktree branch that was never pushed on the trunk", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("origin/main\n"), result("dubai\n")],
      // No upstream, and no origin/dubai.
      "rev-parse": revParse({}),
    });

    expect(await resolveDestination(git)).toEqual({
      kind: "trunk",
      ref: "main",
      reason: "dubai was never pushed, so it is a local worktree branch",
    });
  });

  it("pushes a branch that tracks an upstream, instead of landing it", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("origin/main\n"), result("dubai\n")],
      "rev-parse": revParse({ "@{upstream}": "origin/dubai" }),
    });

    expect(await resolveDestination(git)).toMatchObject({
      kind: "branch",
      branch: "dubai",
      hasUpstream: true,
    });
  });

  it("pushes a branch that exists on origin even with no tracking config", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("origin/main\n"), result("dubai\n")],
      "rev-parse": revParse({ "refs/remotes/origin/dubai": "deadbee" }),
    });

    expect(await resolveDestination(git)).toMatchObject({
      kind: "branch",
      branch: "dubai",
      hasUpstream: false,
    });
  });

  it("lands on the trunk when standing on it", async () => {
    const { git } = fakeGit(onTrunk);

    expect(await resolveDestination(git)).toMatchObject({
      kind: "trunk",
      ref: "main",
    });
  });

  it("lands a detached HEAD on the trunk rather than refusing", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("origin/main\n"), result("", 1)],
    });

    expect(await resolveDestination(git)).toMatchObject({ kind: "trunk" });
  });

  it("honours an explicit override against the inference", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("origin/main\n"), result("dubai\n")],
      "rev-parse": revParse({}),
    });

    expect(await resolveDestination(git, "branch")).toMatchObject({
      kind: "branch",
      branch: "dubai",
    });
  });
});

describe("commits with nothing left in the tree", () => {
  const trunk = { kind: "trunk", ref: "main", reason: "" } as const;

  it("reads the commits the trunk has not got, newest first", async () => {
    const { git, calls } = fakeGit({
      "rev-parse": revParse({ "refs/remotes/origin/main": "deadbee" }),
      log: [
        result(
          "9fed34a fix(toast): clamp the close delay\n431b65a feat(auth): drop the bundle\n",
        ),
      ],
    });

    expect(await listUnpushedCommits(git, trunk)).toEqual({
      lines: [
        "9fed34a fix(toast): clamp the close delay",
        "431b65a feat(auth): drop the bundle",
      ],
      range: ["origin/main..HEAD"],
    });
    expect(calls.at(-1)).toEqual(["log", "--oneline", "origin/main..HEAD"]);
  });

  it("asks what no origin ref holds when the branch was never pushed", async () => {
    const { git, calls } = fakeGit({
      "rev-parse": revParse({}),
      log: [result("9fed34a chore: scratch\n")],
    });

    const work = await listUnpushedCommits(git, {
      kind: "branch",
      branch: "dubai",
      hasUpstream: false,
      reason: "",
    });

    expect(work.range).toEqual(["HEAD", "--not", "--remotes=origin"]);
    expect(calls.at(-1)).toEqual([
      "log",
      "--oneline",
      "HEAD",
      "--not",
      "--remotes=origin",
    ]);
  });

  it("reports nothing rather than a phantom commit when the log fails", async () => {
    const { git } = fakeGit({
      "rev-parse": revParse({ "refs/remotes/origin/main": "deadbee" }),
      log: [result("fatal: bad revision\n", 128)],
    });

    expect((await listUnpushedCommits(git, trunk)).lines).toEqual([]);
  });

  it("names the remote that already has everything, on the trunk", async () => {
    const { git } = fakeGit({});

    expect(await explainNothingToShip(git, trunk)).toBe(
      "Nothing to ship: the working tree is clean and origin/main already has every commit here.",
    );
  });

  it("points a published branch at /ship main when the trunk is missing its work", async () => {
    // The branch is fully pushed, so /ship has nothing to send to it, while
    // main has never seen the two commits on it.
    const { git } = fakeGit({
      "symbolic-ref": [result("origin/main\n")],
      log: [result("9fed34a fix(toast): clamp\n431b65a feat(auth): drop\n")],
    });

    const notice = await explainNothingToShip(git, {
      kind: "branch",
      branch: "dubai",
      hasUpstream: true,
      reason: "",
    });

    expect(notice).toContain("origin/dubai already has every commit here");
    expect(notice).toContain("- 9fed34a fix(toast): clamp");
    expect(notice).toContain(
      "2 commits here are on origin/dubai but not on main. Run `/ship main` to land them on the trunk.",
    );
  });

  it("says only the plain thing when the trunk has the branch's work already", async () => {
    const { git } = fakeGit({
      "symbolic-ref": [result("origin/main\n")],
      log: [result("")],
    });

    expect(
      await explainNothingToShip(git, {
        kind: "branch",
        branch: "dubai",
        hasUpstream: true,
        reason: "",
      }),
    ).toBe(
      "Nothing to ship: the working tree is clean and origin/dubai already has every commit here.",
    );
  });

  it("collects every path the commits touched, once each", async () => {
    // `--format=` leaves a newline between commits and `-z` a NUL between
    // paths, so both separators arrive in one stream.
    const { git } = fakeGit({
      log: [result("\nsrc/a.ts\0src/b.ts\0\nsrc/a.ts\0")],
    });

    expect(await listCommittedPaths(git, ["origin/main..HEAD"])).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("keeps a secret committed and then deleted in the same range", async () => {
    // The endpoint diff hides this file; the per-commit read is what catches
    // it, and it is still on its way to the remote.
    const { git, calls } = fakeGit({
      log: [result(".env.production\0src/a.ts\0")],
    });

    expect(await listCommittedPaths(git, ["origin/main..HEAD"])).toContain(
      ".env.production",
    );
    expect(calls.at(-1)).toEqual([
      "log",
      "--format=",
      "--name-only",
      "-z",
      "--diff-filter=AM",
      "origin/main..HEAD",
    ]);
  });
});

const plan = {
  args: ["origin", "HEAD:main"],
  syncRef: "main",
  label: "The push to origin/main",
};

describe("push retry", () => {
  it("re-syncs and pushes again when a sibling worktree lands first", async () => {
    const notices: string[] = [];
    const { git, calls } = fakeGit({
      "rev-parse": revParse({ "refs/remotes/origin/main": "deadbee" }),
      "merge-base": [result("")],
      push: [
        result("", 1, "! [rejected] main -> main (non-fast-forward)"),
        result("done"),
      ],
    });

    const push = await pushWithRetry(git, plan, (m) => notices.push(m), 1_000);

    expect(push.code).toBe(0);
    expect(calls.filter((call) => call[0] === "push")).toHaveLength(2);
    expect(calls.filter((call) => call[0] === "fetch")).toHaveLength(2);
    expect(notices.some((n) => n.includes("moved again"))).toBe(true);
  });

  it("gives up immediately on a rejection no rebase can fix", async () => {
    const { git, calls } = fakeGit({
      "rev-parse": revParse({ "refs/remotes/origin/main": "deadbee" }),
      "merge-base": [result("")],
      push: [result("", 1, "remote: error: GH006: Protected branch update failed")],
    });

    const push = await pushWithRetry(git, plan, () => {}, 1_000);

    expect(push.code).toBe(1);
    expect(calls.filter((call) => call[0] === "push")).toHaveLength(1);
  });

  it("skips the sync for a branch that has no remote counterpart yet", async () => {
    const { git, calls } = fakeGit({
      "rev-parse": revParse({}),
      push: [result("done")],
    });

    await pushWithRetry(
      git,
      { args: ["--set-upstream", "origin", "dubai"], syncRef: "dubai", label: "x" },
      () => {},
      1_000,
    );

    expect(calls.some((call) => call[0] === "fetch")).toBe(false);
  });

  it("pushes straight away when the caller already fast-forwarded", async () => {
    const { git, calls } = fakeGit({
      "rev-parse": revParse({ "refs/remotes/origin/main": "deadbee" }),
      "merge-base": [result("")],
      push: [result("done")],
    });

    const push = await pushWithRetry(
      git,
      { ...plan, presynced: true },
      () => {},
      1_000,
    );

    expect(push.code).toBe(0);
    expect(calls.some((call) => call[0] === "fetch")).toBe(false);
  });

  it("still re-syncs after an optimistic push loses the race", async () => {
    const { git, calls } = fakeGit({
      "rev-parse": revParse({ "refs/remotes/origin/main": "deadbee" }),
      "merge-base": [result("")],
      push: [
        result("", 1, "! [rejected] main -> main (fetch first)"),
        result("done"),
      ],
    });

    const push = await pushWithRetry(
      git,
      { ...plan, presynced: true },
      () => {},
      1_000,
    );

    expect(push.code).toBe(0);
    expect(calls.filter((call) => call[0] === "fetch")).toHaveLength(1);
  });

  it("classifies rejections", () => {
    expect(isStaleRejection(result("", 1, "Updates were rejected because"))).toBe(true);
    expect(isStaleRejection(result("", 1, "protected branch hook declined"))).toBe(false);
    expect(isStaleRejection(result("", 0))).toBe(false);
  });
});

describe("local trunk sync", () => {
  const refs = {
    "refs/heads/main": "aaaaaaa",
    "refs/remotes/origin/main": "bbbbbbb",
  };

  it("fast-forwards the ref when no worktree has the trunk checked out", async () => {
    const notices: string[] = [];
    const { git, calls } = fakeGit({
      "rev-parse": revParse(refs),
      "merge-base": [result("")],
      worktree: [result("worktree /repo\nbranch refs/heads/dubai\n")],
    });

    await syncLocalTrunk(git, "main", (m) => notices.push(m));

    expect(
      calls.find((call) => call[0] === "update-ref"),
    ).toEqual(["update-ref", "refs/heads/main", "bbbbbbb", "aaaaaaa"]);
    expect(notices[0]).toContain("Fast-forwarded local main");
  });

  it("names the commit that the trunk moved to", async () => {
    const notices: string[] = [];
    const { git } = fakeGit({
      "rev-parse": revParse(refs),
      "merge-base": [result("")],
      worktree: [result("worktree /repo\nbranch refs/heads/main\n")],
      status: [result("")],
      merge: [result("Updating aaaaaaa..bbbbbbb\n")],
      log: [result("Stop the footer from eating clicks\n")],
    });

    await syncLocalTrunk(git, "main", (m) => notices.push(m));

    expect(notices[0]).toBe(
      "Fast-forwarded main to bbbbbbb Stop the footer from eating clicks in /repo.",
    );
  });

  it("falls back to the short hash when the subject cannot be read", async () => {
    const notices: string[] = [];
    const { git } = fakeGit({
      "rev-parse": revParse(refs),
      "merge-base": [result("")],
      worktree: [result("worktree /repo\nbranch refs/heads/dubai\n")],
      log: [result("", 1)],
    });

    await syncLocalTrunk(git, "main", (m) => notices.push(m));

    expect(notices[0]).toBe("Fast-forwarded local main to bbbbbbb.");
  });

  it("fast-forwards a clean checkout in the worktree that holds the trunk", async () => {
    const { git, calls } = fakeGit({
      "rev-parse": revParse(refs),
      "merge-base": [result("")],
      worktree: [result("worktree /repo\nbranch refs/heads/main\n")],
      status: [result("")],
      merge: [result("Updating aaaaaaa..bbbbbbb\n")],
    });

    await syncLocalTrunk(git, "main", () => {});

    expect(calls).toContainEqual(["-C", "/repo", "merge", "--ff-only", "origin/main"]);
  });

  it("never touches a checkout with uncommitted work in it", async () => {
    const notices: string[] = [];
    const { git, calls } = fakeGit({
      "rev-parse": revParse(refs),
      "merge-base": [result("")],
      worktree: [result("worktree /repo\nbranch refs/heads/main\n")],
      status: [result(" M src/app.tsx\n")],
    });

    await syncLocalTrunk(git, "main", (m) => notices.push(m));

    expect(calls.some((call) => call.includes("merge"))).toBe(false);
    expect(notices[0]).toContain("uncommitted changes");
  });

  it("leaves a diverged local trunk alone", async () => {
    const notices: string[] = [];
    const { git, calls } = fakeGit({
      "rev-parse": revParse(refs),
      "merge-base": [result("", 1)],
    });

    await syncLocalTrunk(git, "main", (m) => notices.push(m));

    expect(calls.some((call) => call[0] === "update-ref")).toBe(false);
    expect(notices[0]).toContain("diverged");
  });
});

describe("commit message shape", () => {
  it("drops a body that only restates the diff", () => {
    const message = [
      "refactor(experience): draw the stack as a parts index",
      "",
      "- Move the technology groups out of the activity card",
      "- Replace the floating dashed guide with a datum",
    ].join("\n");

    expect(stripUnneededBody(message)).toBe(
      "refactor(experience): draw the stack as a parts index",
    );
  });

  it("keeps the body a breaking change or a revert has earned", () => {
    const breaking = [
      "feat(api)!: rename /v1/orders to /v1/checkout",
      "",
      "BREAKING CHANGE: clients must migrate before 2026-06-01.",
    ].join("\n");
    const revert = [
      "revert: drop the eager preload on the hero",
      "",
      "It regressed LCP on cold loads behind a slow CDN edge.",
    ].join("\n");

    expect(stripUnneededBody(breaking)).toBe(breaking);
    expect(stripUnneededBody(revert)).toBe(revert);
  });

  it("lifts an issue footer out of a body it is allowed to keep", () => {
    const message = [
      "feat(api)!: rename /v1/orders to /v1/checkout",
      "",
      "BREAKING CHANGE: clients must migrate before 2026-06-01.",
      "",
      "Closes #42",
    ].join("\n");

    expect(stripUnneededBody(message)).toBe(
      [
        "feat(api)!: rename /v1/orders to /v1/checkout (closes #42)",
        "",
        "BREAKING CHANGE: clients must migrate before 2026-06-01.",
      ].join("\n"),
    );
  });

  it("lifts an issue footer into the subject when the body goes", () => {
    const message = [
      "fix(auth): stop refreshing an expired session",
      "",
      "- Guard the refresh call",
      "",
      "Closes #42",
    ].join("\n");

    expect(stripUnneededBody(message)).toBe(
      "fix(auth): stop refreshing an expired session (closes #42)",
    );
  });

  it("appends the caller's issue to the subject, not as a footer", () => {
    const added = addClosingIssue("fix(auth): expire idle sessions", "42");
    expect(added).toEqual({
      ok: true,
      message: "fix(auth): expire idle sessions (closes #42)",
    });
    expect(validateCommitMessage(added.ok ? added.message : "").ok).toBe(true);
  });

  it("keeps the reference on the subject of a message with a body", () => {
    const added = addClosingIssue(
      "feat(api)!: drop /v1/orders\n\nBREAKING CHANGE: migrate to /v1/checkout.",
      "42",
    );
    expect(added).toEqual({
      ok: true,
      message: [
        "feat(api)!: drop /v1/orders (closes #42)",
        "",
        "BREAKING CHANGE: migrate to /v1/checkout.",
      ].join("\n"),
    });
  });

  it("drops words rather than push the reference into a footer", () => {
    // 65 characters, legal on its own; ` (closes #51)` would make it 78.
    const subject =
      "refactor(experience): reach the calendar without a pointer at all";
    expect(validateCommitMessage(subject).ok).toBe(true);

    const added = addClosingIssue(subject, "51");
    expect(added).toEqual({
      ok: true,
      message:
        "refactor(experience): reach the calendar without a pointer (closes #51)",
    });
    expect(validateCommitMessage(added.ok ? added.message : "").ok).toBe(true);
  });

  it("writes refs instead of closes when the issue stays open", () => {
    const added = addIssueReference(
      "fix(auth): expire idle sessions",
      "42",
      "refs",
    );
    expect(added).toEqual({
      ok: true,
      message: "fix(auth): expire idle sessions (refs #42)",
    });
    expect(validateCommitMessage(added.ok ? added.message : "").ok).toBe(true);
  });

  it("keeps a refs reference on the subject of a message with a body", () => {
    const added = addIssueReference(
      "feat(api)!: drop /v1/orders\n\nBREAKING CHANGE: migrate to /v1/checkout.",
      "42",
      "refs",
    );
    expect(added).toEqual({
      ok: true,
      message: [
        "feat(api)!: drop /v1/orders (refs #42)",
        "",
        "BREAKING CHANGE: migrate to /v1/checkout.",
      ].join("\n"),
    });
  });
});

describe("commit message repair", () => {
  it("fixes the slips that are typing rather than judgement", () => {
    const raw = [
      "fix(auth): stop refreshing an expired session.  ",
      "* Guard the refresh call ",
      "* Drop the retry",
    ].join("\n");

    expect(repairCommitMessage(raw)).toBe(
      [
        "fix(auth): stop refreshing an expired session",
        "",
        "- Guard the refresh call",
        "- Drop the retry",
      ].join("\n"),
    );
  });

  it("strips emoji and the space they leave behind", () => {
    expect(repairCommitMessage("feat(ui): 🎉 add the confetti burst")).toBe(
      "feat(ui): add the confetti burst",
    );
  });

  it("wraps an over-long body line under its own bullet", () => {
    const raw = [
      "fix(api): retry a throttled upload",
      "",
      "- The provider answers 429 for a whole minute after a burst, and a single attempt loses the file for good",
    ].join("\n");
    const repaired = repairCommitMessage(raw);

    expect(validateCommitMessage(repaired).ok).toBe(true);
    expect(repaired.split("\n").slice(2)).toEqual([
      "- The provider answers 429 for a whole minute after a burst, and a",
      "  single attempt loses the file for good",
    ]);
  });

  it("leaves a message the rules already accept alone", () => {
    const message = "feat(hero): add the availability badge";
    expect(repairCommitMessage(message)).toBe(message);
  });

  it("promotes the real subject over a preamble the model wrote first", () => {
    const raw = [
      "Here is the commit message:",
      "",
      "feat(hero): add the availability badge",
    ].join("\n");

    expect(repairCommitMessage(raw)).toBe(
      "feat(hero): add the availability badge",
    );
  });

  it("keeps text no line can rescue, so the retry sees what the model wrote", () => {
    const raw = "Updated the hero and the footer";
    expect(repairCommitMessage(raw)).toBe(raw);
  });
});

describe("commit message last resort", () => {
  it("drops whole words off an over-long subject, keeping the prefix", () => {
    const subject =
      "refactor(experience): make every contribution calendar cell a focusable control";
    const shortened = shortenSubject(subject);

    expect(shortened).toBe(
      "refactor(experience): make every contribution calendar cell a focusable",
    );
    expect(subject.startsWith(shortened)).toBe(true);
    expect(validateCommitMessage(shortened).ok).toBe(true);
  });

  it("never cuts a subject that already fits", () => {
    const subject = "fix(auth): expire idle sessions";
    expect(shortenSubject(subject)).toBe(subject);
  });

  it("rescues a message two model attempts could not get right", () => {
    const raw =
      "refactor(experience): make every contribution calendar cell a focusable control";
    expect(validateCommitMessage(raw).ok).toBe(false);

    const forced = forceValidCommitMessage(raw);
    expect(forced.ok).toBe(true);
    expect(forced.ok && forced.message.startsWith("refactor(experience): ")).toBe(
      true,
    );
  });

  it("drops a body no wrap can fit rather than refusing the ship", () => {
    const raw = [
      "fix(build): pin the toolchain",
      "",
      `- see https://example.com/${"a".repeat(90)}`,
    ].join("\n");

    expect(forceValidCommitMessage(raw)).toEqual({
      ok: true,
      message: "fix(build): pin the toolchain",
    });
  });

  it("still refuses when a breaking change's body is the broken part", () => {
    const raw = [
      "feat(api)!: drop /v1/orders",
      "",
      `BREAKING CHANGE: ${"x".repeat(90)}`,
    ].join("\n");

    expect(forceValidCommitMessage(raw).ok).toBe(false);
  });
});

describe("session quality ledger", () => {
  it("resolves a package script to the tool it runs", () => {
    expect(expandScripts("pnpm lint", { lint: "eslint" })).toBe("eslint");
    expect(expandScripts("npm run lint", { lint: "eslint ." })).toBe("eslint .");
    expect(expandScripts("pnpm build", {})).toBe("pnpm build");
  });

  it("counts only repo-wide runs", () => {
    expect(repoWideLabels("eslint")).toEqual(["eslint"]);
    expect(repoWideLabels("./node_modules/.bin/eslint --max-warnings=0")).toEqual([
      "eslint",
    ]);
    expect(repoWideLabels("prettier --check .")).toEqual(["prettier"]);
    expect(repoWideLabels("eslint src/app/page.tsx")).toEqual([]);
    expect(repoWideLabels('prettier --write "src/**/*.ts"')).toEqual([]);
    expect(repoWideLabels("ruff check && ruff format")).toEqual([
      "ruff check",
      "ruff format",
    ]);
  });

  it("remembers clean runs and ignores failed ones", () => {
    const ledger = createCheckLedger();
    ledger.record("eslint", "/tmp/nowhere", false);
    expect(ledger.cleanAt("eslint")).toBeUndefined();

    ledger.record("eslint", "/tmp/nowhere", true);
    expect(typeof ledger.cleanAt("eslint")).toBe("number");
  });

  it("distrusts a zero exit that belongs to a pipeline", () => {
    const ledger = createCheckLedger();
    ledger.record("eslint | tail -5", "/tmp/nowhere", true);
    ledger.record("prettier --check .; echo done", "/tmp/nowhere", true);

    expect(ledger.cleanAt("eslint")).toBeUndefined();
    expect(ledger.cleanAt("prettier")).toBeUndefined();
  });
});

describe("commit message model", () => {
  const catalogue = [
    { id: "claude-3-5-haiku-20241022", provider: "cliproxyapi" },
    { id: "claude-haiku-4-5-20251001", provider: "cliproxyapi" },
    { id: "claude-opus-5", provider: "cliproxyapi" },
    { id: "gpt-5.6-sol", provider: "openai-codex" },
  ];

  it("takes the newest small model of the session's provider", () => {
    expect(pickFastModel(catalogue, "cliproxyapi")?.id).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("falls back to another provider's small model", () => {
    expect(pickFastModel(catalogue, "openai-codex")?.id).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("says so when the catalogue has nothing small", () => {
    expect(pickFastModel([catalogue[2]!], "cliproxyapi")).toBeUndefined();
  });
});

describe("tool resolution", () => {
  const spec = (over: Partial<CheckSpec>): CheckSpec => ({
    label: "ruff check",
    tool: "ruff",
    source: "path",
    exts: ["py"],
    args: ["check"],
    ...over,
  });

  const fakePi = (result: { stdout: string; code: number }) => {
    const calls: { command: string; options: { timeout?: number } }[] = [];
    const pi = {
      exec: async (
        command: string,
        _args: string[],
        options: { timeout?: number },
      ) => {
        calls.push({ command, options });
        return result;
      },
    } as never;
    return { pi, calls };
  };

  // A PATH tool reaches the `which` lookup, which once referenced a constant
  // that was never in scope: every Python, Go, and Rust ship died on a
  // ReferenceError, while prettier and eslint returned before ever reaching it.
  it("looks a PATH tool up without tripping over an undefined timeout", async () => {
    const { pi, calls } = fakePi({ stdout: "/usr/bin/ruff\n", code: 0 });
    expect(await resolveTool(pi, spec({}), "/repo")).toBe("ruff");
    expect(calls[0]?.command).toBe("which");
    expect(calls[0]?.options.timeout).toBeGreaterThan(0);
  });

  it("treats a PATH tool that is not installed as absent", async () => {
    const { pi } = fakePi({ stdout: "", code: 1 });
    expect(await resolveTool(pi, spec({}), "/repo")).toBeUndefined();
  });

  it("never shells out for a local tool, so npx cannot fetch one", async () => {
    const { pi, calls } = fakePi({ stdout: "/usr/bin/prettier\n", code: 0 });
    const local = spec({ label: "prettier", tool: "prettier", source: "local" });
    expect(await resolveTool(pi, local, "/nonexistent-repo")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("resolves a local tool inside the repo's node_modules/.bin", async () => {
    const root = mkdtempSync(join(tmpdir(), "ship-tool-"));
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "prettier"), "");
    const { pi } = fakePi({ stdout: "", code: 1 });
    const local = spec({ label: "prettier", tool: "prettier", source: "local" });
    expect(await resolveTool(pi, local, root)).toBe(join(bin, "prettier"));
  });
});

describe("lint cache file", () => {
  function repo() {
    const root = mkdtempSync(join(tmpdir(), "ship-cache-"));
    writeFileSync(join(root, "package.json"), "{}");
    return root;
  }

  it("keeps a cache the manifests are older than", () => {
    const root = repo();
    const cache = prepareCache("eslint", root, root);
    writeFileSync(cache, "cached");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, "package.json"), old, old);

    expect(prepareCache("eslint", root, root)).toBe(cache);
    expect(existsSync(cache)).toBe(true);
  });

  it("drops a cache an upgraded dependency could have invalidated", () => {
    const root = repo();
    const cache = prepareCache("eslint", root, root);
    writeFileSync(cache, "cached");
    const old = new Date(Date.now() - 60_000);
    utimesSync(cache, old, old);

    prepareCache("eslint", root, root);
    expect(existsSync(cache)).toBe(false);
  });

  it("names the file after the label, without spaces", () => {
    const root = repo();
    expect(prepareCache("ruff check", root, root)).toBe(
      join(root, "ship-ruff-check-cache"),
    );
  });
});

describe("notice formatting", () => {
  it("bullets a list, one blank line off the sentence above it", () => {
    expect(
      formatNotice("origin/main has 2 new commits:", {
        items: "dff61fa first subject\n8a1c0d2 second subject",
      }),
    ).toBe(
      [
        "origin/main has 2 new commits.",
        "",
        "- dff61fa first subject",
        "- 8a1c0d2 second subject",
      ].join("\n"),
    );
  });

  it("names a second list so the two cannot be read as one pile", () => {
    expect(
      formatNotice("origin/main has 1 new commit, so your work goes on top of it", {
        items: "8999110 refactor(hero): add icon",
        sections: [
          { label: "Your commits", items: "40a8a40 refactor(toast): add bound" },
        ],
      }),
    ).toBe(
      [
        "origin/main has 1 new commit, so your work goes on top of it.",
        "",
        "- 8999110 refactor(hero): add icon",
        "",
        "Your commits:",
        "",
        "- 40a8a40 refactor(toast): add bound",
      ].join("\n"),
    );
  });

  it("says so when a named list is empty, rather than dropping it", () => {
    expect(
      labelledList({ label: "Your commits", items: "", empty: "(nothing)" }),
    ).toBe("Your commits:\n\n(nothing)");
    expect(labelledList({ label: "Your commits", items: "" })).toBe("");
  });

  it("elides a list too long to read, and says how much it hid", () => {
    const items = Array.from({ length: 11 }, (_, index) => `commit ${index}`);
    const lines = bulletList(items).split("\n");

    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toBe("- …and 3 more");
  });

  it("truncates an item no terminal line could hold", () => {
    const long = `feat: ${"x".repeat(200)}`;
    const item = bulletList([long]);

    expect(item.length).toBeLessThan(long.length);
    expect(item.endsWith("…")).toBe(true);
  });

  it("fences command output so a renderer keeps its line breaks", () => {
    expect(outputBlock("error: one\n\nerror: two\n")).toBe(
      "```\nerror: one\n\nerror: two\n```",
    );
  });

  // An unclosed fence would swallow whatever prints next.
  it("defuses a fence inside the output it is quoting", () => {
    expect(outputBlock("before\n```\nafter")).toBe(
      "```\nbefore\n'''\nafter\n```",
    );
  });

  it("keeps evidence, then advice, as separate blocks", () => {
    expect(
      formatNotice("eslint failed; changes remain staged", {
        output: "src/app.ts:3:1  error  Unexpected any",
        footer: "Format them yourself, or stage the rest of the file.",
      }),
    ).toBe(
      [
        "eslint failed; changes remain staged.",
        "",
        "```",
        "src/app.ts:3:1  error  Unexpected any",
        "```",
        "",
        "Format them yourself, or stage the rest of the file.",
      ].join("\n"),
    );
  });

  it("drops the blocks that have nothing in them", () => {
    expect(joinBlocks("Shipped 9fed34a.", "", undefined, "fix: thing")).toBe(
      "Shipped 9fed34a.\n\nfix: thing",
    );
    expect(formatNotice("Nothing to ship")).toBe("Nothing to ship.");
  });
});


describe("terminal alert", () => {
  const capture = (env: Record<string, string | undefined>) => {
    const written: string[] = [];
    const { WT_SESSION, KITTY_WINDOW_ID } = process.env;
    Object.assign(process.env, env);
    try {
      alert(DEFAULT_ALERT, (text) => written.push(text));
    } finally {
      process.env.WT_SESSION = WT_SESSION;
      process.env.KITTY_WINDOW_ID = KITTY_WINDOW_ID;
    }
    return written.join("");
  };

  it("speaks OSC 777 in the terminals that understand it", () => {
    expect(capture({ WT_SESSION: undefined, KITTY_WINDOW_ID: undefined })).toBe(
      "\x1b]777;notify;Pi;Ready for input\x07",
    );
  });

  it("speaks OSC 99 to Kitty, which understands nothing else", () => {
    const written = capture({ WT_SESSION: undefined, KITTY_WINDOW_ID: "1" });
    expect(written).toContain("\x1b]99;i=1:d=0;Pi\x1b\\");
    expect(written).toContain("\x1b]99;i=1:p=body;Ready for input\x1b\\");
  });

  it("says what pi itself says, so a ship reads like any other turn", () => {
    expect(DEFAULT_ALERT).toEqual({ title: "Pi", body: "Ready for input" });
  });
});
