return {
  'MeanderingProgrammer/render-markdown.nvim',
  dependencies = { 'nvim-treesitter/nvim-treesitter', 'nvim-tree/nvim-web-devicons' },
  ft = { "markdown", "Avante" },
  opts = {
    file_types = { "markdown", "Avante" },

    -- Disable sign column (gutter symbols)
    sign = {
      enabled = false,
    },

    code = {
      enabled = true,
      conceal_delimiters = false,
      border = 'thick',
      position = 'right',
      width = 'block',
      right_pad = 10,
    },

    link = {
      enabled = false,
    },
  },
}
