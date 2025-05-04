return {
  "folke/which-key.nvim",
  event = "VeryLazy",
  opts = {
    triggers = { "<leader>", mode = "nxso" },
  },
  keys = {
    {
      "<leader>?",
      function()
        require("which-key").show({ global = false })
      end,
      desc = "Buffer Local Keymaps (which-key)",
    },
  },
}
