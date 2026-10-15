import fs from "fs";
import path from "path";
import { ROOT_DIR } from "../config";

const MARKER_PATH = path.join(ROOT_DIR, "update-restart-marker.json");

export interface UpdateMarker {
  chatId: string;
  threadId: number;
  startedAt: number;
  repoFullName: string;
}

/** Write marker before pm2 restart so startup can detect a post-update boot. */
export function writeUpdateMarker(marker: UpdateMarker): void {
  try {
    fs.writeFileSync(MARKER_PATH, JSON.stringify(marker), "utf-8");
  } catch { /* ignore */ }
}

/**
 * Read and atomically delete the marker file.
 * Returns the marker if it existed, null otherwise.
 */
export function readAndDeleteUpdateMarker(): UpdateMarker | null {
  try {
    if (!fs.existsSync(MARKER_PATH)) return null;
    const marker = JSON.parse(fs.readFileSync(MARKER_PATH, "utf-8")) as UpdateMarker;
    fs.unlinkSync(MARKER_PATH);
    return marker;
  } catch {
    try { fs.unlinkSync(MARKER_PATH); } catch { /* ignore */ }
    return null;
  }
}

/** Delete the marker file without reading it. */
export function deleteUpdateMarker(): void {
  try { fs.unlinkSync(MARKER_PATH); } catch { /* ignore */ }
}
