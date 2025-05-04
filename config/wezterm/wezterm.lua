local wezterm = require 'wezterm'

local appearance = require 'appearance'

local config = wezterm.config_builder()

config.term = "wezterm"

config.color_scheme = 'Ocean (base16)'
config.font = wezterm.font({ family = 'Operator Mono SSM', weight = 'Book' })
config.font_size = 16

config.window_decorations = 'RESIZE|INTEGRATED_BUTTONS'
config.window_frame = {
  font = wezterm.font({ family = 'Operator Mono SSM', weight = 'Bold' }),
  font_size = 14,
}

config.set_environment_variables = {
  PATH = '/opt/homebrew/bin:' .. os.getenv('PATH')
}

-- > If you are a heavy user of Vi style editors then you may wish to disable
--   dead key processing so that ^ can be used with a single keypress.
-- -- https://wezfurlong.org/wezterm/config/keyboard-concepts.html#dead-keys
config.use_dead_keys = false

config.keys = {
  {
    key = ',',
    mods = 'SUPER',
    action = wezterm.action.SpawnCommandInNewTab {
      cwd = wezterm.home_dir,
      args = { 'nvim', wezterm.config_file },
    },
  },
}

return config
