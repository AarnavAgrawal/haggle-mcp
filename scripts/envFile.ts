// Set KEY=value lines in the local .env without printing the values.
// Used by the setup scripts so secrets go straight to disk, never to a terminal
// or a chat transcript.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ENV_PATH = new URL("../.env", import.meta.url);

export function setEnvVars(vars: Record<string, string>): void {
  let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}${line}\n`;
  }
  writeFileSync(ENV_PATH, text);
}
