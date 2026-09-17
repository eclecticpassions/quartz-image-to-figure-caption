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

// Safely walk directory while ignoring hidden folders, git, and node_modules
function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip hidden files/folders and heavy system directories
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
  } catch (e) {
    // Silently handle transient file read or permission errors
  }
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

  const cwd = process.cwd();

  // Strip leading "static/" if present to prevent folder duplication (e.g. static/static/...)
  const cleanNormalized = normalized.replace(/^static\//, "");

  // 1. Check direct/explicit paths first
  const directCandidates = [
    path.join(cwd, "static", cleanNormalized), // Handles './static/og-image.png' -> 'cwd/static/og-image.png'
    path.join(cwd, "content", normalized),
    path.join(cwd, "static", normalized),
  ];

  if (filePath) {
    const fileDir = path.dirname(filePath);
    directCandidates.unshift(path.resolve(fileDir, normalized));
  }

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      imageSearchCache.set(cacheKey, candidate);
      return candidate;
    }
  }
  // 2. Fallback to recursive scan of static and content roots
  const roots = [path.join(cwd, "static"), path.join(cwd, "content")].filter((r) =>
    fs.existsSync(r),
  );
  const allFiles = roots.flatMap((root) => walkFiles(root));

  // Check for exact relative path suffix match
  const exactSuffixMatches = allFiles.filter((file) => {
    const rel = path.relative(cwd, file).replace(/\\/g, "/");
    return (
      rel === normalized ||
      rel === cleanNormalized ||
      rel.endsWith(`/${normalized}`) ||
      rel.endsWith(`/${cleanNormalized}`)
    );
  });

  if (exactSuffixMatches.length > 0) {
    const match = exactSuffixMatches[0] ?? null;
    imageSearchCache.set(cacheKey, match);
    return match;
  }

  // 3. Basename fallback (handles cases where users write just "filename.png")
  const base = path.basename(cleanNormalized);
  const basenameMatches = allFiles.filter((file) => path.basename(file) === base);

  if (basenameMatches.length === 1) {
    const match = basenameMatches[0] ?? null;
    imageSearchCache.set(cacheKey, match);
    return match;
  }

  if (basenameMatches.length > 1) {
    console.warn(
      `[rehypeFigure] Warning: Multiple images found with filename "${base}". Using: ${basenameMatches[0]}`,
    );
    const match = basenameMatches[0] ?? null;
    imageSearchCache.set(cacheKey, match);
    return match;
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