local application = require "mjolnir.application"
local hotkey = require "mjolnir.hotkey"
local window = require "mjolnir.window"
local fnutils = require "mjolnir.fnutils"
local grid = require "mjolnir.bg.grid"
local alert = require "mjolnir.alert"

local hyper = {"cmd", "alt", "ctrl", "shift"}
local meta = {"cmd", "alt"}

grid.GRIDHEIGHT = 2
grid.GRIDWIDTH = 6
grid.MARGINX = 5
grid.MARGINY = 5

local snapvisiblewindows = function()
  for i, win in ipairs(window.visiblewindows()) do
    grid.snap(win)
  end
end

local changegridwidth = function(by)
  grid.adjustheight(math.max(1, grid.GRIDWIDTH + by))
  alert.show("grid is now " .. grid.GRIDWIDTH .. " tiles wide", 1)
  snapvisiblewindows()
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
hotkey.bind(hyper, '=', function() changegridwidth(1) end)
hotkey.bind(hyper, '-', function() changegridwidth(-1) end)

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
hotkey.bind(hyper, 'J', function()
  grid.adjust_focused_window(function(cell)
    cell.h = math.ceil(grid.GRIDHEIGHT / 2)
    return cell
  end)
  grid.pushwindow_down()
end)
hotkey.bind(hyper, 'K', function()
  grid.adjust_focused_window(function(cell)
    cell.h = math.ceil(grid.GRIDHEIGHT / 2)
    return cell
  end)
  grid.pushwindow_up()
end)
hotkey.bind(hyper, 'L', grid.pushwindow_right)

hotkey.bind(hyper, 'O', grid.resizewindow_wider)
hotkey.bind(hyper, 'I', grid.resizewindow_thinner)
hotkey.bind(hyper, 'U', grid.resizewindow_taller)
hotkey.bind(hyper, 'Y', grid.resizewindow_shorter)

hotkey.bind(hyper, "left", function() window.focusedwindow():focuswindow_west() end)
hotkey.bind(hyper, "right", function() window.focusedwindow():focuswindow_east() end)
hotkey.bind(hyper, "down", function() window.focusedwindow():focuswindow_south() end)
hotkey.bind(hyper, "up", function() window.focusedwindow():focuswindow_north() end)

hotkey.bind(hyper, "N", grid.pushwindow_nextscreen)
hotkey.bind(hyper, "P", grid.pushwindow_prevscreen)

alert.show("Mjolnir config loaded")
