const fs = require("fs");

function bump(type) {
  const manifestPath = "./manifest.json";
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  let [major, minor, patch] = manifest.version.split(".").map(Number);

  if (type === "patch") patch++;
  if (type === "minor") { minor++; patch = 0; }
  if (type === "major") { major++; minor = 0; patch = 0; }

  manifest.version = `${major}.${minor}.${patch}`;

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n"
  );

  return manifest.version;
}

module.exports = bump;