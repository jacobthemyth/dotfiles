-- A global variable for the Hyper Mode
-- The key is irrelevant, it is only used to store state
local hyper = hs.hotkey.modal.new({}, "F20")

local CAPS = {
  keycode = 57,
  isEnabled = 65792,
  isDisabled = 256
}

trap_caps_lock = hs.eventtap.new({hs.eventtap.event.types.flagsChanged}, function(evt)
  if evt:getKeyCode() == CAPS.keycode then
    if evt:getRawEventData()["NSEventData"]["modifierFlags"] == CAPS.isEnabled then
      hyper:enter()
    else
      hyper:exit()
    end
  end
end)
trap_caps_lock:start()

return hyper
