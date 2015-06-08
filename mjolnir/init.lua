local application = require "mjolnir.application"
local hotkey = require "mjolnir.hotkey"
local window = require "mjolnir.window"
local fnutils = require "mjolnir.fnutils"
local grid = require "mjolnir.bg.grid"
local alert = require "mjolnir.alert"

local hyper = {"cmd", "ctrl", "shift", "alt"}
local meta = {"ctrl", "shift", "alt"}

grid.GRIDHEIGHT = 4
grid.GRIDWIDTH = 10
grid.MARGINX = 5
grid.MARGINY = 5

local snapvisiblewindows = function()
  for i, win in ipairs(window.visiblewindows()) do
    grid.snap(win)
  end
end

local setcurrentwindow = function(x, y, w, h)
  cur_window = window.focusedwindow()
  grid.set(
      cur_window,
      {x=x, y=y, w=w, h=h},
      cur_window:screen()
  )
end

hotkey.bind(meta, 'r', mjolnir.reload)
hotkey.bind(meta, '`', mjolnir.openconsole)

-- grid
hotkey.bind(meta, ';', function() grid.snap(window.focusedwindow()) end)
hotkey.bind(meta, "'", snapvisiblewindows)

-- Push the window into the exact center of the screen
hotkey.bind(meta, '0', function()
  frame = window.focusedwindow():screen():frame()
  frame.x = (frame.w / 2) - (frame.w / 4)
  frame.y = 0
  frame.w = frame.w / 2
  frame.h = frame.h
  window.focusedwindow():setframe(frame)
end)

hotkey.bind(meta, ']', function()
  x = math.floor(grid.GRIDWIDTH / 2)
  w = math.floor(grid.GRIDWIDTH / 2)
  setcurrentwindow(x, 0, w, grid.GRIDHEIGHT)
end)

hotkey.bind(meta, '[', function()
  w = math.floor(grid.GRIDWIDTH / 2)
  setcurrentwindow(0, 0, w, grid.GRIDHEIGHT)
end)

hotkey.bind(meta, 'M', function()
  setcurrentwindow(0, 0, grid.GRIDWIDTH, grid.GRIDHEIGHT)
end)

hotkey.bind(meta, 'H', grid.pushwindow_left)
hotkey.bind(meta, 'J', grid.pushwindow_down)
hotkey.bind(meta, 'K', grid.pushwindow_up)
hotkey.bind(meta, 'L', grid.pushwindow_right)

-- < decrease current window width --
hotkey.bind(meta, ',', grid.resizewindow_thinner)
-- > increase current window width --
hotkey.bind(meta, '.', grid.resizewindow_wider)
-- + increase current window height --
hotkey.bind(meta, '=', grid.resizewindow_taller)
-- - decrease current window height --
hotkey.bind(meta, '-', grid.resizewindow_shorter)

hotkey.bind(hyper, 'H', function() window.focusedwindow():focuswindow_west() end)
hotkey.bind(hyper, 'J', function() window.focusedwindow():focuswindow_south() end)
hotkey.bind(hyper, 'K', function() window.focusedwindow():focuswindow_north() end)
hotkey.bind(hyper, 'L', function() window.focusedwindow():focuswindow_east() end)

hotkey.bind(meta, "N", grid.pushwindow_nextscreen)
hotkey.bind(meta, "P", grid.pushwindow_prevscreen)

alert.show("Mjolnir config loaded")
