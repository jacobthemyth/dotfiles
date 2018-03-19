require('emacs')

local hyper = {"ctrl", "shift", "alt", "cmd"}

hs.hotkey.bind(hyper, "r", nil, function()
  hs.reload()
end)

hs.hotkey.bind(hyper, "n", nil, function()
  os.execute("cd ~/Dropbox/Notes; /usr/local/bin/vimr . &")
end)
