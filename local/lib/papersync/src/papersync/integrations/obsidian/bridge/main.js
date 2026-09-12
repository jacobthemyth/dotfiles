"use strict";

// papersync bridge. Renders one note to PDF with Obsidian's own renderer.
//
// require("obsidian") only resolves inside a plugin sandbox, which is the
// entire reason this plugin exists: the papersync CLI cannot reach
// MarkdownRenderer from `obsidian eval` on its own.

const obsidian = require("obsidian");
const fs = require("fs");
const path = require("path");

const MM_PER_INCH = 25.4;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function valueCell(value) {
  if (Array.isArray(value)) {
    const items = value.map((v) => `<li>${escapeHtml(v)}</li>`).join("");
    return `<ul>${items}</ul>`;
  }
  if (value === null || value === undefined) return "";
  return escapeHtml(value);
}

function frontmatterTable(pairs) {
  if (!pairs || pairs.length === 0) return "";
  const rows = pairs
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${valueCell(value)}</td></tr>`)
    .join("");
  return `<table class="papersync-frontmatter"><tbody>${rows}</tbody></table>`;
}

// The single emitter of @page. page.css deliberately declares no @page
// rule of its own, so there is exactly one source of truth for the page
// box: this spec-derived rule, sourced from layout.py via the spec.
function pageStyle(spec, css) {
  const p = spec.page;
  const m = spec.margins_mm;
  const rule = `@page { size: ${p.width_mm}mm ${p.height_mm}mm; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; }`;
  return `${rule}\n${css}`;
}

async function renderBody(app, file) {
  const markdown = await app.vault.cachedRead(file);
  const container = createDiv();
  container.addClass("papersync-body");
  const component = new obsidian.Component();
  try {
    await obsidian.MarkdownRenderer.render(app, markdown, container, file.path, component);
  } finally {
    component.unload();
  }
  return container.innerHTML;
}

async function printHtml(html, spec) {
  const { remote } = require("electron");
  const win = new remote.BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const buffer = await win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      scale: 1,
      pageSize: {
        width: spec.page.width_mm / MM_PER_INCH,
        height: spec.page.height_mm / MM_PER_INCH,
      },
    });
    fs.writeFileSync(spec.out, buffer);
    return buffer.length;
  } finally {
    win.destroy();
  }
}

class PapersyncBridge extends obsidian.Plugin {
  async onload() {
    const css = fs.readFileSync(
      path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, "page.css"),
      "utf8"
    );
    const self = this;
    window.papersync = {
      version: this.manifest.version,
      async renderFile(specPath) {
        try {
          const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
          const file = self.app.vault.getAbstractFileByPath(spec.path);
          if (!file) throw new Error(`no such note: ${spec.path}`);
          const body = await renderBody(self.app, file);
          const html =
            `<!doctype html><html><head><meta charset="utf-8">` +
            `<style>${pageStyle(spec, css)}</style></head><body>` +
            frontmatterTable(spec.frontmatter) +
            `<div class="papersync-body">${body}</div>` +
            `</body></html>`;
          const bytes = await printHtml(html, spec);
          // NOTE: this page count comes from a regex over the raw PDF
          // bytes, which is fragile (it does not understand compressed
          // object streams, and a false /Type /Page match is possible).
          // It exists only so the bridge can report something to
          // `obsidian eval`. The Python side re-counts pages
          // authoritatively with pymupdf after this returns and ignores
          // this number, so no consumer relies on it being exact.
          const pdf = require("fs").readFileSync(spec.out);
          const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
          return JSON.stringify({ ok: true, pages: Math.max(pages, 1), bytes });
        } catch (err) {
          return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
        }
      },
    };
  }

  onunload() {
    delete window.papersync;
  }
}

module.exports = PapersyncBridge;
