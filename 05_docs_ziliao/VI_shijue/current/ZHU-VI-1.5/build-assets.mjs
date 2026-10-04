import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const svgDir = path.join(here, "assets", "svg");

const sourceMarkPath = path.join(here, "components", "morvia-mark-master.svg");
const sourceApprovedWordmarkPath = path.join(
  here,
  "components",
  "zhudatuan-wordmark-outlined.svg",
);
const sourceMorviaWordmarkPath = path.join(
  here,
  "components",
  "morvia-wordmark-outlined.svg",
);

fs.mkdirSync(svgDir, { recursive: true });

function parseComponent(filePath, prefix) {
  const source = fs.readFileSync(filePath, "utf8");
  const viewBox = source.match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) throw new Error(`Missing viewBox: ${filePath}`);

  let body = source
    .replace(/^<\?xml[^>]*>\s*/u, "")
    .replace(/^<svg[^>]*>\s*/u, "")
    .replace(/\s*<\/svg>\s*$/u, "")
    .replace(/\s*<title[^>]*>[\s\S]*?<\/title>/gu, "")
    .replace(/\s*<desc[^>]*>[\s\S]*?<\/desc>/gu, "");

  body = body
    .replace(/id="([^"]+)"/gu, (_, id) => `id="${prefix}-${id}"`)
    .replace(
      /(href|xlink:href)="#([^"]+)"/gu,
      (_, attribute, id) => `${attribute}="#${prefix}-${id}"`,
    );

  return { viewBox, body };
}

function recolor(component, color, includeMarkPalette = false) {
  let body = component.body
    .replace(/#111111/giu, color)
    .replace(/rgb\(6\.666667%,\s*6\.666667%,\s*6\.666667%\)/giu, color);

  if (includeMarkPalette) {
    body = body.replace(/#143A8F|#0D2D72|#2857BD|#0F347F/giu, color);
  }

  return { ...component, body };
}

function place(component, x, y, width, height) {
  return [
    `<svg x="${x}" y="${y}" width="${width}" height="${height}"`,
    ` viewBox="${component.viewBox}" preserveAspectRatio="xMinYMid meet">`,
    component.body,
    "</svg>",
  ].join("");
}

function documentSvg({ width, height, title, description, content }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${title}</title>
  <desc id="desc">${description}</desc>
  ${content}
</svg>
`;
}

function save(name, svg) {
  fs.writeFileSync(path.join(svgDir, name), svg, "utf8");
}

const mark = parseComponent(sourceMarkPath, "mark");
const approved = parseComponent(sourceApprovedWordmarkPath, "approved");
const morvia = parseComponent(sourceMorviaWordmarkPath, "morvia");

const markWhite = recolor(mark, "#FFFFFF", true);
const markMono = recolor(mark, "#111111", true);
const approvedWhite = recolor(approved, "#FFFFFF");
const morviaWhite = recolor(morvia, "#FFFFFF");

save(
  "morvia-mark.svg",
  documentSvg({
    width: 512,
    height: 512,
    title: "主打团 M mark",
    description: "The approved blue M mark, reproduced without geometric changes.",
    content: place(mark, 0, 0, 512, 512),
  }),
);

save(
  "morvia-mark-mono.svg",
  documentSvg({
    width: 512,
    height: 512,
    title: "主打团 M mark monochrome",
    description: "One-color reproduction of the approved M mark.",
    content: place(markMono, 0, 0, 512, 512),
  }),
);

save(
  "morvia-mark-white.svg",
  documentSvg({
    width: 512,
    height: 512,
    title: "主打团 M mark reverse",
    description: "White technical reproduction of the approved M mark.",
    content: place(markWhite, 0, 0, 512, 512),
  }),
);

save(
  "morvia-wordmark.svg",
  documentSvg({
    width: 550,
    height: 116,
    title: "主打团 wordmark",
    description: "沿用已批准的主打团中文矢量字形。",
    content: place(morvia, 0, 0, 550, 116),
  }),
);

const masterContent = [
  place(mark, 0, 0, 160, 160),
  place(approved, 184, 16, 410, 128),
].join("\n  ");

save(
  "morvia-master-lockup.svg",
  documentSvg({
    width: 640,
    height: 160,
    title: "主打团 master lockup",
    description: "主打团中文品牌签名，沿用已批准的 M 标识与中文矢量字形。",
    content: masterContent,
  }),
);

save(
  "morvia-compact-lockup.svg",
  documentSvg({
    width: 460,
    height: 120,
    title: "主打团 compact lockup",
    description: "Compact navigation signature pairing the approved M mark with 主打团.",
    content: [place(mark, 0, 0, 120, 120), place(approved, 138, 9, 300, 102)].join("\n  "),
  }),
);

save(
  "morvia-established-lockup.svg",
  documentSvg({
    width: 430,
    height: 112,
    title: "主打团 extended established-name lockup",
    description: "Extended one-line signature showing 主打团 with the approved 主打团 name.",
    content: [
      place(mark, 0, 0, 112, 112),
      place(approved, 130, 12, 290, 88),
    ].join("\n  "),
  }),
);

save(
  "morvia-stacked-lockup.svg",
  documentSvg({
    width: 560,
    height: 330,
    title: "主打团 stacked lockup",
    description: "Centered vertical signature for square and formal layouts.",
    content: [
      place(mark, 170, 0, 220, 220),
      place(approved, 130, 226, 300, 102),
    ].join("\n  "),
  }),
);

save(
  "morvia-master-lockup-mono.svg",
  documentSvg({
    width: 640,
    height: 160,
    title: "主打团 master lockup monochrome",
    description: "One-color fallback for restricted production.",
    content: [
      place(markMono, 0, 0, 160, 160),
      place(approved, 184, 16, 410, 128),
    ].join("\n  "),
  }),
);

save(
  "morvia-master-lockup-white.svg",
  documentSvg({
    width: 640,
    height: 160,
    title: "主打团 master lockup reverse",
    description: "White fallback for dark backgrounds.",
    content: [
      place(markWhite, 0, 0, 160, 160),
      place(approvedWhite, 184, 16, 410, 128),
    ].join("\n  "),
  }),
);

save(
  "morvia-avatar-light.svg",
  documentSvg({
    width: 512,
    height: 512,
    title: "主打团 avatar light",
    description: "Approved blue M mark on a white square field.",
    content: '<rect width="512" height="512" rx="112" fill="#FFFFFF"/>\n  ' + place(mark, 46, 46, 420, 420),
  }),
);

save(
  "morvia-avatar-blue.svg",
  documentSvg({
    width: 512,
    height: 512,
    title: "主打团 avatar blue",
    description: "White technical M mark on 主打团 blue.",
    content: '<rect width="512" height="512" rx="112" fill="#143A8F"/>\n  ' + place(markWhite, 46, 46, 420, 420),
  }),
);
