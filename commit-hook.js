const fs = require("fs");
const bump = require("./bump_version.js");

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
  fs.writeFileSync(".git/version-bumped", newVersion);
  console.log("Version bumped to " + newVersion);
}