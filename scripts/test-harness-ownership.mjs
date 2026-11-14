//! Process ownership checks shared by the test harness and its unit test.
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
