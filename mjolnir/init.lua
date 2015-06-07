local application = require "mjolnir.application"
local hotkey = require "mjolnir.hotkey"
local window = require "mjolnir.window"
local fnutils = require "mjolnir.fnutils"
local grid = require "mjolnir.bg.grid"
local alert = require "mjolnir.alert"

local hyper = {"ctrl", "shift", "alt"}
local meta = {"cmd", "alt"}

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

hotkey.bind(hyper, 'r', mjolnir.reload)
hotkey.bind(hyper, '`', mjolnir.openconsole)

-- grid
hotkey.bind(hyper, ';', function() grid.snap(window.focusedwindow()) end)
hotkey.bind(hyper, "'", snapvisiblewindows)

-- Push the window into the exact center of the screen
hotkey.bind(hyper, '0', function()
  frame = window.focusedwindow():screen():frame()
  frame.x = (frame.w / 2) - (frame.w / 4)
  frame.y = 0
  frame.w = frame.w / 2
  frame.h = frame.h
  window.focusedwindow():setframe(frame)
end)

hotkey.bind(hyper, ']', function()
  x = math.floor(grid.GRIDWIDTH / 2)
  w = math.floor(grid.GRIDWIDTH / 2)
  setcurrentwindow(x, 0, w, grid.GRIDHEIGHT)
end)

hotkey.bind(hyper, '[', function()
  w = math.floor(grid.GRIDWIDTH / 2)
  setcurrentwindow(0, 0, w, grid.GRIDHEIGHT)
end)

hotkey.bind(hyper, 'M', function()
  setcurrentwindow(0, 0, grid.GRIDWIDTH, grid.GRIDHEIGHT)
end)

hotkey.bind(hyper, 'H', grid.pushwindow_left)
hotkey.bind(hyper, 'J', grid.pushwindow_down)
hotkey.bind(hyper, 'K', grid.pushwindow_up)
hotkey.bind(hyper, 'L', grid.pushwindow_right)

-- < decrease current window width --
hotkey.bind(hyper, ',', grid.resizewindow_thinner)
-- > increase current window width --
hotkey.bind(hyper, '.', grid.resizewindow_wider)
-- + increase current window height --
hotkey.bind(hyper, '=', grid.resizewindow_taller)
-- - decrease current window height --
hotkey.bind(hyper, '-', grid.resizewindow_shorter)

hotkey.bind(meta, 'H', function() window.focusedwindow():focuswindow_west() end)
hotkey.bind(meta, 'J', function() window.focusedwindow():focuswindow_south() end)
hotkey.bind(meta, 'K', function() window.focusedwindow():focuswindow_north() end)
hotkey.bind(meta, 'L', function() window.focusedwindow():focuswindow_east() end)

hotkey.bind(hyper, "N", grid.pushwindow_nextscreen)
hotkey.bind(hyper, "P", grid.pushwindow_prevscreen)

alert.show("Mjolnir config loaded")
