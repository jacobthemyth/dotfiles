return {
  "nvim-treesitter/nvim-treesitter",
  config = function()
    vim.cmd "TSUpdate"
    local configs = require("nvim-treesitter.configs")

    configs.setup({
      ensure_installed = {
        "c",
        "go",
        "lua",
        "ruby",
        "vim",
        "vimdoc",
      },
      sync_install = false,
      highlight = { enable = true },
      indent = { enable = true },
    })
  end
}
