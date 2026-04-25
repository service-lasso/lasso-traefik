import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const traefikVersion = process.env.TRAEFIK_VERSION ?? "v3.6.13";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    upstreamOs: "windows",
    upstreamExt: "zip",
    binary: "traefik.exe",
    assetName: "lasso-traefik-win32.zip",
    archiveType: "zip",
  },
  linux: {
    upstreamOs: "linux",
    upstreamExt: "tar.gz",
    binary: "traefik",
    assetName: "lasso-traefik-linux.tar.gz",
    archiveType: "tar.gz",
  },
  darwin: {
    upstreamOs: "darwin",
    upstreamExt: "tar.gz",
    binary: "traefik",
    assetName: "lasso-traefik-darwin.tar.gz",
    archiveType: "tar.gz",
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function download(url, destination) {
  if (existsSync(destination)) {
    return;
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "service-lasso-lasso-traefik-packager",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function compressPackage(packageRoot, target) {
  const distRoot = path.join(repoRoot, "dist");
  const outputPath = path.join(distRoot, target.assetName);
  await mkdir(distRoot, { recursive: true });
  await rm(outputPath, { force: true });

  if (target.archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

export async function packageTraefik(platform = targetPlatform) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}`);
  }

  const versionWithoutPrefix = traefikVersion.replace(/^v/, "");
  const upstreamAsset = `traefik_${traefikVersion}_${target.upstreamOs}_amd64.${target.upstreamExt}`;
  const upstreamUrl = `https://github.com/traefik/traefik/releases/download/${traefikVersion}/${upstreamAsset}`;
  const vendorRoot = path.join(repoRoot, "vendor", platform);
  const outputRoot = path.join(repoRoot, "output", "package", platform);
  const extractRoot = path.join(outputRoot, "extract");
  const packageRoot = path.join(outputRoot, "payload");
  const upstreamArchive = path.join(vendorRoot, upstreamAsset);

  await mkdir(vendorRoot, { recursive: true });
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });

  await download(upstreamUrl, upstreamArchive);
  run("tar", ["-xf", upstreamArchive, "-C", extractRoot]);

  const binaryPath = path.join(extractRoot, target.binary);
  if (!existsSync(binaryPath)) {
    throw new Error(`Expected Traefik binary was not found at ${binaryPath}`);
  }

  const packagedBinary = path.join(packageRoot, target.binary);
  await copyFile(binaryPath, packagedBinary);
  if (target.archiveType !== "zip") {
    await chmod(packagedBinary, 0o755);
  }

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "@traefik",
        upstream: {
          repo: "traefik/traefik",
          version: traefikVersion,
          asset: upstreamAsset,
        },
        packagedBy: "service-lasso/lasso-traefik",
        platform,
        arch: "amd64",
        traefikVersion: versionWithoutPrefix,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const outputPath = await compressPackage(packageRoot, target);
  console.log(`[lasso-traefik] packaged ${outputPath}`);
  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageTraefik();
}
