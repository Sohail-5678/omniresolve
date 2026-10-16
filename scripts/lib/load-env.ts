/**
 * Loads .env.local then .env for CLI scripts (Next.js does this itself for the app).
 * Existing environment variables always win, so CI and Vercel settings are never overridden.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      const hash = value.indexOf(" #");
      if (hash >= 0 && !value.startsWith('"')) value = value.slice(0, hash).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
