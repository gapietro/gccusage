/**
 * A `node:os` stand-in for a container with no passwd entry (SEC-004, review
 * of #154), shared so the four files that need it do not each copy it.
 *
 * Off by default, so every call passes through. With `noPasswd.on`:
 * - `userInfo()` throws ENOENT, as libuv's uv_os_get_passwd does;
 * - `homedir()` returns "" for HOME set-but-empty (what Node does, passwd or
 *   not), and throws for HOME unset, where Node falls back to passwd.
 *
 * Usage, in the test file:
 *   vi.mock("node:os", async (importOriginal) =>
 *     (await import("./helpers/no-passwd.js")).mockOsModule(importOriginal));
 *   import { noPasswd } from "./helpers/no-passwd.js";
 */
export const noPasswd = { on: false };

function throwNoPasswd(): never {
  const err = new Error("ENOENT: no such file or directory, uv_os_get_passwd") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  throw err;
}

export async function mockOsModule(
  importOriginal: <T>() => Promise<T>,
): Promise<typeof import("node:os")> {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: ((...args: Parameters<typeof actual.userInfo>) =>
      noPasswd.on ? throwNoPasswd() : actual.userInfo(...args)) as typeof actual.userInfo,
    homedir: () => {
      if (noPasswd.on && process.env["HOME"] === undefined) return throwNoPasswd();
      if (noPasswd.on && process.env["HOME"] === "") return "";
      return actual.homedir();
    },
  };
}
