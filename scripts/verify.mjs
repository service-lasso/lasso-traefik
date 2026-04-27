import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageTraefik } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: false,
      ...options,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

async function reserveLoopbackPort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForOk(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

const platform = process.env.TARGET_PLATFORM ?? process.platform;
const artifact = await packageTraefik(platform);
const verifyRoot = path.join(repoRoot, "output", "verify", platform);
const extractRoot = path.join(verifyRoot, "extract");
const runtimeRoot = path.join(extractRoot, "runtime");
const binary = platform === "win32" ? "traefik.exe" : "traefik";
const binaryPath = path.join(extractRoot, binary);
const adminPort = await reserveLoopbackPort();
const webPort = await reserveLoopbackPort();
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));

if (
  serviceManifest.healthcheck?.type !== "http" ||
  serviceManifest.healthcheck.url !== "http://127.0.0.1:${ADMIN_PORT}/ping" ||
  serviceManifest.healthcheck.expected_status !== 200
) {
  throw new Error(`Traefik service.json must declare HTTP /ping readiness: ${JSON.stringify(serviceManifest.healthcheck)}`);
}

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
await mkdir(runtimeRoot, { recursive: true });
await run("tar", ["-xf", artifact, "-C", extractRoot]);
const packageMetadata = JSON.parse(
  await readFile(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"), "utf8"),
);
if (
  packageMetadata.serviceId !== "@traefik" ||
  packageMetadata.upstream?.repo !== "traefik/traefik" ||
  packageMetadata.packagedBy !== "service-lasso/lasso-traefik" ||
  packageMetadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}
await run(binaryPath, ["version"]);

await writeFile(
  path.join(runtimeRoot, "dynamic.yml"),
  "http:\n  routers: {}\n  services: {}\n",
  "utf8",
);
await writeFile(
  path.join(runtimeRoot, "traefik.yml"),
  [
    "entryPoints:",
    "  web:",
    `    address: \"127.0.0.1:${webPort}\"`,
    "  traefik:",
    `    address: \"127.0.0.1:${adminPort}\"`,
    "api:",
    "  dashboard: true",
    "ping:",
    "  entryPoint: traefik",
    "providers:",
    "  file:",
    "    filename: \"./runtime/dynamic.yml\"",
    "    watch: true",
    "log:",
    "  level: INFO",
    "",
  ].join("\n"),
  "utf8",
);

const traefik = spawn(binaryPath, ["--configFile=runtime/traefik.yml"], {
  cwd: extractRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
traefik.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
traefik.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForOk(`http://127.0.0.1:${adminPort}/ping`);
  console.log("[lasso-traefik] verification passed");
} catch (error) {
  console.error("[lasso-traefik] stdout:");
  console.error(stdout);
  console.error("[lasso-traefik] stderr:");
  console.error(stderr);
  throw error;
} finally {
  await stopProcess(traefik);
}
