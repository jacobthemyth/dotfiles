local function sendKeyCode(key, modifiers, isdown)
  modifiers = modifiers or {}

  return function()
      hs.eventtap.event.newKeyEvent(modifiers, string.lower(key), isdown):post()
  end
end

emacsBinds = {
  hs.hotkey.new({'ctrl'},          'n', sendKeyCode('down',  nil,       true), nil, sendKeyCode('down',  nil,       false)),
  hs.hotkey.new({'ctrl'},          'p', sendKeyCode('up',    nil,       true), nil, sendKeyCode('up',    nil,       false)),
  hs.hotkey.new({'ctrl'},          'b', sendKeyCode('left',  nil,       true), nil, sendKeyCode('left',  nil,       false)),
  hs.hotkey.new({'ctrl'},          'f', sendKeyCode('right', nil,       true), nil, sendKeyCode('right', nil,       false)),
  hs.hotkey.new({'ctrl', 'shift'}, 'n', sendKeyCode('down',  {'shift'}, true), nil, sendKeyCode('down',  {'shift'}, false)),
  hs.hotkey.new({'ctrl', 'shift'}, 'p', sendKeyCode('up',    {'shift'}, true), nil, sendKeyCode('up',    {'shift'}, false)),
  hs.hotkey.new({'ctrl', 'shift'}, 'b', sendKeyCode('left',  {'shift'}, true), nil, sendKeyCode('left',  {'shift'}, false)),
  hs.hotkey.new({'ctrl', 'shift'}, 'f', sendKeyCode('right', {'shift'}, true), nil, sendKeyCode('right', {'shift'}, false))
}

function enableBinds()
  for k, v in pairs(emacsBinds) do
    v:enable()
  end
end

function disableBinds()
  for k, v in pairs(emacsBinds) do
    v:disable()
  end
end

local wf = hs.window.filter
local apps = {'Things'}

for k, v in pairs(apps) do
  awf = wf.new{v}
  awf:subscribe(wf.windowFocused, enableBinds)
  awf:subscribe(wf.windowUnfocused, disableBinds)
end
