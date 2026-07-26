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
const protectedServiceAdminFixturePath = path.join(repoRoot, "runtime", "protected-serviceadmin.example.yml");
const protectedServiceAdminFixture = (await readFile(protectedServiceAdminFixturePath, "utf8")).replaceAll("\r\n", "\n");
const ssoIngressFixturePath = path.join(repoRoot, "runtime", "servicelasso-sso-ingress.example.yml");
const ssoIngressFixture = (await readFile(ssoIngressFixturePath, "utf8")).replaceAll("\r\n", "\n");
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
const expectedEndpointProtocols = {
  web: "http",
  websecure: "https",
  admin: "http",
  https_traefik: "https",
  https_nginx: "https",
  https_cms: "https",
  https_flow: "https",
  https_flowtms: "https",
  https_api: "https",
  https_files: "https",
  https_bpmn: "https",
  mongo: "tcp",
  typedb: "tcp",
};
const expectedUrlEndpoints = {
  dashboard: {
    target: "admin",
    url: "http://${endpoint.admin.bind}:${endpoint.admin.port}/dashboard/",
    primary: true,
  },
  ping: {
    target: "admin",
    url: "http://${endpoint.admin.bind}:${endpoint.admin.port}/ping",
  },
  web_url: {
    target: "web",
    url: "http://${endpoint.web.bind}:${endpoint.web.port}/",
  },
  websecure_url: {
    target: "websecure",
    url: "https://${endpoint.websecure.bind}:${endpoint.websecure.port}/",
  },
};
const expectedEndpointIds = [...Object.keys(expectedPorts), ...Object.keys(expectedUrlEndpoints)];
const resolvedPorts = Object.fromEntries(
  await Promise.all(Object.keys(expectedPorts).map(async (name) => [name, await reserveLoopbackPort()])),
);
const adminPort = resolvedPorts.admin;

if ("healthcheck" in serviceManifest) {
  throw new Error("Traefik service.json must use canonical healthchecks[] instead of singular healthcheck.");
}

if (!Array.isArray(serviceManifest.healthchecks) || serviceManifest.healthchecks.length !== 1) {
  throw new Error(`Traefik service.json must declare one canonical healthchecks[] item: ${JSON.stringify(serviceManifest.healthchecks)}`);
}

const healthcheckIds = new Set();
for (const healthcheck of serviceManifest.healthchecks) {
  if (!healthcheck?.id || healthcheckIds.has(healthcheck.id)) {
    throw new Error(`Traefik service.json healthchecks[] must use stable unique ids: ${JSON.stringify(serviceManifest.healthchecks)}`);
  }
  healthcheckIds.add(healthcheck.id);
}

const [pingHealthcheck] = serviceManifest.healthchecks;
if (
  pingHealthcheck.id !== "traefik-ping" ||
  pingHealthcheck.type !== "http" ||
  pingHealthcheck.url !== "${endpoint.ping.url}" ||
  pingHealthcheck.expected_status !== 200
) {
  throw new Error(`Traefik service.json must declare HTTP /ping readiness in healthchecks[]: ${JSON.stringify(serviceManifest.healthchecks)}`);
}

if (JSON.stringify(serviceManifest.depend_on) !== JSON.stringify(["localcert", "nginx"])) {
  throw new Error(`Traefik service.json dependencies drifted: ${JSON.stringify(serviceManifest.depend_on)}`);
}

const expectedEnv = {
  HTTP: "${endpoint.web.port}",
  HTTPS: "${endpoint.websecure.port}",
  HTTPS_TRAEFIK: "${endpoint.https_traefik.port}",
  HTTPS_NGINX: "${endpoint.https_nginx.port}",
  HTTPS_CMS: "${endpoint.https_cms.port}",
  HTTPS_FLOW: "${endpoint.https_flow.port}",
  HTTPS_FLOWTMS: "${endpoint.https_flowtms.port}",
  HTTPS_API: "${endpoint.https_api.port}",
  HTTPS_FILES: "${endpoint.https_files.port}",
  HTTPS_BPMN: "${endpoint.https_bpmn.port}",
  TCP_MOGNO: "${endpoint.mongo.port}",
  TCP_TYPEDB: "${endpoint.typedb.port}",
  TRAEFIK_HTTP_PORT: "${endpoint.web.port}",
  TRAEFIK_HTTPS_PORT: "${endpoint.websecure.port}",
  TRAEFIK_INTERNAL_PORT: "${endpoint.admin.port}",
  TRAEFIK_HTTPS_TRAEFIK_PORT: "${endpoint.https_traefik.port}",
  TRAEFIK_HTTPS_NGINX_PORT: "${endpoint.https_nginx.port}",
  TRAEFIK_HTTPS_CMS_PORT: "${endpoint.https_cms.port}",
  TRAEFIK_HTTPS_FLOW_PORT: "${endpoint.https_flow.port}",
  TRAEFIK_HTTPS_FLOWTMS_PORT: "${endpoint.https_flowtms.port}",
  TRAEFIK_HTTPS_API_PORT: "${endpoint.https_api.port}",
  TRAEFIK_HTTPS_FILES_PORT: "${endpoint.https_files.port}",
  TRAEFIK_HTTPS_BPMN_PORT: "${endpoint.https_bpmn.port}",
  TRAEFIK_MONGO_PORT: "${endpoint.mongo.port}",
  TRAEFIK_TYPEDB_PORT: "${endpoint.typedb.port}",
  TRAEFIK_WEB_URL: "${endpoint.web_url.url}",
  TRAEFIK_WEBSECURE_URL: "${endpoint.websecure_url.url}",
  TRAEFIK_DASHBOARD_URL: "${endpoint.dashboard.url}",
  TRAEFIK_PING_URL: "${endpoint.ping.url}",
};
const expectedGlobalEnv = {
  ...expectedEnv,
  TRAEFIK_TRAEFIK_URL: "${endpoint.dashboard.url}",
  TRAEFIK_HOST_DOMAIN: "localhost",
  TRAEFIK_HOST_DOMAIN_URL: "localhost",
  TRAEFIK_HOST_DOMAIN_SUFFIX: "localhost",
};

if ("ports" in serviceManifest || "portmapping" in serviceManifest || "urls" in serviceManifest) {
  throw new Error("Traefik service.json must author endpoints[] instead of legacy ports, portmapping, or urls.");
}

if (!Array.isArray(serviceManifest.endpoints)) {
  throw new Error("Traefik service.json must declare endpoints[].");
}

const endpointsById = Object.fromEntries(serviceManifest.endpoints.map((endpoint) => [endpoint.id, endpoint]));
if (JSON.stringify(Object.keys(endpointsById)) !== JSON.stringify(expectedEndpointIds)) {
  throw new Error(`Traefik service.json endpoints drifted: ${JSON.stringify(Object.keys(endpointsById))}`);
}

for (const [id, portDefault] of Object.entries(expectedPorts)) {
  const endpoint = endpointsById[id];
  if (
    endpoint?.kind !== "network" ||
    endpoint.direction !== "inbound" ||
    endpoint.transport !== "tcp" ||
    endpoint.protocol !== expectedEndpointProtocols[id] ||
    endpoint.bind !== "127.0.0.1" ||
    endpoint.port?.default !== portDefault ||
    endpoint.port?.strategy !== "preferred" ||
    endpoint.exposure !== "local" ||
    endpoint.required !== true
  ) {
    throw new Error(`Traefik network endpoint ${id} drifted: ${JSON.stringify(endpoint)}`);
  }
}

for (const [id, expected] of Object.entries(expectedUrlEndpoints)) {
  const endpoint = endpointsById[id];
  if (
    endpoint?.kind !== "url" ||
    endpoint.target !== expected.target ||
    endpoint.url !== expected.url ||
    endpoint.exposure !== "local" ||
    endpoint.required !== true ||
    (expected.primary && endpoint.primary !== true)
  ) {
    throw new Error(`Traefik URL endpoint ${id} drifted: ${JSON.stringify(endpoint)}`);
  }
}

if (JSON.stringify(serviceManifest.env) !== JSON.stringify(expectedEnv)) {
  throw new Error(`Traefik service.json env drifted: ${JSON.stringify(serviceManifest.env)}`);
}

if (JSON.stringify(serviceManifest.globalenv) !== JSON.stringify(expectedGlobalEnv)) {
  throw new Error(`Traefik service.json globalenv drifted: ${JSON.stringify(serviceManifest.globalenv)}`);
}

const installedProtectedRouteFixture = serviceManifest.install?.files?.find(
  (file) => file.path === "./runtime/protected-serviceadmin.example.yml",
);
if (!installedProtectedRouteFixture) {
  throw new Error("Traefik service.json must install the protected Service Admin route fixture.");
}
if (installedProtectedRouteFixture.content !== protectedServiceAdminFixture) {
  throw new Error("Installed protected Service Admin route fixture drifted from runtime/protected-serviceadmin.example.yml.");
}

for (const requiredText of [
  "Host(`serviceadmin.servicelasso.localhost`)",
  "serviceadmin-strip-spoofed-identity",
  "serviceadmin-oidc-auth",
  "forwardAuth:",
  "trustForwardHeader: false",
  "authRequestHeaders:",
  "authResponseHeaders:",
  "X-Service-Lasso-User: \"\"",
  "X-Service-Lasso-Workspace: \"\"",
  "X-Service-Lasso-Roles: \"\"",
  "X-Service-Lasso-Actor: \"\"",
  "X-Forwarded-User: \"\"",
  "X-Auth-Request-User: \"\"",
  "http://127.0.0.1:${OIDC_AUTH_PORT}/auth",
  "http://127.0.0.1:${SERVICEADMIN_PORT}",
]) {
  if (!protectedServiceAdminFixture.includes(requiredText)) {
    throw new Error(`Protected Service Admin route fixture is missing ${requiredText}`);
  }
}

if (/serviceadmin\.servicelasso\.local(?!host)/.test(protectedServiceAdminFixture)) {
  throw new Error("Protected Service Admin route fixture must use servicelasso.localhost, not .local.");
}

for (const forbiddenSnippet of [
  "X-Service-Lasso-User: spoof",
  "X-Service-Lasso-Workspace: spoof",
  "Authorization: \"\"",
  "Cookie: \"\"",
]) {
  if (protectedServiceAdminFixture.includes(forbiddenSnippet)) {
    throw new Error(`Protected Service Admin route fixture contains unsafe header behavior: ${forbiddenSnippet}`);
  }
}

for (const requiredText of [
  "Host(`serviceadmin.servicelasso.localhost`)",
  "Host(`auth.servicelasso.localhost`) && PathPrefix(`/oauth2/callback`)",
  "Host(`auth.servicelasso.localhost`) && PathPrefix(`/logout`)",
  "Host(`zitadel.servicelasso.localhost`)",
  "servicelasso-strip-spoofed-identity",
  "servicelasso-forward-auth",
  "servicelasso-auth-redirect-allowlist",
  "servicelasso-secure-cookie-headers",
  "address: \"http://127.0.0.1:${AUTH_FACADE_PORT}/forward-auth\"",
  "trustForwardHeader: false",
  "X-ServiceLasso-User-ID: \"\"",
  "X-ServiceLasso-Workspace-ID: \"\"",
  "X-ServiceLasso-Audit-Actor: \"\"",
  "X-ServiceLasso-Allowed-Redirect-Hosts: \"serviceadmin.servicelasso.localhost,auth.servicelasso.localhost,zitadel.servicelasso.localhost\"",
  "http://127.0.0.1:${SERVICEADMIN_PORT}",
  "http://127.0.0.1:${AUTH_FACADE_PORT}",
  "http://127.0.0.1:${ZITADEL_PORT}",
]) {
  if (!ssoIngressFixture.includes(requiredText)) {
    throw new Error(`Service Lasso SSO ingress fixture is missing ${requiredText}`);
  }
}

if (/serviceadmin\.servicelasso\.local(?!host)/.test(ssoIngressFixture)) {
  throw new Error("Service Lasso SSO ingress fixture must use servicelasso.localhost, not .local.");
}

for (const forbiddenSnippet of [
  "serviceadmin-bypass",
  "serviceadmin-unprotected",
  "trustForwardHeader: true",
  "Set-Cookie:",
  "id_token",
  "access_token",
  "refresh_token",
]) {
  if (ssoIngressFixture.includes(forbiddenSnippet)) {
    throw new Error(`Service Lasso SSO ingress fixture contains unsafe auth behavior: ${forbiddenSnippet}`);
  }
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
  "${endpoint.websecure.port}",
  "${endpoint.https_traefik.port}",
  "${endpoint.https_nginx.port}",
  "${endpoint.https_cms.port}",
  "${endpoint.https_flow.port}",
  "${endpoint.https_flowtms.port}",
  "${endpoint.https_api.port}",
  "${endpoint.https_files.port}",
  "${endpoint.https_bpmn.port}",
  "${endpoint.mongo.port}",
  "${endpoint.typedb.port}",
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
  ...Object.fromEntries(Object.entries(resolvedPorts).map(([name, value]) => [`endpoint.${name}.port`, String(value)])),
  ...Object.fromEntries(Object.keys(resolvedPorts).map((name) => [`endpoint.${name}.bind`, "127.0.0.1"])),
  "endpoint.dashboard.url": `http://127.0.0.1:${adminPort}/dashboard/`,
  "endpoint.ping.url": `http://127.0.0.1:${adminPort}/ping`,
  "endpoint.web_url.url": `http://127.0.0.1:${resolvedPorts.web}/`,
  "endpoint.websecure_url.url": `https://127.0.0.1:${resolvedPorts.websecure}/`,
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
