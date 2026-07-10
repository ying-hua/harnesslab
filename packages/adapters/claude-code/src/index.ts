import fs from "node:fs";
import { parseSessionJsonl } from "./parse.js";
import type { UnifiedSession } from "@harnesslab/core";

export { parseSessionJsonl } from "./parse.js";
export {
  claudeProjectsDir,
  sanitizeCwdForProjectDir,
  listSessionFiles,
  findSessionFile,
  type SessionFileInfo,
} from "./locate.js";

export function parseSessionFile(filePath: string): UnifiedSession {
  return parseSessionJsonl(fs.readFileSync(filePath, "utf8"));
}
