const path = require("path");
const {
  uploadLocalFileToFtp,
  uploadBufferToFtp,
  getFtpConfig,
  getLsDefaultPath,
  withFtpClient,
  listRemoteDirectory,
  ensureKiwiDonatForSteam,
  listKiwiDonatForSteam,
} = require(path.join(__dirname, "lib", "ftpClient"));

async function uploadToServer(localPath, remotePath) {
  return uploadLocalFileToFtp(localPath, remotePath);
}

function usage() {
  console.log(`node index.js ls [віддалений_шлях]
node index.js donat <Steam64>
node index.js <локальний_файл> <віддалений_шлях>

FTP_KIWI_DONAT_ROOT — батьківська тека KIWI_DONAT на FTP.
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  try {
    getFtpConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (cmd === "donat") {
    const sid = args[1];
    if (!sid) {
      console.error("node index.js donat <Steam64>");
      process.exit(1);
    }
    await ensureKiwiDonatForSteam(sid);
    const { path: listedPath, items } = await listKiwiDonatForSteam(sid);
    console.log(`\n${listedPath}\n`);
    const w = Math.max(...items.map((i) => i.name.length), 4);
    for (const it of items) {
      const tag =
        it.kind === "dir" ? "[DIR ]" : it.kind === "link" ? "[LINK]" : "[FILE]";
      const sz =
        it.kind === "dir" ? "—".padStart(12) : String(it.size).padStart(12);
      console.log(`${tag}  ${it.name.padEnd(w)}  ${sz}`);
    }
    console.log(`\n${items.length}`);
    return;
  }

  if (cmd === "ls" || cmd === "list") {
    const remotePath =
      args[1] != null && args[1] !== "" ? args[1] : getLsDefaultPath();
    const { path: listedPath, items } = await listRemoteDirectory(remotePath);
    console.log(`\n${listedPath}\n`);
    const w = Math.max(...items.map((i) => i.name.length), 4);
    for (const it of items) {
      const tag =
        it.kind === "dir" ? "[DIR ]" : it.kind === "link" ? "[LINK]" : "[FILE]";
      const sz =
        it.kind === "dir" ? "—".padStart(12) : String(it.size).padStart(12);
      console.log(`${tag}  ${it.name.padEnd(w)}  ${sz}`);
    }
    console.log(`\n${items.length}`);
    return;
  }

  if (args.length < 2) {
    usage();
    process.exit(1);
  }

  const [local, remote] = args;
  console.log(await uploadToServer(local, remote));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  uploadToServer,
  uploadLocalFileToFtp,
  uploadBufferToFtp,
  getFtpConfig,
  getLsDefaultPath,
  withFtpClient,
  listRemoteDirectory,
  ensureKiwiDonatForSteam,
  listKiwiDonatForSteam,
};
