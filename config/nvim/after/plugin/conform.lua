require("conform").setup({
  formatters_by_ft = {
    go = { "gofmt" },
    ["*"] = { "trim_whitespace" },
  },
  format_on_save = {
    timeout_ms = 500,
    lsp_fallback = true,
  },
})
