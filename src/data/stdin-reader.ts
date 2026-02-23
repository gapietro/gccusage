import * as v from "valibot";
import { StatusJsonSchema, type StatusJson } from "../types/status-json.js";

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      process.stdin.destroy();
      resolve("");
    }, 1000);

    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    process.stdin.resume();
  });
}

export function parseStatusJson(raw: string): StatusJson | null {
  if (!raw.trim()) return null;
  try {
    const data = JSON.parse(raw);
    return v.parse(StatusJsonSchema, data);
  } catch {
    return null;
  }
}
