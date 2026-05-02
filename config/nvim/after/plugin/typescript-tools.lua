require("typescript-tools").setup({
  on_attach = function(client, bufnr)
    -- Let conform.nvim handle formatting
    client.server_capabilities.documentFormattingProvider = false
    client.server_capabilities.documentRangeFormattingProvider = false
  end,
  settings = {
    separate_diagnostic_server = true,
    publish_diagnostic_on = "insert_leave",
    disable_member_code_lens = true,
  },
})
