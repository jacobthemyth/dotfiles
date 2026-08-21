return {
  "tomfordweb/beads.nvim",
  dependencies = {
    "nvim-telescope/telescope.nvim",
    "nvim-lua/plenary.nvim",
  },
  config = function()
    require("beads").setup({
      keymaps = true,
      -- picker = {
      --   theme_opts = {
      --     layout_strategy = 'horizontal', -- or "vertical"
      --     layout_config = {
      --       width = 0.99,   -- 99% of screen width
      --       height = 0.99,  -- 99% of screen height
      --       preview_cutoff = 1, -- ensure preview stays visible even if slightly smaller
      --     },
      --   }
      -- }
    })
    require("telescope").load_extension("beads")
  end,
}
