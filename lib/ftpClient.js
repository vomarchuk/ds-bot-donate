const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");
const { Client } = require("basic-ftp");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

function getFtpConfig() {
  const host = process.env.FTP_HOST;
  const user = process.env.FTP_USER;
  const password = process.env.FTP_PASSWORD;
  if (!host || !user || password === undefined) {
    throw new Error(".env: FTP_HOST, FTP_USER, FTP_PASSWORD");
  }
  return {
    host,
    port: Number(process.env.FTP_PORT) || 21,
    user,
    password,
    secure:
      process.env.FTP_SECURE === "true" || process.env.FTP_SECURE === "1",
    verbose:
      process.env.FTP_VERBOSE === "1" || process.env.FTP_VERBOSE === "true",
  };
}

function getLsDefaultPath() {
  const d = process.env.FTP_LS_DEFAULT;
  if (!d || !String(d).trim()) return "/";
  let r = String(d).trim().replace(/\\/g, "/");
  if (!r.startsWith("/")) r = `/${r}`;
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  return r;
}

function createClient(timeoutMs = 60_000) {
  return new Client(timeoutMs);
}

async function connect(client) {
  const c = getFtpConfig();
  client.ftp.verbose = c.verbose;
  try {
    await client.access({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      secure: c.secure,
      secureOptions:
        c.secure && process.env.FTP_TLS_INSECURE === "1"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  } catch (e) {
    const msg = String(e && e.message);
    const code = e && e.code;
    if (code === 503 || /503|AUTH first/i.test(msg)) {
      throw new Error("FTPS: FTP_SECURE=true, при сертифікаті — FTP_TLS_INSECURE=1");
    }
    if (
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      code === "SELF_SIGNED_CERT_IN_CHAIN" ||
      /self-signed certificate/i.test(msg)
    ) {
      throw new Error("FTP_TLS_INSECURE=1");
    }
    throw e;
  }
}

/** Git Bash замінює одиничний / на каталог Git → 550 на FTP. */
function fixGitBashFtpPath(remotePath) {
  if (remotePath == null) return remotePath;
  let s = String(remotePath).replace(/\\/g, "/").trim();
  if (s === "//") return "/";
  if (
    [
      /^[cC]:\/Program Files\/Git\/?$/,
      /^\/[cC]:\/Program Files\/Git\/?$/,
      /^\/[cC]\/Program Files\/Git\/?$/,
    ].some((re) => re.test(s))
  ) {
    return "/";
  }
  return remotePath;
}

function remoteDirname(remotePath) {
  const n = remotePath.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  if (i <= 0) return "/";
  return n.slice(0, i) || "/";
}

async function uploadLocalFileToFtp(localPath, remotePath) {
  const abs = path.resolve(localPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`Немає файлу: ${abs}`);
  }
  let r = String(fixGitBashFtpPath(remotePath) ?? remotePath).replace(/\\/g, "/");
  if (!r.startsWith("/")) {
    throw new Error("Віддалений шлях від /");
  }

  const client = createClient();
  try {
    await connect(client);
    await client.ensureDir(remoteDirname(r));
    await client.uploadFrom(abs, r);
    return { ok: true, localPath: abs, remotePath: r };
  } finally {
    client.close();
  }
}

async function uploadBufferToFtp(buffer, remotePath) {
  let r = String(fixGitBashFtpPath(remotePath) ?? remotePath).replace(/\\/g, "/");
  if (!r.startsWith("/")) {
    throw new Error("Віддалений шлях від /");
  }

  const client = createClient();
  try {
    await connect(client);
    await client.ensureDir(remoteDirname(r));
    await client.uploadFrom(Readable.from(buffer), r);
    return { ok: true, remotePath: r, bytes: buffer.length };
  } finally {
    client.close();
  }
}

async function withFtpClient(fn) {
  const client = createClient();
  try {
    await connect(client);
    return await fn(client);
  } finally {
    client.close();
  }
}

function mapListEntries(entries) {
  const items = entries.map((e) => ({
    name: e.name,
    kind: e.isDirectory
      ? "dir"
      : e.isSymbolicLink
        ? "link"
        : e.isFile
          ? "file"
          : "?",
    size: typeof e.size === "number" ? e.size : 0,
  }));
  items.sort((a, b) => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (b.kind === "dir" && a.kind !== "dir") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return items;
}

async function listViaCdAndPwd(client, r) {
  if (r === "/") {
    await client.cd("/");
    const entries = await client.list();
    return { listedPath: await client.pwd(), entries };
  }
  try {
    await client.cd(r);
  } catch (_e) {
    const parts = r.split("/").filter(Boolean);
    await client.cd("/");
    for (const part of parts) {
      await client.cd(part);
    }
  }
  const entries = await client.list();
  const listedPath = await client.pwd();
  return { listedPath, entries };
}

async function listRemoteDirectory(remotePath = "/") {
  const raw = remotePath === undefined || remotePath === "" ? "/" : remotePath;
  const fixed = fixGitBashFtpPath(raw);
  let r = String(fixed ?? raw).trim().replace(/\\/g, "/");
  if (!r.startsWith("/")) r = `/${r}`;
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);

  const client = createClient();
  try {
    await connect(client);
    const pwdAfterLogin = await client.pwd();

    let entries;
    let listedPath = r;

    try {
      entries = await client.list(r);
    } catch (e) {
      if (e.code !== 550) throw e;
      try {
        const out = await listViaCdAndPwd(client, r);
        entries = out.entries;
        listedPath = out.listedPath;
      } catch (_e2) {
        throw new Error(
          `550 «${r}» (pwd: ${pwdAfterLogin}). У Bash для кореня: ls '//'. ${e.message}`
        );
      }
    }

    return { path: listedPath, items: mapListEntries(entries) };
  } finally {
    client.close();
  }
}

/** Батьківська тека на FTP: всередині — папки з ім’ям Steam64 (як $profile:/KIWI_DONAT/). */
function getKiwiDonatRootPath() {
  const raw = process.env.FTP_KIWI_DONAT_ROOT;
  if (!raw || !String(raw).trim()) {
    throw new Error(".env: FTP_KIWI_DONAT_ROOT");
  }
  let p = String(raw).trim().replace(/\\/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Як GetPlainId() у DayZ — 17-значний Steam64. */
function normalizeSteamId64(s) {
  const t = String(s || "").trim();
  if (!/^\d{17}$/.test(t)) {
    throw new Error("Потрібен Steam64 — рівно 17 цифр");
  }
  return t;
}

/** Вміст теки …/KIWI_DONAT/<steamId> на FTP. */
async function listKiwiDonatForSteam(steamIdRaw) {
  const id = normalizeSteamId64(steamIdRaw);
  const root = getKiwiDonatRootPath();
  return listRemoteDirectory(`${root}/${id}`);
}

module.exports = {
  getFtpConfig,
  getLsDefaultPath,
  getKiwiDonatRootPath,
  normalizeSteamId64,
  uploadLocalFileToFtp,
  uploadBufferToFtp,
  withFtpClient,
  listRemoteDirectory,
  listKiwiDonatForSteam,
};
