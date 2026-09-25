#!/usr/bin/env node
// Creates a new random API key for a client, or hashes one you pass in.
// Give the key to the client; put only the hash in the server's environment.
import { createHash, randomBytes } from "node:crypto";

const key = process.argv[2] ?? `mcp_${randomBytes(24).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
console.log(`key:    ${key}`);
console.log(`sha256: ${hash}`);
