import rehypeFigureTitle from "rehype-figure-title";
import type { QuartzTransformerPlugin } from "@quartz-community/types";
import { visit } from "unist-util-visit";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toHast } from "mdast-util-to-hast";
import type { Root } from "hast";
import { remarkFigureCaption } from "./remarkFigureCaption";
import { imageSize } from "image-size";
import type { VFile } from "vfile";
import path from "path";
import fs from "fs";

// Cache image lookups to avoid repeated disk I/O during builds
const imageSearchCache = new Map<string, string | null>();

// Dynamically find the true Quartz project root by walking up from the file path
function findProjectRoot(filePath?: string): string {
  let currentDir = filePath ? path.dirname(filePath) : process.cwd();

  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(currentDir, "static")) ||
      fs.existsSync(path.join(currentDir, "package.json"))
    ) {
      return currentDir;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return process.cwd();
}

// Safely walk directory while ignoring hidden folders, git, and node_modules
function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "public") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFiles(fullPath, out);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  } catch (e) {}
  return out;
}

function stripQueryAndHash(src: string): string {
  const noQuery = src.split("?")[0] ?? "";
  const noHash = noQuery.split("#")[0] ?? "";
  return noHash.replace(/^\.?\//, "").replace(/^\//, "");
}

// Robust image finder supporting static/, content/, and relative paths with fallbacks
function findImageSafely(src: string, filePath?: string): string | null {
  const normalized = stripQueryAndHash(src);
  if (!normalized) return null;

  const cacheKey = `${filePath ?? ""}::${normalized}`;
  if (imageSearchCache.has(cacheKey)) {
    return imageSearchCache.get(cacheKey) ?? null;
  }

  const rootDir = findProjectRoot(filePath);
  const cleanNormalized = normalized.replace(/^static\//, "");
  const baseName = path.basename(cleanNormalized);

  // Build explicit absolute candidate paths using the verified project root
  const candidates: string[] = [
    filePath ? path.resolve(path.dirname(filePath), normalized) : "",
    filePath ? path.resolve(path.dirname(filePath), cleanNormalized) : "",
    path.join(rootDir, "static", cleanNormalized),
    path.join(rootDir, "static", normalized),
    path.join(rootDir, "static", baseName),
    path.join(rootDir, "content", cleanNormalized),
    path.join(rootDir, "content", normalized),
    path.join(rootDir, "content", baseName),
  ].filter(Boolean);

  // Test all explicit candidates first
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      imageSearchCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  // Fallback: recursive scan of static/ and content/ roots
  const roots = [path.join(rootDir, "static"), path.join(rootDir, "content")].filter((r) =>
    fs.existsSync(r),
  );
  const allFiles = roots.flatMap((root) => walkFiles(root));

  const matchedFile = allFiles.find((file) => path.basename(file) === baseName);
  if (matchedFile) {
    imageSearchCache.set(cacheKey, matchedFile);
    return matchedFile;
  }

  imageSearchCache.set(cacheKey, null);
  return null;
}

// First function: Auto-calculate and inject image dimensions to fix anchor link jumping inaccurately
function rehypeImageDimensions() {
  return (tree: Root, file?: VFile) => {
    visit(tree, "element", (node: any) => {
      if (node.tagName !== "img") return;

      const src = node.properties?.src as string;
      if (!src || src.startsWith("http") || src.startsWith("//") || src.startsWith("data:")) return;

      const assetPath = findImageSafely(src, file?.path);
      if (!assetPath) return;

      try {
        const dimensions = imageSize(assetPath);
        if (dimensions?.width && dimensions?.height) {
          node.properties.width = dimensions.width;
          node.properties.height = dimensions.height;
        }
      } catch (e) {
        console.error(`Could not read dimensions for: ${assetPath}`);
      }
    });
  };
}

// Second function: Add figcaptions to images
function rehypeRichCaption() {
  return (tree: Root) => {
    visit(tree, "element", (node: any) => {
      if (node.tagName !== "figcaption") return;

      const pNode = node.children.find((child: any) => child.tagName === "p");
      const textNode = pNode ? pNode.children?.[0] : node.children?.[0];

      if (!textNode || textNode.type !== "text") return;

      const captionText = textNode.value.trim();
      if (!captionText) return;

      // Full MD parsing first
      try {
        const mdast = fromMarkdown(captionText);
        let hast = toHast(mdast);

        visit(hast, (n: any) => {
          if (n.type === "element" && n.tagName === "a") {
            n.properties = n.properties || {};
            n.properties.target = "_blank";
            n.properties.rel = "noreferrer noopener";
          }
        });

        if (pNode) {
          pNode.children = hast.type === "root" ? hast.children : [hast];
        } else {
          node.children = hast.type === "root" ? hast.children : [hast];
        }
        return;
      } catch (e) {
        const urlRegex = /https?:\/\/[^\s<)]+/g;
        const matches = [...captionText.matchAll(urlRegex)];
        if (matches.length > 0) {
          const parts = captionText.split(urlRegex);
          const newChildren: any[] = [];

          parts.forEach((part: string, i: number) => {
            if (part) newChildren.push({ type: "text", value: part });
            if (matches[i]) {
              const url = matches[i][0];
              newChildren.push({
                type: "element",
                tagName: "a",
                properties: {
                  href: url,
                  target: "_blank",
                  rel: "noreferrer noopener",
                },
                children: [{ type: "text", value: url }],
              });
            }
          });

          if (pNode) pNode.children = newChildren;
          else node.children = newChildren;
        }
      }
    });
  };
}

export const RehypeFigure: QuartzTransformerPlugin = () => ({
  name: "rehypeFigureTitle",
  markdownPlugins() {
    return [remarkFigureCaption];
  },
  htmlPlugins() {
    return [
      [rehypeFigureTitle, {}],
      [rehypeImageDimensions, {}],
      [rehypeRichCaption, {}],
    ];
  },
});

export default RehypeFigure;