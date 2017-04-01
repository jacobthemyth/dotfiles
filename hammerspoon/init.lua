local hyper = {"alt", "cmd"}

hs.hotkey.bind("cmd", ".", nil, function()
  os.execute("cd ~/Dropbox/Work; /usr/local/bin/mvim . &")
end)

hs.hotkey.bind(hyper, "left", nil, function()
  local win = hs.window.focusedWindow()
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()

  f.x = max.x
  f.y = max.y
  f.w = max.w / 2
  f.h = max.h
  win:setFrame(f)
end)

hs.hotkey.bind(hyper, "right", nil, function()
  local win = hs.window.focusedWindow()
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()

  f.x = max.x + (max.w / 2)
  f.y = max.y
  f.w = max.w / 2
  f.h = max.h
  win:setFrame(f)
end)

hs.hotkey.bind(hyper, "up", nil, function()
  local win = hs.window.focusedWindow()
  local f = win:frame()
  local screen = win:screen()
  local max = screen:frame()

  f.x = max.x
  f.y = max.y
  f.w = max.w
  f.h = max.h
  win:setFrame(f)
end)

hs.hotkey.bind(hyper, "down", nil, function()
  local win = hs.window.focusedWindow()
  local f = win:frame()
  local screen = win:screen()
  local screenFrame = screen:frame()

  f.w = screenFrame.w / 2
  f.h = screenFrame.h
  f.x = screenFrame.x + ((screenFrame.w - f.w) / 2)
  f.y = screenFrame.y + ((screenFrame.h - f.h) / 2)
  win:setFrame(f)
end)

hs.hotkey.bind(hyper, "]", nil, function()
  local win = hs.window.focusedWindow()
  local f = win:frame()
  local screen = win:screen()
  local screenFrame = screen:frame()

  f.w = 800
  f.h = 600
  f.x = screenFrame.x + ((screenFrame.w - f.w) / 2)
  f.y = 0
  win:setFrame(f)
end)
