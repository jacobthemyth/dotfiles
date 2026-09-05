-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = "https://github.com/folke/lazy.nvim.git"
  local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath })
  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
      { out, "WarningMsg" },
      { "\nPress any key to exit..." },
    }, true, {})
    vim.fn.getchar()
    os.exit(1)
  end
end
vim.opt.rtp:prepend(lazypath)

-- Setup lazy.nvim
require("lazy").setup({
  spec = {
    -- import your plugins
    { import = "plugins" },
  },
  -- Configure any other settings here. See the documentation for more details.
  -- automatically check for plugin updates
  checker = {
    enabled = true,
    notify = false,
    frequency = 86400, -- check for updates once a day
  }
})

-- macOS: re-sign native modules after any Lazy op that may rebuild them.
-- A freshly linker-signed .so/.dylib fails macOS's per-page code-sign check
-- and the kernel SIGKILLs nvim on dlopen ("Code Signature Invalid"). The
-- avante/LuaSnip specs re-sign in their own `build`; this catch-all covers
-- what a build tail cannot reach: treesitter/orgmode parsers built via
-- :TSUpdate (an Ex command, no shell to append to) and native deps pulled in
-- transitively (e.g. telescope-fzf-native) that have no spec of their own.
-- nvim-resign is a no-op off macOS, but gate here to avoid a pointless job.
if vim.fn.has("mac") == 1 then
  vim.api.nvim_create_autocmd("User", {
    pattern = { "LazyInstall", "LazyUpdate", "LazySync", "LazyBuild" },
    callback = function()
      vim.fn.jobstart({ vim.fn.expand("~/.local/bin/nvim-resign") }, { detach = true })
    end,
  })
end
