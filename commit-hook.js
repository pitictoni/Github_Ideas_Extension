const fs = require("fs");
const { execSync } = require("child_process");
const bump = require("D:\\Projects\\Github_Ideas_Extension\\bump_version.js");

const messageFile = process.argv[2];
const message = fs.readFileSync(messageFile, "utf8");

let type = null;

if (message.includes("BREAKING")) {
  type = "major";
} else if (message.startsWith("feat:")) {
  type = "minor";
} else if (message.startsWith("fix:")) {
  type = "patch";
}

if (type) {
  const newVersion = bump(type);
  execSync("git add manifest.json");
  console.log("Version bumped to " + newVersion);
}