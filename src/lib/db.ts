import { promises as fs } from "fs";
import path from "path";
import type { DB } from "./types";

const DB_PATH = path.join(process.cwd(), "data", "db.json");

export async function readDB(): Promise<DB> {
  const raw = await fs.readFile(DB_PATH, "utf8");
  return JSON.parse(raw) as DB;
}

export async function writeDB(db: DB) {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

export function cuidish(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
