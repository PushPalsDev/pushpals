#!/usr/bin/env node
import { cpSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcSchemas = join(__dirname, "../src/schemas");
const distSchemas = join(__dirname, "../dist/schemas");

try {
  mkdirSync(distSchemas, { recursive: true });
  cpSync(srcSchemas, distSchemas, { recursive: true });
  console.log("Copied schema files to dist/schemas");
} catch (err) {
  console.error("Failed to copy schemas:", err);
  process.exit(1);
}
