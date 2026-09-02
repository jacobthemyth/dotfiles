-- Setup options that need to be set before loading lazy.nvim
vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

-- Managed by hooks/shared/post-up/vim (uv venv --allow-existing)
vim.g.python3_host_prog = vim.fn.expand("~/.local/share/nvim/venv/bin/python3")

vim.cmd("source ~/.vimrc")

require("config.lazy")

-- Clipboard writes go out over OSC 52 (works identically locally and remotely:
-- yanks travel the escape-sequence channel through tmux/mosh/ghostty to set the
-- macOS clipboard, and with `set-clipboard on` in tmux populate the tmux paste
-- buffer). We ALSO shell out to pbcopy when it exists, so GUI frontends like
-- VimR — which have no terminal to interpret OSC 52 — still update the macOS
-- pasteboard. Both writes carry identical content, so there is no race; on
-- remote hosts without pbcopy the OSC 52 write stands alone.
vim.keymap.set("n", "<leader>%", function()
  vim.fn.setreg("+", vim.fn.expand("%"))
end, { desc = "Copy filename to clipboard" })

local osc52 = require("vim.ui.clipboard.osc52")

local function dual_copy(reg)
  local osc_copy = osc52.copy(reg)
  return function(lines, regtype)
    osc_copy(lines, regtype)
    if vim.fn.executable("pbcopy") == 1 then
      vim.system({ "pbcopy" }, { stdin = table.concat(lines, "\n") })
    end
  end
end

vim.g.clipboard = {
  name = "OSC 52 + pbcopy",
  copy = {
    ["+"] = dual_copy("+"),
    ["*"] = dual_copy("*"),
  },
  paste = {
    ["+"] = osc52.paste("+"),
    ["*"] = osc52.paste("*"),
  },
}
