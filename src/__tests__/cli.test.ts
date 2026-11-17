import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shellQuote, buildStatusLineCommand, runCli } from "../cli.js";
import { noPasswd } from "./helpers/no-passwd.js";

describe("shellQuote", () => {
  it("wraps plain paths in single quotes", () => {
    expect(shellQuote("/usr/local/bin/node")).toBe("'/usr/local/bin/node'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/Users/o'brien/dist/index.js")).toBe(
      "'/Users/o'\\''brien/dist/index.js'",
    );
  });
});

describe("buildStatusLineCommand", () => {
  it("quotes both the node executable and the script path", () => {
    const cmd = buildStatusLineCommand(
      "/usr/local/bin/node",
      "/Users/dev/Developer Projects/gccusage/dist/index.js",
    );
    expect(cmd).toBe(
      "'/usr/local/bin/node' '/Users/dev/Developer Projects/gccusage/dist/index.js'",
    );
  });
});

// Scoped narrowly: `failTurnsRmSync` defaults to false, so every fs call in
// this file — and every fs call inside cli.ts / writeFileAtomic reached
// through runCli — passes through to the real implementation for every test
// except the one that flips the flag on around its own runCli call. Declared
// via vi.hoisted because vi.mock factories cannot close over an ordinary
// top-level variable (it would run before the variable is initialised).
const mockFs = vi.hoisted(() => ({ failTurnsRmSync: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
      if (mockFs.failTurnsRmSync && String(target).endsWith("turns")) {
        const err = new Error("EACCES: permission denied, rmdir") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actual.rmSync(target, options);
    },
  };
});

// Same narrow shape as mockFs: null passes userInfo() through untouched. Set,
// it stands in for the passwd entry, so a test of the HOME-empty fallback
// resolves into its own temp dir instead of the developer's real home.
// Layered over helpers/no-passwd.ts, whose `noPasswd.on` removes the passwd
// entry altogether.
const mockOs = vi.hoisted(() => ({ passwdHome: null as string | null }));

vi.mock("node:os", async (importOriginal) => {
  const base = await (await import("./helpers/no-passwd.js")).mockOsModule(importOriginal);
  return {
    ...base,
    userInfo: ((...args: Parameters<typeof base.userInfo>) => {
      const info = base.userInfo(...args);
      return mockOs.passwdHome === null ? info : { ...info, homedir: mockOs.passwdHome };
    }) as typeof base.userInfo,
  };
});

// `gccusage today` prices straight from the table, so an unpriced model was
// dropped from both the total and the by-model list with nothing said (#82).
vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => ({
    "claude-priced-test": {
      inputCostPerToken: 1 / 1_000_000,
      outputCostPerToken: 0,
      cacheCreationCostPerToken: 0,
      cacheReadCostPerToken: 0,
    },
  })),
  // `refresh-pricing` must never reach the network from a test.
  refreshPricing: vi.fn(async () => false),
}));

describe("gccusage today", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalXdg: string | undefined;
  let lines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  function writeEntry(
    model: string,
    inputTokens: number,
    outputTokens = 0,
    cacheCreationTokens = 0,
    cacheReadTokens = 0,
  ): void {
    const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.appendFileSync(
      path.join(projectDir, `${model}.jsonl`),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId: model,
        message: {
          model,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cacheReadTokens,
          },
        },
      }) + "\n",
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cli-"));
    originalHome = process.env["HOME"];
    originalXdg = process.env["XDG_CACHE_HOME"];
    process.env["HOME"] = tmpDir;
    process.env["XDG_CACHE_HOME"] = tmpDir;
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = originalXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("names the models it could not price", async () => {
    writeEntry("claude-priced-test", 1_000_000);
    writeEntry("claude-unpriced-test", 1_000_000);

    await runCli(["today"]);

    const report = lines.join("\n");
    expect(report).toContain("claude-unpriced-test");
    expect(report).toMatch(/no pricing/i);
  });

  it("says nothing about pricing when every model priced", async () => {
    writeEntry("claude-priced-test", 1_000_000);

    await runCli(["today"]);

    expect(lines.join("\n")).not.toMatch(/no pricing/i);
  });

  // #103: distinct from the unpriced case above. Two turns on purpose — one
  // under the 200k threshold (10k in / 5k out, standard rate), one over it
  // (250k in / 1k out / 100k cache-creation / 50k cache-read, premium rate
  // the mocked table doesn't publish). The over-threshold turn carries cache
  // tokens deliberately (issue found in whole-branch review): "Total Tokens"
  // and the "By Model" line sum input+output only (15.0k + 251.0k = 266.0k),
  // while the billed premium-band figure sums all four counts on the
  // over-threshold request (250k+1k+100k+50k = 401.0k) — a VISIBLY different
  // number in the same report. A naive implementation that reported the
  // model's whole token count, or one that summed the same scope as "Total
  // Tokens", would not produce 401.0k here.
  it("marks the total approximate and reports the premium-band tokens, not the session total", async () => {
    writeEntry("claude-priced-test", 10_000, 5_000);
    writeEntry("claude-priced-test", 250_000, 1_000, 100_000, 50_000);

    await runCli(["today"]);

    const report = lines.join("\n");

    // 1. (approximate), not (partial) — nothing here is unpriced.
    expect(report).toContain("(approximate)");
    expect(report).not.toContain("(partial)");

    // 2. Names the model, states the standard-rate costing and that the real
    // total is higher — and does NOT reuse the unpriced sentence, which would
    // be false: this model's usage IS in the total.
    expect(report).toContain("claude-priced-test");
    expect(report).toMatch(/costed at the standard rate/);
    expect(report).toMatch(/real total is higher/);
    expect(report).not.toMatch(/their usage is missing from the total/);

    // 3. The premium-band total (401.0k: input+output+cacheCreation+cacheRead
    // on the over-threshold request), not the session's input+output token
    // count for the model (266.0k, which legitimately appears elsewhere in
    // the report — in "Total Tokens" and the "By Model" line — so the check
    // must be scoped to the approximated sentence itself, not the report as
    // a whole).
    const approximatedLine = lines.find((l) => l.includes("billed"));
    expect(approximatedLine, `no approximated sentence found:\n${report}`).toBeDefined();
    expect(approximatedLine).toContain("401.0k");
    expect(approximatedLine).not.toContain("266.0k");

    // The threshold is a fixed constant, rendered as a plain literal, not run
    // through formatTokens (which would print "200.0k").
    expect(approximatedLine).toContain("200k threshold");

    // 4. The sentence names the figure's scope, so a reader is not left to
    // guess why "billed" is bigger than "Total Tokens" three lines up.
    expect(approximatedLine).toContain("(prompt, cache and completion)");

    // 5. "Total Tokens" itself is unaffected by the cache tokens (it sums
    // input+output only), confirming the two figures really do diverge.
    expect(report).toContain("Total Tokens: 266.0k");
  });
});

describe("gccusage setup", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalXdg: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const settingsPath = (): string => path.join(tmpDir, ".claude", "settings.json");
  const backupPath = (): string => `${settingsPath()}.bak`;
  const read = (p: string): string => fs.readFileSync(p, "utf8");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-setup-"));
    originalHome = process.env["HOME"];
    originalXdg = process.env["XDG_CACHE_HOME"];
    process.env["HOME"] = tmpDir;
    process.env["XDG_CACHE_HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = originalXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds statusLine without disturbing unrelated keys", async () => {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] } }),
    );

    await runCli(["setup"]);

    const after = JSON.parse(read(settingsPath()));
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash"] });
    expect(after.statusLine.type).toBe("command");
    expect(after.statusLine.command).toContain("index.js");
  });

  it("writes a backup holding the exact pre-setup bytes", async () => {
    const before = '{\n  "model": "opus"\n}\n';
    fs.writeFileSync(settingsPath(), before);

    await runCli(["setup"]);

    expect(read(backupPath())).toBe(before);
  });

  it("writes settings.json as indented JSON with a trailing newline", async () => {
    await runCli(["setup"]);

    const raw = read(settingsPath());
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "statusLine"');
  });

  it("creates settings.json when none exists, and takes no backup", async () => {
    await runCli(["setup"]);

    expect(JSON.parse(read(settingsPath())).statusLine.type).toBe("command");
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  // #88: each of these previously exited 0 having written nothing (null,
  // scalar) or having silently dropped statusLine (array).
  it.each([
    ["a null document", "null", "not a JSON object"],
    ["a bare string", '"oops"', "not a JSON object"],
    ["an array root", "[]", "not a JSON object"],
    ["malformed JSON", "{oops", "not valid JSON"],
  ])("refuses %s and changes nothing", async (_label, contents, expectedMessage) => {
    fs.writeFileSync(settingsPath(), contents);

    await expect(runCli(["setup"])).rejects.toThrow(expectedMessage);

    expect(read(settingsPath())).toBe(contents);
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it("names the offending file and how to recover", async () => {
    fs.writeFileSync(settingsPath(), "null");

    await expect(runCli(["setup"])).rejects.toThrow(settingsPath());
    await expect(runCli(["setup"])).rejects.toThrow("re-run `gccusage setup`");
  });

  // SEC-004's class, in setup: `os.homedir()` returns "" for HOME="", and
  // `resolve("", ".claude", "settings.json")` is relative to the cwd — so
  // setup wrote a settings.json into whatever directory it was run from.
  it("writes under the passwd home, not the working directory, when HOME is empty", async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-setup-cwd-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
    process.env["HOME"] = "";
    mockOs.passwdHome = tmpDir;
    try {
      await runCli(["setup"]);
    } finally {
      mockOs.passwdHome = null;
      cwdSpy.mockRestore();
    }

    try {
      expect(fs.existsSync(path.join(cwdDir, ".claude", "settings.json"))).toBe(false);
      expect(JSON.parse(read(settingsPath())).statusLine.type).toBe("command");
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  // SEC-004, review of #154. With no passwd entry either, getHomeDir() used to
  // fall back to os.tmpdir(), so setup wrote `<tmpdir>/.claude/settings.json`
  // — on Linux, into the shared /tmp. It must refuse before writing anything.
  it.each([
    ["HOME is empty", ""],
    ["HOME is unset", undefined],
  ])("refuses with a clear error, writing nothing, when %s and there is no passwd entry", async (_label, home) => {
    const sharedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-setup-tmp-"));
    const originalTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = sharedTmp;
    if (home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = home;
    noPasswd.on = true;
    try {
      await expect(runCli(["setup"])).rejects.toThrow("cannot determine home directory");
      expect(fs.readdirSync(sharedTmp)).toEqual([]);
    } finally {
      noPasswd.on = false;
      if (originalTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = originalTmpdir;
      fs.rmSync(sharedTmp, { recursive: true, force: true });
    }
  });

  it("narrows an existing install's cache modes (SEC-003)", async () => {
    // XDG_CACHE_HOME is tmpDir in this block, so the cache is tmpDir/gccusage.
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(path.join(cacheDir, "daily"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "daily", "abc.json"), "{}");
    fs.chmodSync(cacheDir, 0o755);
    fs.chmodSync(path.join(cacheDir, "daily", "abc.json"), 0o644);

    await runCli(["setup"]);

    expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(cacheDir, "daily", "abc.json")).mode & 0o777).toBe(0o600);
  });

  it("removes the orphaned turn store left by the pre-#129 tracker", async () => {
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(path.join(cacheDir, "turns"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "turns", "abc.json"),
      '{"sessionId":"abc","count":7,"updatedAt":0}',
    );
    fs.writeFileSync(
      path.join(cacheDir, "turn-count.json"),
      '{"sessionId":"abc","count":7,"updatedAt":0}',
    );

    await runCli(["setup"]);

    expect(fs.existsSync(path.join(cacheDir, "turns"))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, "turn-count.json"))).toBe(false);
  });

  // SEC-003. settings.json often carries `env` secrets (API keys, tokens).
  // setup rewrote it through the atomic writer, whose temp file took the
  // umask default: a 0600 file came back 0644, and the .bak was 0644 too.
  describe("file modes and symlinks (SEC-003)", () => {
    const mode = (p: string): number => fs.statSync(p).mode & 0o777;

    it("preserves an existing settings.json's 0600 mode", async () => {
      fs.writeFileSync(settingsPath(), '{"env":{"ANTHROPIC_API_KEY":"sk-test"}}\n');
      fs.chmodSync(settingsPath(), 0o600);

      await runCli(["setup"]);

      expect(mode(settingsPath())).toBe(0o600);
    });

    it("preserves a mode wider than 0600 rather than narrowing the user's choice", async () => {
      fs.writeFileSync(settingsPath(), "{}\n");
      fs.chmodSync(settingsPath(), 0o640);

      await runCli(["setup"]);

      expect(mode(settingsPath())).toBe(0o640);
    });

    it("drops group and other write bits instead of re-emitting a world-writable file", async () => {
      // Preserving is applied with an explicit chmod, which bypasses the
      // umask — so a 0666 file would otherwise come back 0666, and setup
      // would re-certify a file anyone can rewrite (review of #154).
      fs.writeFileSync(settingsPath(), "{}\n");
      fs.chmodSync(settingsPath(), 0o666);

      await runCli(["setup"]);

      expect(mode(settingsPath())).toBe(0o644);
    });

    it("creates a new settings.json as 0600", async () => {
      await runCli(["setup"]);

      expect(mode(settingsPath())).toBe(0o600);
    });

    it("writes the backup as 0600 even when settings.json is 0644", async () => {
      // The backup holds the same secrets as the original; it gets the
      // narrow mode regardless, and a stale wider .bak is replaced.
      fs.writeFileSync(settingsPath(), '{"env":{"ANTHROPIC_API_KEY":"sk-test"}}\n');
      fs.chmodSync(settingsPath(), 0o644);
      fs.writeFileSync(backupPath(), "stale");
      fs.chmodSync(backupPath(), 0o644);

      await runCli(["setup"]);

      expect(mode(backupPath())).toBe(0o600);
    });

    it("writes through a symlinked settings.json, leaving the link in place", async () => {
      // A dotfiles manager links ~/.claude/settings.json into a repo. Renaming
      // a temp file over the link replaced it with a regular file, silently
      // detaching the user's managed copy.
      const dotfiles = path.join(tmpDir, "dotfiles");
      fs.mkdirSync(dotfiles);
      const target = path.join(dotfiles, "claude-settings.json");
      fs.writeFileSync(target, '{\n  "model": "opus"\n}\n');
      fs.chmodSync(target, 0o600);
      fs.symlinkSync(target, settingsPath());

      await runCli(["setup"]);

      expect(fs.lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(settingsPath())).toBe(target);
      const after = JSON.parse(read(target));
      expect(after.model).toBe("opus");
      expect(after.statusLine.type).toBe("command");
      expect(mode(target)).toBe(0o600);
      // The backup stays beside the path the user knows, not in their
      // dotfiles repo, and no temp file is left behind in either place.
      expect(read(backupPath())).toBe('{\n  "model": "opus"\n}\n');
      expect(fs.readdirSync(dotfiles)).toEqual(["claude-settings.json"]);
    });

    it("names the file it actually wrote when a symlink redirected it", async () => {
      const dotfiles = path.join(tmpDir, "dotfiles");
      fs.mkdirSync(dotfiles);
      const target = path.join(dotfiles, "claude-settings.json");
      fs.writeFileSync(target, "{}\n");
      fs.symlinkSync(target, settingsPath());

      await runCli(["setup"]);

      const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      // realpath: on macOS the temp dir is itself under a symlink (/var).
      expect(logged).toContain(`Settings: ${settingsPath()} -> ${fs.realpathSync(target)}`);
    });

    it("prints the plain path when nothing redirected the write", async () => {
      await runCli(["setup"]);

      const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain(`Settings: ${settingsPath()}\n`);
    });

    it("does not treat a symlinked ancestor as a redirect when settings.json is a regular file", async () => {
      // realpath differs from the logical path whenever ANY ancestor is a
      // link — macOS /var, Fedora Atomic /home -> /var/home, FreeBSD
      // /home -> /usr/home, a linked ~/.claude. Only a link at settings.json
      // itself is a redirect. Built explicitly so it holds on Linux CI too.
      const realHome = path.join(tmpDir, "real-home");
      const linkHome = path.join(tmpDir, "link-home");
      fs.mkdirSync(path.join(realHome, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(realHome, ".claude", "settings.json"), "{}\n");
      fs.symlinkSync(realHome, linkHome);
      process.env["HOME"] = linkHome;
      const logical = path.join(linkHome, ".claude", "settings.json");

      await runCli(["setup"]);

      const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain(`Settings: ${logical}\n`);
      expect(logged).not.toContain("->");
      expect(JSON.parse(read(logical)).statusLine.type).toBe("command");
    });

    it("refuses a symlink into a read-only directory before writing anything", async () => {
      // The nix home-manager shape: settings.json links into a read-only
      // store. Writing through it failed with a bare EACCES on the temp file —
      // after the .bak had already been written (review of #154).
      const store = path.join(tmpDir, "store");
      fs.mkdirSync(store);
      const target = path.join(store, "settings.json");
      fs.writeFileSync(target, '{"model":"opus"}\n');
      fs.chmodSync(target, 0o444);
      fs.chmodSync(store, 0o555);
      fs.symlinkSync(target, settingsPath());
      try {
        await expect(runCli(["setup"])).rejects.toThrow(/is a symlink to .*settings\.json/);
        await expect(runCli(["setup"])).rejects.toThrow("Add the statusLine entry there yourself");

        expect(fs.existsSync(backupPath())).toBe(false);
        expect(fs.lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
        expect(read(target)).toBe('{"model":"opus"}\n');
      } finally {
        // Or the afterEach rmSync cannot empty the directory.
        fs.chmodSync(store, 0o755);
      }
    });

    it("resolves a dangling relative link against the real directory, not lexically", async () => {
      // ~/.claude is itself a link into dotfiles, and settings.json is a
      // dangling `../shared/settings.json`. The kernel resolves `..` from the
      // link's REAL directory (dotfiles/claude), so the file it names is
      // dotfiles/shared/settings.json. Lexical resolution from ~/.claude
      // wrote ~/shared/settings.json and left the link dangling (review of
      // #154).
      fs.rmSync(path.join(tmpDir, ".claude"), { recursive: true });
      const claudeDir = path.join(tmpDir, "dotfiles", "claude");
      const shared = path.join(tmpDir, "dotfiles", "shared");
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.mkdirSync(shared);
      fs.symlinkSync(claudeDir, path.join(tmpDir, ".claude"));
      fs.symlinkSync(path.join("..", "shared", "settings.json"), path.join(claudeDir, "settings.json"));

      await runCli(["setup"]);

      expect(JSON.parse(read(path.join(shared, "settings.json"))).statusLine.type).toBe("command");
      expect(fs.lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(settingsPath()), "the link now resolves").toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "shared"))).toBe(false);
    });

    it("refuses a dangling link into a directory that does not exist", async () => {
      // An unmounted volume. Following the link created a shadow directory
      // chain where the volume should be (review of #154).
      const missing = path.join(tmpDir, "Volumes", "dotfiles", "claude", "settings.json");
      fs.symlinkSync(missing, settingsPath());

      await expect(runCli(["setup"])).rejects.toThrow(/does not exist/);

      expect(fs.existsSync(path.join(tmpDir, "Volumes"))).toBe(false);
      expect(fs.lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(backupPath())).toBe(false);
    });

    it("refuses a symlink loop instead of replacing one of its links", async () => {
      const other = path.join(tmpDir, ".claude", "b.json");
      fs.symlinkSync(other, settingsPath());
      fs.symlinkSync(settingsPath(), other);

      await expect(runCli(["setup"])).rejects.toThrow(/symlink loop/);

      expect(fs.lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(other).isSymbolicLink()).toBe(true);
    });

    it("writes through a dangling symlink, creating its target", async () => {
      const dotfiles = path.join(tmpDir, "dotfiles");
      fs.mkdirSync(dotfiles);
      const target = path.join(dotfiles, "claude-settings.json");
      fs.symlinkSync(target, settingsPath());

      await runCli(["setup"]);

      expect(fs.lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
      expect(JSON.parse(read(target)).statusLine.type).toBe("command");
      expect(mode(target)).toBe(0o600);
    });
  });

  it("completes setup even when the turn store cannot be deleted", async () => {
    // Flips on the mocked rmSync (top of file) so it throws EACCES for the
    // "turns" target — the case `{ force: true }` does NOT swallow. A cleanup
    // failure must not cost the user the thing they ran the command for: the
    // settings file still gets written.
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(path.join(cacheDir, "turns"), { recursive: true });

    mockFs.failTurnsRmSync = true;
    try {
      await expect(runCli(["setup"])).resolves.toBeUndefined();
    } finally {
      mockFs.failTurnsRmSync = false;
    }

    expect(JSON.parse(read(settingsPath())).statusLine.type).toBe("command");
  });
});

describe("gccusage refresh-pricing", () => {
  let tmpDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-refresh-cmd-"));
    originalXdg = process.env["XDG_CACHE_HOME"];
    process.env["XDG_CACHE_HOME"] = tmpDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
    else process.env["XDG_CACHE_HOME"] = originalXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // REL-008: the sweep is only as good as its caller. Deleting the call would
  // leave every sweepStaleTempFiles unit test green and orphans accumulating.
  it("sweeps orphaned temp files out of the cache directory", async () => {
    const orphan = path.join(tmpDir, "gccusage", "daily", "abc.json.4242.0.tmp");
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, "");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(orphan, old, old);

    await runCli(["refresh-pricing"]);

    expect(fs.existsSync(orphan)).toBe(false);
  });

  // SEC-003, review of #154: likewise for narrowing a pre-SEC-003 cache.
  it("narrows an existing install's cache modes", async () => {
    const shard = path.join(tmpDir, "gccusage", "daily", "abc.json");
    fs.mkdirSync(path.dirname(shard), { recursive: true });
    fs.writeFileSync(shard, "{}");
    fs.chmodSync(path.join(tmpDir, "gccusage"), 0o755);
    fs.chmodSync(path.dirname(shard), 0o755);
    fs.chmodSync(shard, 0o644);

    await runCli(["refresh-pricing"]);

    expect(fs.statSync(path.join(tmpDir, "gccusage")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(shard)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(shard).mode & 0o777).toBe(0o600);
  });
});
