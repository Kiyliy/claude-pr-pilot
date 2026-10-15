/**
 * Version info — reads version from package.json and the UTC+8 commit time of that version.
 */

import { execSync } from "child_process";
import { join } from "path";
import pkg from "../package.json";

export const VERSION: string = pkg.version;

function getVersionCommitDate(): string {
  try {
    const raw = execSync("git log -1 --format=%ci -- package.json", {
      encoding: "utf-8",
      cwd: join(__dirname, ".."),
    }).trim();
    if (!raw) return "未知";
    const d = new Date(raw);
    if (isNaN(d.getTime())) return "未知";
    // Convert to UTC+8
    const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
    return utc8.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  } catch {
    return "未知";
  }
}

export const VERSION_DATE: string = getVersionCommitDate();
