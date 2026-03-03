import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";

let connectionSettings: any;

async function getAccessToken() {
  if (connectionSettings?.settings?.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? "depl " + process.env.WEB_REPL_RENEWAL
    : null;
  if (!xReplitToken) throw new Error("X-Replit-Token not found");

  connectionSettings = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=github",
    { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } }
  ).then((r) => r.json()).then((d) => d.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings?.settings?.oauth?.credentials?.access_token;
  if (!accessToken) throw new Error("GitHub not connected");
  return accessToken;
}

const OWNER = "nearmiss1193-afk";
const REPO = "fundedtraderskills";
const BRANCH = "main";

const IGNORE = new Set([
  "node_modules", ".git", "dist", ".DS_Store", "data", ".local",
  ".cache", ".config", ".upm", ".replit", "replit.nix", ".replit.nix",
  "generated-icon.png", ".breakpoints"
]);

function getAllFiles(dir: string, base = ""): { path: string; fullPath: string }[] {
  const results: { path: string; fullPath: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    const rel = base ? base + "/" + entry.name : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(full, rel));
    } else {
      results.push({ path: rel, fullPath: full });
    }
  }
  return results;
}

async function main() {
  const token = await getAccessToken();
  const octokit = new Octokit({ auth: token });

  const { data: user } = await octokit.users.getAuthenticated();
  console.log("Authenticated as:", user.login);

  const files = getAllFiles("/home/runner/workspace");
  console.log(`Found ${files.length} files to push`);

  // Get current commit SHA
  let currentSha: string;
  try {
    const { data: ref } = await octokit.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
    currentSha = ref.object.sha;
    console.log("Current HEAD:", currentSha.slice(0, 8));
  } catch {
    console.log("Branch not found, creating new");
    currentSha = "";
  }

  // Create blobs for all files
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  let count = 0;
  for (const file of files) {
    try {
      const content = fs.readFileSync(file.fullPath);
      const base64 = content.toString("base64");
      const { data: blob } = await octokit.git.createBlob({
        owner: OWNER, repo: REPO,
        content: base64, encoding: "base64"
      });
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
      count++;
      if (count % 20 === 0) console.log(`  ${count}/${files.length} files uploaded...`);
    } catch (e: any) {
      console.error(`  Skip ${file.path}: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`Uploaded ${count} file blobs`);

  // Create tree
  const { data: newTree } = await octokit.git.createTree({
    owner: OWNER, repo: REPO,
    tree: tree as any,
  });
  console.log("Created tree:", newTree.sha.slice(0, 8));

  // Create commit
  const commitPayload: any = {
    owner: OWNER, repo: REPO,
    message: "Full sync: Yahoo Finance integration, Bull Flag Pullback pattern, BTC/ETH point value fix, confluence-filtered backtest system",
    tree: newTree.sha,
  };
  if (currentSha) commitPayload.parents = [currentSha];

  const { data: commit } = await octokit.git.createCommit(commitPayload);
  console.log("Created commit:", commit.sha.slice(0, 8));

  // Update branch ref
  await octokit.git.updateRef({
    owner: OWNER, repo: REPO,
    ref: `heads/${BRANCH}`,
    sha: commit.sha,
    force: true,
  });
  console.log("Pushed to", `${OWNER}/${REPO}@${BRANCH}`);
  console.log("Done! View at: https://github.com/${OWNER}/${REPO}");
}

main().catch(console.error);
