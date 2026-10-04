import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const here = path.dirname(fileURLToPath(import.meta.url));
const svgDir = path.join(here, "assets", "svg");
const outputDir = path.join(here, "assets", "app-icons");
const markPath = path.join(svgDir, "morvia-mark.svg");
const lockupPath = path.join(svgDir, "morvia-master-lockup.svg");

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(markPath, path.join(outputDir, "favicon.svg"));

async function renderIcon(name, size, occupiedRatio = 0.78) {
  const innerSize = Math.round(size * occupiedRatio);
  const leading = Math.floor((size - innerSize) / 2);
  const trailing = size - innerSize - leading;
  await sharp(markPath)
    .resize(innerSize, innerSize)
    .extend({
      top: leading,
      bottom: trailing,
      left: leading,
      right: trailing,
      background: "#FFFFFF",
    })
    .flatten({ background: "#FFFFFF" })
    .png()
    .toFile(path.join(outputDir, name));
}

if (!process.argv.includes("--social-only")) {
await Promise.all([
  renderIcon("favicon-32.png", 32, 0.82),
  renderIcon("apple-touch-icon.png", 180),
  renderIcon("icon-192.png", 192),
  renderIcon("icon-512.png", 512),
  renderIcon("icon-1024.png", 1024),
  renderIcon("icon-maskable-512.png", 512, 0.64),
]);
}

const socialLockup = await sharp(lockupPath).resize({ width: 780 }).png().toBuffer();
await sharp({
  create: {
    width: 1200,
    height: 630,
    channels: 4,
    background: "#F4F5F8",
  },
})
  .composite([{ input: socialLockup, gravity: "center" }])
  .png()
  .toFile(path.join(outputDir, "opengraph-image.png"));

const pngDir = path.join(here, "assets", "png");
fs.mkdirSync(pngDir, { recursive: true });
const wordmarkExports = [
  ["morvia-master-lockup.svg", "morvia-master-lockup-800.png", 800],
  ["morvia-master-lockup.svg", "morvia-master-lockup-1600.png", 1600],
  ["morvia-master-lockup.svg", "morvia-master-lockup-on-white-1600.png", 1600, "#FFFFFF"],
  ["morvia-master-lockup-white.svg", "morvia-master-lockup-on-deep-blue-1600.png", 1600, "#143A8F"],
  ["morvia-master-lockup-white.svg", "morvia-master-lockup-white-1600.png", 1600],
  ["morvia-master-lockup-mono.svg", "morvia-master-lockup-mono-1600.png", 1600],
  ["morvia-compact-lockup.svg", "morvia-compact-lockup-1200.png", 1200],
  ["morvia-established-lockup.svg", "morvia-established-lockup-1800.png", 1800],
  ["morvia-wordmark.svg", "morvia-wordmark-1100.png", 1100],
  ["morvia-stacked-lockup.svg", "morvia-stacked-lockup-1200.png", 1200],
];
await Promise.all(wordmarkExports.map(async ([source, output, width, background]) => {
  const rendered = sharp(path.join(svgDir, source)).resize({ width });
  if (background) rendered.flatten({ background });
  await rendered.png().toFile(path.join(pngDir, output));
}));

console.log(`Generated product assets in ${outputDir}`);
