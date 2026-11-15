//! Safety checks shared by the test harness and its unit test.
import fs from "node:fs";
import path from "node:path";

/** True only for this run's exact staged executable, not another test stage. */
export function ownsStagedExecutable(command, staged, platform = process.platform) {
  if (!command || !staged) return false;
  if (platform === "win32")
    return (
      path.win32.normalize(command).toLowerCase() === path.win32.normalize(staged).toLowerCase()
    );
  const executable = path.posix.normalize(staged);
  return command === executable || command.startsWith(`${executable} `);
}

/** Find other Node test harnesses; never include the caller itself. */
export function otherTestHarnesses(processes, ownPid) {
  return processes.filter(
    ({ pid, command }) =>
      pid !== ownPid && /(?:^|[\\/\s])test-all\.mjs(?=$|[\s"'])/i.test(command ?? ""),
  );
}

/** Hide only a test-profile link while a suite exercises a complete backup. */
export function suspendTestProfileEngineLink(profile) {
  const link = path.join(profile, "latex");
  let entry;
  try {
    entry = fs.lstatSync(link);
  } catch (error) {
    if (error.code === "ENOENT") return () => {};
    throw error;
  }
  if (!entry.isSymbolicLink()) return () => {};

  // Keep the junction on the same volume, outside the profile being archived.
  const holding = fs.mkdtempSync(path.join(path.dirname(profile), ".mdraft-test-engine-"));
  const saved = path.join(holding, "latex");
  try {
    fs.renameSync(link, saved);
  } catch (error) {
    fs.rmdirSync(holding);
    throw error;
  }
  let restored = false;
  return () => {
    if (restored) return;
    try {
      fs.lstatSync(link);
      throw new Error(`Cannot restore the test engine link; it is preserved at ${saved}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.renameSync(saved, link);
    restored = true;
    fs.rmdirSync(holding);
  };
}
