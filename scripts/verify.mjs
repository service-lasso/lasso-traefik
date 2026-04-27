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

function parseCommandlineArgs(commandline) {
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of commandline.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote === "\"") {
      escaping = true;
      continue;
    }

    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error(`Unclosed quote in commandline: ${commandline}`);
  }

  if (current) {
    args.push(current);
  }

  return args;
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
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const expectedPorts = {
  web: 19080,
  websecure: 19443,
  admin: 19081,
  https_traefik: 19082,
  https_nginx: 19090,
  https_cms: 19100,
  https_flow: 19110,
  https_flowtms: 19120,
  https_api: 19130,
  https_files: 19140,
  https_bpmn: 19150,
  mongo: 19160,
  typedb: 19170,
};
const expectedPortmapping = {
  HTTP: "${WEB_PORT}",
  HTTPS: "${WEBSECURE_PORT}",
  HTTPS_TRAEFIK: "${HTTPS_TRAEFIK_PORT}",
  HTTPS_NGINX: "${HTTPS_NGINX_PORT}",
  HTTPS_CMS: "${HTTPS_CMS_PORT}",
  HTTPS_FLOW: "${HTTPS_FLOW_PORT}",
  HTTPS_FLOWTMS: "${HTTPS_FLOWTMS_PORT}",
  HTTPS_API: "${HTTPS_API_PORT}",
  HTTPS_FILES: "${HTTPS_FILES_PORT}",
  HTTPS_BPMN: "${HTTPS_BPMN_PORT}",
  TCP_MOGNO: "${MONGO_PORT}",
  TCP_TYPEDB: "${TYPEDB_PORT}",
};
const resolvedPorts = Object.fromEntries(
  await Promise.all(Object.keys(expectedPorts).map(async (name) => [name, await reserveLoopbackPort()])),
);
const adminPort = resolvedPorts.admin;

if (
  serviceManifest.healthcheck?.type !== "http" ||
  serviceManifest.healthcheck.url !== "http://127.0.0.1:${ADMIN_PORT}/ping" ||
  serviceManifest.healthcheck.expected_status !== 200
) {
  throw new Error(`Traefik service.json must declare HTTP /ping readiness: ${JSON.stringify(serviceManifest.healthcheck)}`);
}

if (JSON.stringify(serviceManifest.depend_on) !== JSON.stringify(["localcert", "nginx"])) {
  throw new Error(`Traefik service.json dependencies drifted: ${JSON.stringify(serviceManifest.depend_on)}`);
}

const expectedEnv = {
  TRAEFIK_HTTP_PORT: "${WEB_PORT}",
  TRAEFIK_HTTPS_PORT: "${WEBSECURE_PORT}",
  TRAEFIK_INTERNAL_PORT: "${ADMIN_PORT}",
  TRAEFIK_HTTPS_TRAEFIK_PORT: "${HTTPS_TRAEFIK_PORT}",
  TRAEFIK_HTTPS_NGINX_PORT: "${HTTPS_NGINX_PORT}",
  TRAEFIK_HTTPS_CMS_PORT: "${HTTPS_CMS_PORT}",
  TRAEFIK_HTTPS_FLOW_PORT: "${HTTPS_FLOW_PORT}",
  TRAEFIK_HTTPS_FLOWTMS_PORT: "${HTTPS_FLOWTMS_PORT}",
  TRAEFIK_HTTPS_API_PORT: "${HTTPS_API_PORT}",
  TRAEFIK_HTTPS_FILES_PORT: "${HTTPS_FILES_PORT}",
  TRAEFIK_HTTPS_BPMN_PORT: "${HTTPS_BPMN_PORT}",
  TRAEFIK_MONGO_PORT: "${MONGO_PORT}",
  TRAEFIK_TYPEDB_PORT: "${TYPEDB_PORT}",
  TRAEFIK_WEB_URL: "http://127.0.0.1:${WEB_PORT}/",
  TRAEFIK_WEBSECURE_URL: "https://127.0.0.1:${WEBSECURE_PORT}/",
  TRAEFIK_DASHBOARD_URL: "http://127.0.0.1:${ADMIN_PORT}/dashboard/",
  TRAEFIK_PING_URL: "http://127.0.0.1:${ADMIN_PORT}/ping",
};
const expectedGlobalEnv = {
  ...expectedEnv,
  TRAEFIK_TRAEFIK_URL: "http://127.0.0.1:${ADMIN_PORT}/dashboard/",
  TRAEFIK_HOST_DOMAIN: "localhost",
  TRAEFIK_HOST_DOMAIN_URL: "localhost",
  TRAEFIK_HOST_DOMAIN_SUFFIX: "localhost",
};

if (JSON.stringify(serviceManifest.ports) !== JSON.stringify(expectedPorts)) {
  throw new Error(`Traefik service.json ports drifted: ${JSON.stringify(serviceManifest.ports)}`);
}

if (JSON.stringify(serviceManifest.portmapping) !== JSON.stringify(expectedPortmapping)) {
  throw new Error(`Traefik service.json portmapping drifted: ${JSON.stringify(serviceManifest.portmapping)}`);
}

if (JSON.stringify(serviceManifest.env) !== JSON.stringify(expectedEnv)) {
  throw new Error(`Traefik service.json env drifted: ${JSON.stringify(serviceManifest.env)}`);
}

if (JSON.stringify(serviceManifest.globalenv) !== JSON.stringify(expectedGlobalEnv)) {
  throw new Error(`Traefik service.json globalenv drifted: ${JSON.stringify(serviceManifest.globalenv)}`);
}

const commandline = serviceManifest.commandline?.[platform] ?? serviceManifest.commandline?.default;
if (!commandline || typeof commandline !== "string") {
  throw new Error(`Traefik service.json must declare a ${platform}/default commandline.`);
}

for (const requiredFlag of [
  "--providers.file.filename=",
  "--api.insecure=true",
  "--api.dashboard=true",
  "--entryPoints.web.address=",
  "--entryPoints.websecure.address=",
  "--entryPoints.traefik.address=",
  "--entryPoints.mongo.address=",
  "--entryPoints.typedb.address=",
  "--ping=true",
  "--ping.entryPoint=traefik",
  "--serversTransport.insecureSkipVerify=true",
]) {
  if (!commandline.includes(requiredFlag)) {
    throw new Error(`Traefik commandline is missing ${requiredFlag}: ${commandline}`);
  }
}

for (const selector of [
  "${WEBSECURE_PORT}",
  "${HTTPS_TRAEFIK_PORT}",
  "${HTTPS_NGINX_PORT}",
  "${HTTPS_CMS_PORT}",
  "${HTTPS_FLOW_PORT}",
  "${HTTPS_FLOWTMS_PORT}",
  "${HTTPS_API_PORT}",
  "${HTTPS_FILES_PORT}",
  "${HTTPS_BPMN_PORT}",
  "${MONGO_PORT}",
  "${TYPEDB_PORT}",
]) {
  if (!serviceManifest.config?.files?.[0]?.content?.includes(selector)) {
    throw new Error(`Traefik config is missing entrypoint selector ${selector}`);
  }
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

const selectorValues = {
  SERVICE_ROOT: extractRoot,
  ...Object.fromEntries(
    Object.entries(resolvedPorts).map(([name, value]) => [
      `${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_PORT`,
      String(value),
    ]),
  ),
};
const renderedCommandline = commandline.replace(/\$\{([^}]+)\}/g, (match, key) => selectorValues[key] ?? match);
const args = parseCommandlineArgs(renderedCommandline);
const traefik = spawn(binaryPath, args, {
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
