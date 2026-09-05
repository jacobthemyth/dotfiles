return {
  "L3MON4D3/LuaSnip",
  -- nvim-resign re-signs the built jsregexp native module so macOS does not
  -- SIGKILL nvim on dlopen ("Code Signature Invalid"); no-op off macOS.
  build = "make install_jsregexp && nvim-resign .",
  dependencies = { "rafamadriz/friendly-snippets" },
  config = function()
    require("luasnip.loaders.from_vscode").lazy_load()
  end
}
